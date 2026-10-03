/**
 * `view: 'state'`, proven without a server.
 *
 * The generic view (`estado/v1`) is served by Retick at its own two routes. What
 * the client owns is narrower: which route it asks, that the credential travels
 * in the header and nowhere else, that the stream resumes from its cursor on the
 * state routes and not on the Agora ones, and that a reader written for 0.2.0
 * keeps asking exactly what it asked.
 *
 * Everything here imports from the package entry point, the way an application
 * does, and injects `fetch`. Nothing from the Retick service is imported, so the
 * file runs in this repository as it is.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AGORA_ROUTES,
  RetickConfigError,
  STATE_ROUTES,
  createAgoraReader,
  type AgoraSnapshot,
  type Credentials,
  type StateView,
} from '../src/index.ts'

const URL_BASE = 'https://retick.example'

function estado(cursor: number, status: string, reinicio = false): Record<string, unknown> {
  return {
    navegador: 1,
    versao: 'estado/v1',
    cursor,
    emitidaEm: new Date().toISOString(),
    reinicio,
    escopo: { projeto: 'prj_exemplo', fontes: ['shared'], todasAsFontes: false },
    agora: {
      entidades: {
        search: {
          'srch-1': {
            campos: { status, filme: status === 'decidido' ? 'filme-42' : null },
            procedencia: {
              status: { fonte: 'shared', sourceVersion: cursor, observadoEm: new Date().toISOString() },
            },
            observadoEm: new Date().toISOString(),
          },
        },
      },
      fontes: { shared: { aplicados: cursor, retidos: 0, contiguo: cursor, ultimoObservadoEm: null } },
    },
  }
}

const resposta = (codigo: number, corpo?: unknown): Response =>
  new Response(corpo === undefined ? null : JSON.stringify(corpo), { status: codigo })

function streamDe(linhas: unknown[]): Response {
  return new Response(new TextEncoder().encode(linhas.map((l) => `${JSON.stringify(l)}\n`).join('')), {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

type Pedido = { url: string; metodo: string; autorizacao: string | null }

function espiao(respostas: Array<(p: Pedido) => Response>) {
  const pedidos: Pedido[] = []
  let i = 0
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers)
    const p: Pedido = { url: String(url), metodo: (init?.method ?? 'GET').toUpperCase(), autorizacao: h.get('authorization') }
    pedidos.push(p)
    const fn = respostas[Math.min(i, respostas.length - 1)]!
    i += 1
    return fn(p)
  }) as unknown as typeof fetch
  return { pedidos, fetchImpl }
}

const credencial = (token: string): Credentials => ({
  token,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
})

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('STATE_ROUTES are the generic view, and the session route is the same as the Agora one', () => {
  assert.equal(STATE_ROUTES.snapshot, '/api/navegador/v1/estado')
  assert.equal(STATE_ROUTES.stream, '/api/navegador/v1/estado/stream')
  assert.equal(STATE_ROUTES.session, AGORA_ROUTES.session)
  assert.notEqual(STATE_ROUTES.snapshot, AGORA_ROUTES.snapshot)
})

test("view: 'state' asks the state route, with the token in the header and never in the URL", async () => {
  const { pedidos, fetchImpl } = espiao([() => resposta(200, estado(3, 'escolhendo')), () => streamDe([])])
  const leitor = createAgoraReader({
    url: URL_BASE,
    view: 'state',
    credentials: async () => credencial('rtv_segredo'),
    maxBackoffMs: 5_000,
    fetchImpl,
  })
  const s = await leitor.snapshot()
  leitor.close()

  assert.equal(pedidos[0]!.url, `${URL_BASE}${STATE_ROUTES.snapshot}`)
  assert.equal(pedidos[0]!.autorizacao, 'Bearer rtv_segredo')
  for (const p of pedidos) assert.ok(!p.url.includes('rtv_segredo'), p.url)

  const vista = s.agora as unknown as StateView
  assert.equal(s.versao, 'estado/v1')
  assert.equal(vista.entidades.search!['srch-1']!.campos.status, 'escolhendo')
  assert.equal(vista.entidades.search!['srch-1']!.procedencia.status!.fonte, 'shared')
})

test('the state stream resumes from its cursor on the state route, and delivers the new state', async () => {
  const vistos: AgoraSnapshot[] = []
  const { pedidos, fetchImpl } = espiao([
    () => resposta(200, estado(3, 'escolhendo')),
    () => streamDe([estado(5, 'decidido')]),
    () => streamDe([]),
  ])
  const leitor = createAgoraReader({
    url: URL_BASE,
    view: 'state',
    credentials: async () => credencial('rtv_token'),
    maxBackoffMs: 20,
    fetchImpl,
  })
  leitor.subscribe((s) => vistos.push(s))
  await leitor.snapshot()
  await esperar(200)
  leitor.close()

  assert.equal(pedidos[1]!.url, `${URL_BASE}${STATE_ROUTES.stream}?desde=3`)
  assert.equal(pedidos[2]!.url, `${URL_BASE}${STATE_ROUTES.stream}?desde=5`)
  assert.ok(pedidos.every((p) => !p.url.includes('/agora')), 'a state reader never touches the Agora routes')
  const ultimo = vistos.at(-1)!.agora as unknown as StateView
  assert.equal(ultimo.entidades.search!['srch-1']!.campos.status, 'decidido')
  assert.equal(ultimo.entidades.search!['srch-1']!.campos.filme, 'filme-42')
})

test('a state frame marked `reinicio` replaces, even with a lower cursor', async () => {
  const cursores: number[] = []
  const { fetchImpl } = espiao([
    () => resposta(200, estado(9, 'escolhendo')),
    // A new service instance numbers from 1 again, and says so.
    () => streamDe([estado(1, 'decidido', true)]),
    () => streamDe([]),
  ])
  const leitor = createAgoraReader({
    url: URL_BASE,
    view: 'state',
    credentials: async () => credencial('rtv_token'),
    maxBackoffMs: 5_000,
    fetchImpl,
  })
  leitor.subscribe((s) => cursores.push(s.cursor))
  await leitor.snapshot()
  await esperar(150)
  leitor.close()
  assert.deepEqual(cursores.filter((c, i) => i === 0 || c !== cursores[i - 1]), [9, 1])
})

test('a 403 on the state route stops the reader: a session without estado.ler is not retried', async () => {
  const { pedidos, fetchImpl } = espiao([() => resposta(403, { erro: 'credencial sem a capacidade estado.ler' })])
  const leitor = createAgoraReader({
    url: URL_BASE,
    view: 'state',
    credentials: async () => credencial('rtv_token'),
    fetchImpl,
  })
  await assert.rejects(leitor.snapshot())
  await esperar(50)
  assert.equal(leitor.freshness().status, 'forbidden')
  assert.equal(pedidos.length, 1)
  leitor.close()
})

test('revoke from a state reader ends the session on the shared session route', async () => {
  const pedidos: Pedido[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const p: Pedido = {
      url: String(url),
      metodo: (init?.method ?? 'GET').toUpperCase(),
      autorizacao: new Headers(init?.headers).get('authorization'),
    }
    pedidos.push(p)
    if (p.metodo === 'DELETE') return resposta(204)
    if (p.url.includes('/stream')) return streamDe([])
    return resposta(200, estado(1, 'escolhendo'))
  }) as unknown as typeof fetch
  const leitor = createAgoraReader({
    url: URL_BASE,
    view: 'state',
    credentials: async () => credencial('rtv_token'),
    maxBackoffMs: 5_000,
    fetchImpl,
  })
  await leitor.snapshot()
  assert.equal(await leitor.revoke(), 'revoked')
  const del = pedidos.filter((p) => p.metodo === 'DELETE')
  assert.equal(del.length, 1)
  assert.equal(del[0]!.url, `${URL_BASE}${STATE_ROUTES.session}`)
  assert.equal(del[0]!.autorizacao, 'Bearer rtv_token')
})

test('without `view`, a reader asks exactly what 0.2.0 asked', async () => {
  const { pedidos, fetchImpl } = espiao([
    () =>
      resposta(200, {
        navegador: 1,
        versao: 'agora/v2',
        cursor: 1,
        emitidaEm: new Date().toISOString(),
        reinicio: true,
        escopo: { projeto: 'p', fontes: [] },
        agora: {},
      }),
  ])
  const leitor = createAgoraReader({ url: URL_BASE, credentials: async () => credencial('rtv_token'), fetchImpl })
  await leitor.snapshot()
  leitor.close()
  assert.equal(pedidos[0]!.url, `${URL_BASE}${AGORA_ROUTES.snapshot}`)
})

test('an unknown view is a configuration error, before any request', () => {
  assert.throws(
    () => createAgoraReader({ url: URL_BASE, view: 'entities' as never, credentials: async () => credencial('t') }),
    (e: unknown) => e instanceof RetickConfigError && /unknown view/.test((e as Error).message),
  )
})
