/**
 * The reader's rules, proven one at a time.
 *
 * `fetch` is injected here instead of a real server, and that is the point: what
 * these tests check is DECISION, not transport. "One renewal after 401" and
 * "no retry after 403" are rules about what the client does with an answer, and
 * a real server would make them harder to trigger and no more convincing.
 *
 * End-to-end against the real door lives in `test/navegador.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createAgoraReader, type Credentials } from '../src/agora.ts'

const URL_BASE = 'https://retick.exemplo.dev'

function snapshot(cursor: number, reinicio = false): Record<string, unknown> {
  return {
    navegador: 1,
    versao: 'agora/v2',
    cursor,
    emitidaEm: new Date().toISOString(),
    reinicio,
    escopo: { projeto: 'exo', fontes: ['exo'] },
    agora: { contadores: { foco: 1 } },
  }
}

function resposta(codigo: number, corpo?: unknown): Response {
  return new Response(corpo === undefined ? null : JSON.stringify(corpo), { status: codigo })
}

/** A stream that emits the given lines and then ends. */
function streamDe(linhas: unknown[]): Response {
  const texto = linhas.map((l) => `${JSON.stringify(l)}\n`).join('')
  return new Response(new TextEncoder().encode(texto), {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

type Registro = { url: string; metodo: string; autorizacao: string | null }

function espiao(respostas: Array<(r: Registro) => Response>) {
  const chamadas: Registro[] = []
  let i = 0
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers)
    const r: Registro = {
      url: String(url),
      metodo: (init?.method ?? 'GET').toUpperCase(),
      autorizacao: h.get('authorization'),
    }
    chamadas.push(r)
    const fn = respostas[Math.min(i, respostas.length - 1)]!
    i += 1
    return fn(r)
  }) as unknown as typeof fetch
  return { chamadas, fetchImpl }
}

const credencial = (token: string): Credentials => ({
  token,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
})

/**
 * Consecutive repeats of the same cursor are dropped before asserting.
 *
 * The reader re-announces the LAST projection whenever freshness changes — the
 * stream ending turns `live` into `offline`, and the Mesa has to hear that. So
 * a subscriber legitimately sees the same cursor twice with different status.
 * What these tests are measuring is ORDER, and a repeat says nothing about it;
 * an out-of-order frame that got applied would still show up here, between its
 * neighbours.
 */
function semRepetidos(cursores: number[]): number[] {
  return cursores.filter((c, i) => i === 0 || c !== cursores[i - 1])
}

// ── the token never leaves the header ────────────────────────────────────────

test('the token travels in the header and never in the URL', async () => {
  const { chamadas, fetchImpl } = espiao([() => resposta(200, snapshot(1))])
  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => credencial('rtv_aaaaaaaaaaaa_segredo'),
    fetchImpl,
  })
  await leitor.snapshot()
  leitor.close()

  assert.equal(chamadas[0]!.autorizacao, 'Bearer rtv_aaaaaaaaaaaa_segredo')
  for (const c of chamadas) {
    assert.ok(!c.url.includes('rtv_'), `token leaked into the URL: ${c.url}`)
    assert.ok(!/[?&](token|access_token)=/.test(c.url))
  }
})

// ── 401: exactly one renewal ─────────────────────────────────────────────────

test('a 401 renews the credential once, and the retry carries the new one', async () => {
  let emitidas = 0
  const { chamadas, fetchImpl } = espiao([
    () => resposta(401, { erro: 'credencial recusada' }),
    () => resposta(200, snapshot(1)),
  ])
  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => {
      emitidas += 1
      return credencial(`rtv_token_${emitidas}`)
    },
    fetchImpl,
  })

  const s = await leitor.snapshot()
  leitor.close()

  assert.equal(s.cursor, 1)
  assert.equal(emitidas, 2, 'exactly two credentials: the first and one renewal')
  assert.equal(chamadas[0]!.autorizacao, 'Bearer rtv_token_1')
  assert.equal(chamadas[1]!.autorizacao, 'Bearer rtv_token_2')
})

test('two 401s in a row stop the reader instead of looping', async () => {
  /*
   * THIS IS THE TEST THAT KEEPS A CLIENT FROM BECOMING AN ATTACK.
   *
   * A reader that renews on every 401 and retries forever is a brute-force loop
   * against a dead session — polite in intent, indistinguishable in effect. The
   * count is the assertion: two requests, two credentials, and then it stops.
   */
  let emitidas = 0
  const { chamadas, fetchImpl } = espiao([() => resposta(401)])
  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => {
      emitidas += 1
      return credencial(`rtv_token_${emitidas}`)
    },
    fetchImpl,
  })

  await assert.rejects(() => leitor.snapshot())
  // Read the status BEFORE closing: `close` resets it to `idle` on purpose,
  // so asserting after it would measure the close and not the rule.
  assert.equal(leitor.freshness().status, 'unauthorized')
  leitor.close()

  assert.equal(chamadas.length, 2)
  assert.equal(emitidas, 2)
})

// ── 403: stop, with no retry at all ──────────────────────────────────────────

test('a 403 stops the reader: no renewal, no retry, no backoff', async () => {
  let emitidas = 0
  const { chamadas, fetchImpl } = espiao([() => resposta(403)])
  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => {
      emitidas += 1
      return credencial('rtv_token')
    },
    fetchImpl,
  })

  await assert.rejects(() => leitor.snapshot())
  // Give a loop, if one existed, time to show itself.
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(leitor.freshness().status, 'forbidden')
  assert.equal(leitor.freshness().reason, 'sem permissao')
  leitor.close()

  assert.equal(chamadas.length, 1, 'a 403 must not be retried')
  assert.equal(emitidas, 1, 'a 403 must not trigger a renewal')
})

// ── 429 and 5xx: back off, keep what we had ──────────────────────────────────

test('a 429 marks the reason without discarding the last snapshot', async () => {
  const { fetchImpl } = espiao([
    () => resposta(200, snapshot(1)),
    () => streamDe([]),
    () => resposta(429),
  ])
  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => credencial('rtv_token'),
    minIntervalMs: 0,
    fetchImpl,
  })

  await leitor.snapshot()
  await leitor.refresh()
  const f = leitor.freshness()
  leitor.close()

  assert.equal(f.status, 'stale')
  assert.equal(f.reason, 'limite de taxa')
  // The tab keeps showing what it had, with a visible age.
  assert.ok((f.ageSeconds ?? -1) >= 0)
})

// ── the stream: order, replay, reconnection ──────────────────────────────────

test('the stream applies increasing cursors and ignores ones it already passed', async () => {
  const recebidos: number[] = []
  const { fetchImpl } = espiao([
    () => resposta(200, snapshot(5)),
    // Out of order on purpose: 4 arrives after 5 and must be dropped.
    () => streamDe([snapshot(6), snapshot(4), snapshot(7)]),
    () => streamDe([]),
  ])
  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => credencial('rtv_token'),
    // Backoff above the test window: reconnection re-announces the same
    // snapshot (the freshness changed), and that would add noise to a count
    // that is measuring order.
    maxBackoffMs: 5_000,
    fetchImpl,
  })

  leitor.subscribe((s) => recebidos.push(s.cursor))
  await leitor.snapshot()
  await new Promise((r) => setTimeout(r, 150))
  leitor.close()

  assert.deepEqual(semRepetidos(recebidos), [5, 6, 7])
})

test('reconnection resumes from the cursor it had', async () => {
  const urls: string[] = []
  const { fetchImpl } = espiao([
    (r) => {
      urls.push(r.url)
      return resposta(200, snapshot(3))
    },
    (r) => {
      urls.push(r.url)
      return streamDe([snapshot(4)])
    },
    (r) => {
      urls.push(r.url)
      return streamDe([])
    },
  ])
  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => credencial('rtv_token'),
    maxBackoffMs: 20,
    fetchImpl,
  })

  await leitor.snapshot()
  await new Promise((r) => setTimeout(r, 200))
  leitor.close()

  // The first stream resumes from 3 (what the snapshot gave), the second from
  // 4 (what the stream delivered). Neither one starts over.
  assert.ok(urls[1]!.includes('desde=3'), urls[1])
  assert.ok(urls[2]!.includes('desde=4'), urls[2])
})

test('a snapshot marked `reinicio` replaces, and is applied even with a lower cursor', async () => {
  const recebidos: number[] = []
  const { fetchImpl } = espiao([
    () => resposta(200, snapshot(10)),
    // The service reconstructed and restarted numbering. Without honouring
    // `reinicio`, the reader would sit on cursor 10 forever and go silent.
    () => streamDe([snapshot(1, true), snapshot(2)]),
    () => streamDe([]),
  ])
  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => credencial('rtv_token'),
    // Backoff above the test window: reconnection re-announces the same
    // snapshot (the freshness changed), and that would add noise to a count
    // that is measuring order.
    maxBackoffMs: 5_000,
    fetchImpl,
  })

  leitor.subscribe((s) => recebidos.push(s.cursor))
  await leitor.snapshot()
  await new Promise((r) => setTimeout(r, 150))
  leitor.close()

  assert.deepEqual(semRepetidos(recebidos), [10, 1, 2])
})

test('a heartbeat refreshes contact without producing a frame', async () => {
  const recebidos: number[] = []
  const { fetchImpl } = espiao([
    () => resposta(200, snapshot(1)),
    () => streamDe([{ tipo: 'batimento', em: new Date().toISOString() }]),
    () => streamDe([]),
  ])
  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => credencial('rtv_token'),
    // Backoff above the test window: reconnection re-announces the same
    // snapshot (the freshness changed), and that would add noise to a count
    // that is measuring order.
    maxBackoffMs: 5_000,
    fetchImpl,
  })

  leitor.subscribe((s) => recebidos.push(s.cursor))
  await leitor.snapshot()
  await new Promise((r) => setTimeout(r, 120))
  leitor.close()

  assert.deepEqual(semRepetidos(recebidos), [1], 'a heartbeat is not a projection')
  assert.ok(leitor.freshness().lastContactAt)
})

// ── offline ──────────────────────────────────────────────────────────────────

test('a network failure goes `offline` and keeps the last snapshot with a growing age', async () => {
  let falhar = false
  const fetchImpl = (async (url: string | URL | Request) => {
    if (falhar) throw new TypeError('network')
    if (String(url).includes('/stream')) return streamDe([])
    return resposta(200, snapshot(1))
  }) as unknown as typeof fetch

  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => credencial('rtv_token'),
    minIntervalMs: 0,
    maxBackoffMs: 20,
    fetchImpl,
  })

  const s = await leitor.snapshot()
  falhar = true
  await leitor.refresh()
  const f = leitor.freshness()
  leitor.close()

  assert.equal(f.status, 'offline')
  assert.equal(f.reason, 'rede')
  // The data is still there, and it is marked. Without the mark the consumer
  // cannot tell stale from current.
  assert.equal(s.cursor, 1)
  assert.ok((f.ageSeconds ?? -1) >= 0)
})

// ── the freshness floor ──────────────────────────────────────────────────────

test('refresh respects the floor, so a tab in a loop stops itself', async () => {
  const { chamadas, fetchImpl } = espiao([
    () => resposta(200, snapshot(1)),
    () => streamDe([]),
    () => resposta(200, snapshot(2)),
  ])
  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => credencial('rtv_token'),
    minIntervalMs: 10_000,
    maxBackoffMs: 20,
    fetchImpl,
  })

  await leitor.snapshot()
  const antes = chamadas.length
  for (let i = 0; i < 20; i += 1) await leitor.refresh()
  const depois = chamadas.filter((c) => !c.url.includes('/stream')).length
  leitor.close()

  assert.equal(depois, 1, `twenty refreshes became ${depois} requests`)
  assert.ok(antes >= 1)
})

// ── close ────────────────────────────────────────────────────────────────────

test('close stops everything and keeps nothing', async () => {
  const { chamadas, fetchImpl } = espiao([
    () => resposta(200, snapshot(1)),
    () => streamDe([]),
  ])
  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => credencial('rtv_token'),
    maxBackoffMs: 10,
    fetchImpl,
  })

  await leitor.snapshot()
  leitor.close()
  const quantas = chamadas.length
  await new Promise((r) => setTimeout(r, 120))

  assert.equal(chamadas.length, quantas, 'a closed reader must not reconnect')
  assert.equal(leitor.freshness().status, 'idle')
})

// ── revoke: the explicit end ─────────────────────────────────────────────────

/*
 * WHAT THESE TESTS ARE ABOUT.
 *
 * `close` and `revoke` differ in one observable way — whether a `DELETE`
 * leaves the process — and every test below is a count of requests. That is on
 * purpose: "the session was ended at the service" is not a state this file can
 * read, so the only honest assertion here is what went out on the wire. The
 * end being PERSISTED is proven against the real door, in
 * `test/navegador.test.ts`.
 */

test('revoke sends DELETE to the session route, with the token in the header', async () => {
  const { chamadas, fetchImpl } = espiao([
    () => resposta(200, snapshot(1)),
    () => streamDe([]),
    () => resposta(204),
  ])
  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => credencial('rtv_aaaaaaaaaaaa_segredo'),
    fetchImpl,
  })

  await leitor.snapshot()
  const r = await leitor.revoke()

  assert.equal(r, 'revoked')
  const saida = chamadas.filter((c) => c.metodo === 'DELETE')
  assert.equal(saida.length, 1)
  assert.equal(saida[0]!.url, `${URL_BASE}/api/navegador/v1/sessao`)
  assert.equal(saida[0]!.autorizacao, 'Bearer rtv_aaaaaaaaaaaa_segredo')
  // The rule from the top of the file holds on the way out too: a teardown
  // path is exactly where someone would be tempted to "just" append the token.
  for (const c of chamadas) {
    assert.ok(!c.url.includes('rtv_'), `token leaked into the URL: ${c.url}`)
    assert.ok(!/[?&](token|access_token)=/.test(c.url))
  }
})

test('close does NOT revoke, and that is the difference between the two', async () => {
  /*
   * THE TEST THAT PROTECTS A SESSION FROM ITS OWN HOST.
   *
   * A route change unmounts the Mesa. If unmounting revoked, clicking from the
   * Mesa to Detail and back would burn a session per click, and the person who
   * never logged out would see their tab reconnect for reasons nobody typed.
   */
  const { chamadas, fetchImpl } = espiao([
    () => resposta(200, snapshot(1)),
    () => streamDe([]),
  ])
  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => credencial('rtv_token'),
    maxBackoffMs: 10,
    fetchImpl,
  })

  await leitor.snapshot()
  leitor.close()
  await new Promise((r) => setTimeout(r, 120))

  assert.equal(chamadas.filter((c) => c.metodo === 'DELETE').length, 0)
})

test('revoke is idempotent: at most one DELETE leaves a reader, ever', async () => {
  const { chamadas, fetchImpl } = espiao([
    () => resposta(200, snapshot(1)),
    () => streamDe([]),
    () => resposta(204),
  ])
  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => credencial('rtv_token'),
    fetchImpl,
  })

  await leitor.snapshot()
  const primeiro = await leitor.revoke()
  const segundo = await leitor.revoke()
  const terceiro = await leitor.revoke()

  assert.equal(chamadas.filter((c) => c.metodo === 'DELETE').length, 1)
  assert.equal(primeiro, 'revoked')
  // The repeats report what the first call found, and not `nothing-to-revoke`:
  // a caller wiring this into both a logout handler and an unmount path must
  // not be told the session was never there.
  assert.equal(segundo, 'revoked')
  assert.equal(terceiro, 'revoked')
})

test('two revokes racing share one request and one answer', async () => {
  let soltar: (() => void) | null = null
  const espera = new Promise<void>((r) => {
    soltar = r
  })
  const chamadas: string[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const metodo = (init?.method ?? 'GET').toUpperCase()
    chamadas.push(metodo)
    if (metodo === 'DELETE') {
      await espera
      return resposta(204)
    }
    return String(url).includes('/stream') ? streamDe([]) : resposta(200, snapshot(1))
  }) as unknown as typeof fetch

  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => credencial('rtv_token'),
    fetchImpl,
  })
  await leitor.snapshot()

  const a = leitor.revoke()
  const b = leitor.revoke()
  soltar!()
  const [ra, rb] = await Promise.all([a, b])

  assert.equal(chamadas.filter((m) => m === 'DELETE').length, 1)
  assert.equal(ra, 'revoked')
  assert.equal(rb, 'revoked')
})

test('revoke never mints a credential, and says so when there is none', async () => {
  /*
   * THE RULE THIS FILE'S HEADER STATES, MADE ENFORCEABLE.
   *
   * A teardown that could ask the host for a credential would be a teardown
   * that opens a session in the middle of a logout — and the host's supplier
   * is, in the Exo, a route that reads the login cookie. The count of calls to
   * `credentials` is the assertion.
   */
  let pedidas = 0
  const { chamadas, fetchImpl } = espiao([() => resposta(204)])
  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => {
      pedidas += 1
      return credencial('rtv_token')
    },
    fetchImpl,
  })

  const r = await leitor.revoke()

  assert.equal(r, 'nothing-to-revoke')
  assert.equal(pedidas, 0, 'revoke asked the host for a credential')
  assert.equal(chamadas.length, 0, 'revoke sent a request with nothing to send')
})

test('a 401 on the way out means already-closed, not a failure', async () => {
  const { fetchImpl } = espiao([
    () => resposta(200, snapshot(1)),
    () => streamDe([]),
    () => resposta(401, { erro: 'credencial recusada', motivo: 'encerrada' }),
  ])
  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => credencial('rtv_token'),
    fetchImpl,
  })

  await leitor.snapshot()
  // Another tab got there first, or the clock did. Either way the session is
  // over, which is what was asked for.
  assert.equal(await leitor.revoke(), 'already-closed')
})

test('a 403 on the way out is refused, and still forgets the credential', async () => {
  const { fetchImpl } = espiao([
    () => resposta(200, snapshot(1)),
    () => streamDe([]),
    () => resposta(403, { erro: 'origem recusada' }),
  ])
  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => credencial('rtv_token'),
    fetchImpl,
  })

  await leitor.snapshot()
  assert.equal(await leitor.revoke(), 'refused')
  assert.equal(leitor.freshness().status, 'idle')
})

test('a dead network does not throw, and does not hold the caller', async () => {
  /*
   * THE PROMISE THE HOST DEPENDS ON: logout does not fail because Retick is
   * down. This resolves to a value — there is nothing for a `catch` to catch,
   * because a `try` someone forgets to write is how a dead service starts
   * keeping people logged in.
   */
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') {
      throw new TypeError('Failed to fetch')
    }
    return resposta(200, snapshot(1))
  }) as unknown as typeof fetch

  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => credencial('rtv_token'),
    fetchImpl,
  })
  await leitor.snapshot()

  assert.equal(await leitor.revoke(), 'unreachable')
  assert.equal(leitor.freshness().status, 'idle')
})

test('a service that never answers loses the reader on the budget, not on the signal', async () => {
  /*
   * The timeout is enforced twice, and this proves the second one. This
   * `fetchImpl` IGNORES its abort signal — like a polyfill, an interceptor, or
   * a service worker that someone installed between the Mesa and the wire. If
   * only the signal held the budget, this test would hang forever, and so
   * would a logout.
   */
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') {
      return new Promise<Response>(() => {})
    }
    return resposta(200, snapshot(1))
  }) as unknown as typeof fetch

  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => credencial('rtv_token'),
    revokeTimeoutMs: 40,
    fetchImpl,
  })
  await leitor.snapshot()

  const comecou = Date.now()
  const r = await leitor.revoke()
  const levou = Date.now() - comecou

  assert.equal(r, 'unreachable')
  assert.ok(levou < 1_000, `revoke held the caller for ${levou}ms`)
})

test('a revoked reader does not come back: no reconnect, no refresh, no snapshot', async () => {
  const { chamadas, fetchImpl } = espiao([
    () => resposta(200, snapshot(1)),
    () => streamDe([]),
    () => resposta(204),
    () => resposta(200, snapshot(9)),
  ])
  const leitor = createAgoraReader({
    url: URL_BASE,
    credentials: async () => credencial('rtv_token'),
    minIntervalMs: 0,
    maxBackoffMs: 10,
    fetchImpl,
  })

  await leitor.snapshot()
  await leitor.revoke()
  const depoisDaSaida = chamadas.length

  await leitor.refresh()
  await leitor.snapshot().catch(() => null)
  await new Promise((r) => setTimeout(r, 120))

  assert.equal(chamadas.length, depoisDaSaida, 'a revoked reader spoke again')
  assert.equal(leitor.freshness().status, 'idle')
})
