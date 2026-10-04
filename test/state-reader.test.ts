/**
 * `createStateReader`, one rule at a time (browser contract §4, §11).
 *
 * `fetch` is injected: these tests check what the reader DECIDES with each
 * answer. The end-to-end case against the real A-1 routes is
 * `test/browser-state-sdk.test.ts` at the repository root.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createStateReader, STATE_ROUTES, type StateSnapshot, type StateFreshness } from '../src/state.ts'
import type { Credentials } from '../src/agora.ts'
import { RetickConfigError, RetickError } from '../src/errors.ts'

const BASE_URL = 'https://retick.example'
const KEY = 'rt_0123456789ab_abcdefghijklmnopqrstuvwxyz'

/** A view whose opaque cursor is `v<n>` (the server's is a digest; only equality matters). */
function view(n: number, o: { restart?: boolean; sources?: string[]; issuedAt?: string; value?: unknown; cursor?: string | number } = {}): StateSnapshot {
  const sources = o.sources ?? ['party-1', 'user-a']
  const cursor = n
  return {
    version: 'state/v1',
    cursor: (o.cursor ?? `v${n}`) as string,
    issuedAt: o.issuedAt ?? new Date().toISOString(),
    restart: o.restart ?? false,
    scope: { project: 'prj_test', sources, allSources: false },
    state: {
      entities: { vote: { 'm-1': { fields: { value: o.value ?? cursor }, provenance: {}, observedAt: '2026-10-03T12:00:00.000Z' } } },
      sources: Object.fromEntries(sources.map((s) => [s, { applied: cursor, held: 0, contiguousVersion: cursor, lastObservedAt: null }])),
    },
  }
}

const json = (code: number, body?: unknown, headers: Record<string, string> = {}): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status: code, headers })

/** A stream that emits the lines and stays open until aborted, or ends if `end` is true. */
function ndjson(lines: unknown[], signal?: AbortSignal | null, end = false): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(l)}\n`))
      if (end) controller.close()
      else signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

type Call = { url: string; path: string; search: string; method: string; auth: string | null; credentials?: RequestCredentials }

function service(handler: (c: Call, signal?: AbortSignal | null) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url))
    const c: Call = {
      url: String(url),
      path: u.pathname,
      search: u.search,
      method: (init?.method ?? 'GET').toUpperCase(),
      auth: new Headers(init?.headers).get('authorization'),
      credentials: init?.credentials,
    }
    calls.push(c)
    return handler(c, init?.signal)
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const settle = () => new Promise<void>((r) => setImmediate(r))
const cred = (token: string, ms = 600_000): Credentials => ({ token, expiresAt: new Date(Date.now() + ms).toISOString() })

/** Waits for an event. The budget is generous on purpose: it bounds a hang, it does not measure anything. */
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.fail(`timed out waiting for: ${label}`)
}

test('snapshot: state/v1 as served, token in the header only, no cookies', async (t) => {
  const svc = service((c, signal) => (c.path === STATE_ROUTES.snapshot ? json(200, view(3)) : ndjson([], signal)))
  const reader = createStateReader({ url: `${BASE_URL}/`, credentials: async () => cred('rtv_aaa'), fetchImpl: svc.fetchImpl })
  t.after(() => reader.close())

  const s = await reader.snapshot()
  assert.equal(s.version, 'state/v1')
  assert.deepEqual(s.scope, { project: 'prj_test', sources: ['party-1', 'user-a'], allSources: false })
  assert.equal(s.state.entities.vote?.['m-1']?.fields.value, 3)
  assert.equal(svc.calls[0]!.url, `${BASE_URL}${STATE_ROUTES.snapshot}`)
  assert.equal(svc.calls[0]!.auth, 'Bearer rtv_aaa')
  assert.equal(svc.calls[0]!.credentials, 'omit')
  await settle()
  for (const c of svc.calls) assert.ok(!c.url.includes('rtv_aaa'), `token in a URL: ${c.url}`)
})

test('stream: every line replaces the view, the same view is not announced twice, a restart replaces', async (t) => {
  // Cursors are compared for equality only: there is no "older" to drop.
  const seen: string[] = []
  const svc = service((c, signal) =>
    c.path === STATE_ROUTES.snapshot
      ? json(200, view(5))
      : ndjson([view(6), view(6), { type: 'heartbeat', at: new Date().toISOString() }, view(2, { restart: true }), view(3)], signal),
  )
  const reader = createStateReader({ url: BASE_URL, credentials: async () => cred('rtv_aaa'), fetchImpl: svc.fetchImpl })
  t.after(() => reader.close())
  reader.subscribe((s) => seen.push(s.cursor))
  await reader.snapshot()
  await until(() => seen.includes('v3'), 'cursor v3')
  // Status changes re-announce the current view, so consecutive repeats are folded.
  assert.deepEqual(seen.filter((c, i) => i === 0 || c !== seen[i - 1]), ['v5', 'v6', 'v2', 'v3'])
  assert.equal(seen.filter((c) => c === 'v6').length, 1, 'the identical view v6 was not announced again')
  assert.equal(reader.freshness().status, 'live')
})

test('a snapshot overtaken by a stream line while in flight does not replace the newer view', async (t) => {
  let streamPush!: (o: unknown) => void
  let releaseSnapshot!: () => void
  const held = new Promise<void>((r) => (releaseSnapshot = r))
  let snapshots = 0
  const svc = service(async (c, signal) => {
    if (c.path === STATE_ROUTES.snapshot) {
      snapshots += 1
      if (snapshots === 1) return json(200, view(1))
      await held
      return json(200, view(1, { cursor: 'v1-late', restart: true }))
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamPush = (o) => controller.enqueue(new TextEncoder().encode(`${JSON.stringify(o)}\n`))
        signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
      },
    })
    return new Response(body, { status: 200 })
  })
  const reader = createStateReader({ url: BASE_URL, credentials: async () => cred('rtv_aaa'), fetchImpl: svc.fetchImpl, minIntervalMs: 0 })
  t.after(() => reader.close())
  const seen: string[] = []
  reader.subscribe((s) => seen.push(s.cursor))
  await reader.snapshot()
  await until(() => streamPush !== undefined && reader.freshness().status === 'live', 'stream open')
  const refreshing = reader.refresh()
  await until(() => snapshots === 2, 'second snapshot in flight')
  streamPush(view(2))
  await until(() => seen.includes('v2'), 'stream line v2')
  releaseSnapshot()
  await refreshing
  assert.ok(!seen.includes('v1-late'), `the late snapshot was applied: ${seen.join(' ')}`)
  assert.equal(seen.at(-1), 'v2')
})

test('reconnect under the same credential resumes with since=<cursor>, encoded', async (t) => {
  let streams = 0
  const svc = service((c, signal) => {
    if (c.path === STATE_ROUTES.snapshot) return json(200, view(7, { cursor: 'Ue3+q0/W=' }))
    streams += 1
    return streams === 1 ? ndjson([view(8, { cursor: 'Xy9' })], signal, true) : ndjson([], signal)
  })
  const reader = createStateReader({ url: BASE_URL, credentials: async () => cred('rtv_aaa'), fetchImpl: svc.fetchImpl, maxBackoffMs: 10 })
  t.after(() => reader.close())
  await reader.snapshot()
  await until(() => streams === 2, 'second stream')
  const opens = svc.calls.filter((c) => c.path === STATE_ROUTES.stream).map((c) => c.search)
  assert.deepEqual(opens, ['?since=Ue3%2Bq0%2FW%3D', '?since=Xy9'])
})

test('a numeric cursor from a server before D-20261004-005 is read as a string and still resumes', async (t) => {
  let streams = 0
  const svc = service((c, signal) => {
    if (c.path === STATE_ROUTES.snapshot) return json(200, view(7, { cursor: 7 }))
    streams += 1
    return streams === 1 ? ndjson([view(8, { cursor: 8 })], signal, true) : ndjson([], signal)
  })
  const reader = createStateReader({ url: BASE_URL, credentials: async () => cred('rtv_aaa'), fetchImpl: svc.fetchImpl, maxBackoffMs: 10 })
  t.after(() => reader.close())
  const s = await reader.snapshot()
  assert.equal(s.cursor, '7')
  await until(() => streams === 2, 'second stream')
  assert.deepEqual(svc.calls.filter((c) => c.path === STATE_ROUTES.stream).map((c) => c.search), ['?since=7', '?since=8'])
})

test('a renewed credential never resumes: the new scope arrives whole, and the old view does not survive', async (t) => {
  // user-a leaves party-1. The backend's next credential names only user-a.
  // The service would send NOTHING for since=<current cursor>, so a reader that
  // resumed would keep showing party-1.
  //
  // setTimeout is mocked and never advanced: the reconnect after an `end` line
  // must happen at once, with no backoff timer in between.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let minted = 0
  const svc = service((c, signal) => {
    const token = c.auth!.replace('Bearer ', '')
    if (c.path === STATE_ROUTES.snapshot) return json(200, view(9))
    if (token === 'rtv_1') return ndjson([{ type: 'end', reason: 'closed' }], signal, true)
    if (c.search.startsWith('?since=')) return ndjson([], signal) // what the service does for an unchanged cursor
    return ndjson([view(9, { restart: true, sources: ['user-a'] })], signal)
  })
  const reader = createStateReader({
    url: BASE_URL,
    credentials: async () => cred(`rtv_${++minted}`),
    fetchImpl: svc.fetchImpl,
  })
  t.after(() => reader.close())
  let last: StateSnapshot | null = null
  reader.subscribe((s) => (last = s))
  await reader.snapshot()
  for (let i = 0; i < 50 && (last as StateSnapshot | null)?.scope.sources.length !== 1; i++) await settle()
  assert.equal((last as StateSnapshot | null)?.scope.sources.length, 1, 'narrowed view, with no timer fired')
  const opens = svc.calls.filter((c) => c.path === STATE_ROUTES.stream).map((c) => [c.auth, c.search])
  assert.deepEqual(opens, [
    ['Bearer rtv_1', '?since=v9'],
    ['Bearer rtv_2', ''],
  ])
  assert.deepEqual(Object.keys((last as unknown as StateSnapshot).state.sources), ['user-a'])
  assert.equal(minted, 2, 'an end line renews once')
})

test('end reasons: expired and revoked pass through, a key refusal reads as session_closed', async (t) => {
  for (const [wire, expected] of [
    ['expired', 'expired'],
    ['revoked', 'revoked'],
    ['missing_operation', 'session_closed'],
  ] as const) {
    let first = true
    const reasons: Array<string | null> = []
    const svc = service((c, signal) => {
      if (c.path === STATE_ROUTES.snapshot) return json(200, view(1))
      if (first) {
        first = false
        return ndjson([{ type: 'end', reason: wire }], signal, true)
      }
      return json(401, { code: 'credential_refused', reason: 'closed' })
    })
    const reader = createStateReader({ url: BASE_URL, credentials: async () => cred('rtv_same'), fetchImpl: svc.fetchImpl })
    reader.subscribe((_s, f) => reasons.push(f.reason))
    await reader.snapshot()
    await until(() => reader.freshness().status === 'unauthorized', `stopped after ${wire}`)
    reader.close()
    assert.equal(reader.freshness().reason, 'closed')
    t.diagnostic(`${wire}: ${reasons.join(' > ')}`)
    assert.ok(reasons.includes(expected), `${wire} should be announced as ${expected}: ${reasons.join(' > ')}`)
    assert.equal(reasons.at(-1), 'session_closed', 'the renewed credential was refused, so the reader stopped')
  }
})

test('ageSeconds is the age of the view as last confirmed: a heartbeat on the live stream confirms it', async (t) => {
  let clock = Date.parse('2026-10-03T12:00:00.000Z')
  const issued = new Date(clock - 30_000).toISOString()
  const heartbeatAt = new Date(clock - 5_000).toISOString()
  const svc = service((c, signal) =>
    c.path === STATE_ROUTES.snapshot ? json(200, view(1, { issuedAt: issued })) : ndjson([{ type: 'heartbeat', at: heartbeatAt }], signal),
  )
  const reader = createStateReader({ url: BASE_URL, credentials: async () => cred('rtv_aaa'), fetchImpl: svc.fetchImpl, now: () => clock })
  t.after(() => reader.close())
  await reader.snapshot()
  assert.equal(reader.freshness().ageSeconds, 30)
  await until(() => reader.freshness().ageSeconds === 5, 'heartbeat confirmation')
  clock += 2_000
  assert.equal(reader.freshness().ageSeconds, 7)
  assert.equal(reader.freshness().lastContactAt !== null, true)
})

test('answers map to English reasons: 403 stops, 401 twice stops, 429 and 503 back off, network is offline', async () => {
  const cases: Array<[string, () => Response | Promise<Response>, StateFreshness['status'], StateFreshness['reason']]> = [
    ['403', () => json(403, { code: 'origin_refused' }), 'forbidden', 'forbidden'],
    ['401', () => json(401, { code: 'credential_refused', reason: 'closed' }), 'unauthorized', 'session_closed'],
    ['429', () => json(429, { code: 'rate_limited' }, { 'retry-after': '3' }), 'stale', 'rate_limited'],
    ['503', () => json(503, { code: 'single_key_unavailable' }), 'stale', 'service_unavailable'],
    ['network', () => Promise.reject(new TypeError('fetch failed')), 'offline', 'network'],
  ]
  for (const [label, answer, status, reason] of cases) {
    const svc = service(() => answer())
    let minted = 0
    const reader = createStateReader({ url: BASE_URL, credentials: async () => cred(`rtv_${++minted}`), fetchImpl: svc.fetchImpl })
    await assert.rejects(reader.snapshot(), RetickError, label)
    assert.deepEqual([reader.freshness().status, reader.freshness().reason], [status, reason], label)
    if (label === '401') assert.equal(minted, 2, '401 renews once, and only once')
    if (label === '403') assert.equal(minted, 1, '403 never renews')
    assert.equal(svc.calls.filter((c) => c.path === STATE_ROUTES.stream).length, 0, `${label}: no stream after a failed first read`)
    reader.close()
  }
})

test('429 on the stream waits at least retry-after before reconnecting', async (t) => {
  // setTimeout is mocked: the reconnect timer fires only when the test advances
  // the clock, so the assertion is about the delay chosen, not about the machine.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let streams = 0
  const svc = service((c) => {
    if (c.path === STATE_ROUTES.snapshot) return json(200, view(1))
    streams += 1
    return json(429, { code: 'rate_limited', target: 'credential' }, { 'retry-after': '1' })
  })
  const reader = createStateReader({ url: BASE_URL, credentials: async () => cred('rtv_aaa'), fetchImpl: svc.fetchImpl, maxBackoffMs: 5 })
  t.after(() => reader.close())
  await reader.snapshot()
  for (let i = 0; i < 20 && reader.freshness().reason !== 'rate_limited'; i++) await settle()
  assert.equal(streams, 1)
  assert.equal(reader.freshness().reason, 'rate_limited')
  t.mock.timers.tick(999)
  for (let i = 0; i < 20; i++) await settle()
  assert.equal(streams, 1, 'maxBackoffMs is 5 ms, but retry-after says 1 s')
  t.mock.timers.tick(1)
  for (let i = 0; i < 20 && streams < 2; i++) await settle()
  assert.equal(streams, 2, 'reconnects once retry-after has passed')
})

test('the host failing to mint stops the reader as no_credential', async () => {
  const svc = service(() => json(200, view(1)))
  const reader = createStateReader({
    url: BASE_URL,
    credentials: async () => {
      throw new Error('backend said no')
    },
    fetchImpl: svc.fetchImpl,
  })
  await assert.rejects(reader.snapshot(), /no_credential/)
  assert.deepEqual([reader.freshness().status, reader.freshness().reason], ['unauthorized', 'no_credential'])
  assert.equal(svc.calls.length, 0)
})

test('close() during an in-flight snapshot keeps the late answer out', async () => {
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  const svc = service(async () => {
    await held
    return json(200, view(1))
  })
  const reader = createStateReader({ url: BASE_URL, credentials: async () => cred('rtv_aaa'), fetchImpl: svc.fetchImpl })
  const pending = reader.snapshot()
  await settle()
  reader.close()
  release()
  await assert.rejects(pending)
  assert.deepEqual([reader.freshness().status, reader.freshness().reason], ['idle', 'closed'])
})

test('revoke(): one DELETE with the session token; 204 is revoked, 401 is already-closed; never twice', async () => {
  for (const [code, outcome] of [
    [204, 'revoked'],
    [401, 'already-closed'],
    [500, 'refused'],
  ] as const) {
    const svc = service((c, signal) => {
      if (c.method === 'DELETE') return json(code)
      return c.path === STATE_ROUTES.snapshot ? json(200, view(1)) : ndjson([], signal)
    })
    const reader = createStateReader({ url: BASE_URL, credentials: async () => cred('rtv_bye'), fetchImpl: svc.fetchImpl })
    await reader.snapshot()
    const [a, b] = await Promise.all([reader.revoke(), reader.revoke()])
    assert.deepEqual([a, b], [outcome, outcome])
    assert.equal(await reader.revoke(), outcome)
    const deletes = svc.calls.filter((c) => c.method === 'DELETE')
    assert.deepEqual(deletes.map((c) => [c.path, c.auth]), [[STATE_ROUTES.session, 'Bearer rtv_bye']])
    assert.equal(reader.freshness().status, 'idle')
  }
})

test('revoke(): an API key sends nothing, a reader with no credential sends nothing, a silent service is unreachable', async () => {
  const keySvc = service((c, signal) => (c.path === STATE_ROUTES.snapshot ? json(200, view(1)) : ndjson([], signal)))
  const withKey = createStateReader({ url: BASE_URL, apiKey: KEY, fetchImpl: keySvc.fetchImpl })
  await withKey.snapshot()
  assert.equal(await withKey.revoke(), 'nothing-to-revoke')
  assert.equal(keySvc.calls.filter((c) => c.method === 'DELETE').length, 0, 'the server would answer 400 session_required')
  assert.equal(keySvc.calls[0]!.auth, `Bearer ${KEY}`)

  const fresh = createStateReader({ url: BASE_URL, credentials: async () => cred('rtv_x'), fetchImpl: service(() => json(200, view(1))).fetchImpl })
  assert.equal(await fresh.revoke(), 'nothing-to-revoke')

  const silent = service((c, signal) => {
    if (c.method === 'DELETE') return new Promise<Response>(() => {})
    return c.path === STATE_ROUTES.snapshot ? json(200, view(1)) : ndjson([], signal)
  })
  const slow = createStateReader({ url: BASE_URL, credentials: async () => cred('rtv_y'), fetchImpl: silent.fetchImpl, revokeTimeoutMs: 20 })
  await slow.snapshot()
  assert.equal(await slow.revoke(), 'unreachable')
})

test('configuration: one credential source, a well-formed key, and no key in a browser', async () => {
  assert.throws(() => createStateReader({ url: BASE_URL }), RetickConfigError)
  assert.throws(() => createStateReader({ url: BASE_URL, apiKey: KEY, credentials: async () => cred('rtv_a') }), RetickConfigError)
  assert.throws(() => createStateReader({ url: BASE_URL, apiKey: 'rtk_0123456789ab_abcdefghijklmnopqrstuvwxyz' }), RetickConfigError)

  const g = globalThis as { window?: unknown }
  g.window = { document: {} }
  try {
    assert.throws(() => createStateReader({ url: BASE_URL, apiKey: KEY }), /must not run in a browser/)
    // A host that hands a server key to a page is refused before anything is sent.
    const svc = service(() => json(200, view(1)))
    const reader = createStateReader({ url: BASE_URL, credentials: async () => cred(KEY), fetchImpl: svc.fetchImpl })
    await assert.rejects(reader.snapshot(), /no_credential/)
    assert.equal(svc.calls.length, 0)
  } finally {
    delete g.window
  }
})
