/**
 * Credential renewal under concurrency, for both browser readers (A017,
 * `ac15051`; browser contract §11).
 *
 * Each reader has two paths that can learn a credential is dead at the same
 * time: a `snapshot()` the host calls, and the live stream the supervisor keeps
 * open. One revocation must cost the host one `credentials()` call, a late 401
 * about a token already replaced must mint nothing, and a refused renewal must
 * stop the reader.
 *
 * Nothing here waits on a timer to decide an outcome. The fake transport holds
 * each stream answer behind a gate the test opens, the host's `credentials()`
 * is held the same way, and `settle()` drains one macrotask turn.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createAgoraReader, type Credentials } from '../src/agora.ts'
import { createStateReader } from '../src/state.ts'

const BASE_URL = 'https://retick.example'

type Variant = {
  name: string
  snapshotPath: string
  body: (cursor: number) => Record<string, unknown>
  /** The cursor `snapshot()` reports for `body(n)`. */
  cursorOf: (n: number) => string | number
  create: (o: { credentials: () => Promise<Credentials>; fetchImpl: typeof fetch; minIntervalMs?: number; clock?: () => number }) => {
    snapshot(): Promise<{ cursor: number | string }>
    refresh(): Promise<void>
    freshness(): { status: string }
    close(): void
  }
}

const VARIANTS: Variant[] = [
  {
    name: 'createAgoraReader',
    snapshotPath: '/api/navegador/v1/agora',
    cursorOf: (n) => n,
    body: (cursor) => ({
      navegador: 1,
      versao: 'agora/v2',
      cursor,
      emitidaEm: new Date().toISOString(),
      reinicio: true,
      escopo: { projeto: 'p', fontes: ['s'] },
      agora: {},
    }),
    create: (o) =>
      createAgoraReader({
        url: BASE_URL,
        credentials: o.credentials,
        fetchImpl: o.fetchImpl,
        minIntervalMs: o.minIntervalMs,
        now: o.clock ? () => new Date(o.clock!()) : undefined,
      }),
  },
  {
    name: 'createStateReader',
    snapshotPath: '/api/browser/v1/state',
    cursorOf: (n) => `view-${n}`,
    body: (cursor) => ({
      browser: 1,
      version: 'state/v1',
      cursor: `view-${cursor}`,
      issuedAt: new Date().toISOString(),
      restart: true,
      scope: { project: 'p', sources: ['s'], allSources: false },
      state: { entities: {}, sources: {} },
    }),
    create: (o) =>
      createStateReader({
        url: BASE_URL,
        credentials: o.credentials,
        fetchImpl: o.fetchImpl,
        minIntervalMs: o.minIntervalMs,
        now: o.clock,
      }),
  },
]

function status(code: number): Response {
  return new Response(null, { status: code })
}

function gate<T>() {
  let open!: (v: T) => void
  const opened = new Promise<T>((r) => (open = r))
  return { open, opened }
}

const settle = () => new Promise<void>((r) => setImmediate(r))

type Call = { path: string; token: string }

function fakeService(v: Variant) {
  const revoked = new Set<string>()
  const calls: Call[] = []
  const heldStreams = new Map<string, ReturnType<typeof gate<void>>>()
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    const token = new Headers(init?.headers).get('authorization')!.replace('Bearer ', '')
    calls.push({ path, token })
    const held = path.endsWith('/stream') ? heldStreams.get(token) : undefined
    if (held) await held.opened
    if (revoked.has(token)) return status(401)
    if (!path.endsWith('/stream')) return new Response(JSON.stringify(v.body(1)))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(v.body(2))}\n`))
        init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
      },
    })
    return new Response(body, { status: 200 })
  }) as unknown as typeof fetch
  return { revoked, calls, heldStreams, fetchImpl }
}

function heldHost(expiresInMs = 600_000, clock: () => number = Date.now) {
  let minted = 0
  const release = gate<void>()
  const credentials = async (): Promise<Credentials> => {
    minted += 1
    const n = minted
    if (n > 1) await release.opened
    return { token: `rtv_t${n}`, expiresAt: new Date(clock() + expiresInMs).toISOString() }
  }
  return { credentials, release, minted: () => minted }
}

for (const v of VARIANTS) {
  test(`${v.name}: a revocation seen by snapshot and stream at once costs ONE credentials() call`, async (t) => {
    const svc = fakeService(v)
    const host = heldHost()
    svc.heldStreams.set('rtv_t1', gate<void>())
    const reader = v.create({ credentials: host.credentials, fetchImpl: svc.fetchImpl })
    t.after(() => reader.close())

    await reader.snapshot()
    await settle()
    assert.deepEqual(svc.calls.map((c) => [c.path, c.token]), [
      [v.snapshotPath, 'rtv_t1'],
      [`${v.snapshotPath}/stream`, 'rtv_t1'],
    ])

    svc.revoked.add('rtv_t1')
    const pending = reader.snapshot()
    await settle()
    assert.equal(host.minted(), 2, 'snapshot path heard 401 and asked the host')

    svc.heldStreams.get('rtv_t1')!.open()
    await settle()
    assert.equal(host.minted(), 2, 'stream path heard 401 while renewal was in flight and joined it')

    host.release.open()
    const s = await pending
    // The renewed stream may deliver its view before the snapshot answers; the
    // state reader then keeps the stream's view (cursors have no order). Either
    // way the view is the renewed credential's.
    assert.ok([v.cursorOf(1), v.cursorOf(2)].includes(s.cursor), String(s.cursor))
    await settle()

    const afterRevocation = svc.calls.slice(3)
    assert.ok(afterRevocation.length >= 2)
    assert.ok(afterRevocation.every((c) => c.token === 'rtv_t2'), JSON.stringify(afterRevocation))
    assert.equal(reader.freshness().status, 'live')
    assert.equal(host.minted(), 2)
  })

  test(`${v.name}: a 401 for a token already replaced retries with the current one and mints nothing`, async (t) => {
    const svc = fakeService(v)
    const host = heldHost()
    svc.heldStreams.set('rtv_t1', gate<void>())
    const reader = v.create({ credentials: host.credentials, fetchImpl: svc.fetchImpl })
    t.after(() => reader.close())

    await reader.snapshot()
    await settle()
    svc.revoked.add('rtv_t1')
    host.release.open()
    await reader.snapshot()
    assert.equal(host.minted(), 2)

    svc.heldStreams.get('rtv_t1')!.open()
    await settle()
    await settle()

    assert.equal(host.minted(), 2, 'the late 401 was about t1, and t1 is no longer the credential')
    assert.equal(svc.calls.at(-1)!.token, 'rtv_t2')
    assert.equal(reader.freshness().status, 'live')
  })

  test(`${v.name}: renewing once still means once when both paths shared the renewal`, async (t) => {
    const svc = fakeService(v)
    const host = heldHost()
    svc.heldStreams.set('rtv_t1', gate<void>())
    const reader = v.create({ credentials: host.credentials, fetchImpl: svc.fetchImpl })
    t.after(() => reader.close())

    await reader.snapshot()
    await settle()
    svc.revoked.add('rtv_t1')
    svc.revoked.add('rtv_t2')
    const pending = reader.snapshot()
    await settle()
    svc.heldStreams.get('rtv_t1')!.open()
    await settle()
    host.release.open()

    await pending
    await settle()
    assert.equal(reader.freshness().status, 'unauthorized')
    assert.equal(host.minted(), 2, 'no third credential: a refused renewal stops the reader')
  })

  test(`${v.name}: two paths that find the credential expired share one renewal`, async (t) => {
    let clock = Date.parse('2026-10-03T12:00:00Z')
    const svc = fakeService(v)
    const host = heldHost(1_000, () => clock)
    svc.heldStreams.set('rtv_t1', gate<void>())
    const reader = v.create({ credentials: host.credentials, fetchImpl: svc.fetchImpl, clock: () => clock })
    t.after(() => reader.close())

    await reader.snapshot()
    await settle()
    clock += 5_000
    svc.revoked.add('rtv_t1')
    const pending = reader.snapshot()
    await settle()
    svc.heldStreams.get('rtv_t1')!.open()
    await settle()
    host.release.open()
    await pending
    await settle()

    assert.equal(host.minted(), 2)
    assert.equal(svc.calls.at(-1)!.token, 'rtv_t2')
  })

  test(`${v.name}: refresh() inside the floor sends nothing, so it cannot be what triggers a 401`, async (t) => {
    let clock = Date.parse('2026-10-03T12:00:00Z')
    const svc = fakeService(v)
    const host = heldHost()
    const reader = v.create({ credentials: host.credentials, fetchImpl: svc.fetchImpl, minIntervalMs: 10, clock: () => clock })
    t.after(() => reader.close())

    await reader.snapshot()
    await settle()
    const before = svc.calls.length
    clock += 3
    await reader.refresh()
    assert.equal(svc.calls.length, before)
    clock += 10
    await reader.refresh()
    assert.equal(svc.calls.length, before + 1)
  })
}
