/**
 * `consumer.replaySources()`: replay of many sources over
 * `POST /api/read/v1/batch`. No server starts here. The injected `fetch` is a
 * fake service with one log per source, which answers the single-source route
 * and the batch route from the SAME logs, so the two paths can be compared
 * fact by fact.
 *
 * The fake service does not copy the server's batch (fair budget, byte cut).
 * It only does what the client has to face: one page per source, a source
 * deferred when the response is full, scope refusals, a source limit and
 * network failures. The real batch is proved elsewhere, against the service's
 * own handlers on main.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createConsumer, type ReadFact, type ReplayCheckpoint } from '../src/index.ts'
import {
  RetickAuthError,
  RetickConfigError,
  RetickError,
  RetickHttpError,
  RetickTimeoutError,
} from '../src/errors.ts'

const TOKEN = 'rtl_0123456789ab_readSecretThatMustNeverLeak123456'

type Entry = { source: string; sourceVersion: number; entityType?: string }

type FakeService = {
  /** Appends to the source's log, in arrival order. */
  publish: (...facts: Entry[]) => void
  fetch: typeof fetch
  requests: { route: string; sources: string[] }[]
  /** Scripted failures, one consumed per batch request. */
  failures: Array<'ok' | '503' | 'network' | 'hang' | '404'>
}

function fakeService(op: {
  /** Log positions per batch response, summed over all sources. */
  budget?: number
  maxSources?: number
  /** The credential's exact source list. `null`: every source. */
  scope?: string[] | null
  /** An `entityType` outside the credential's map: it takes a position and is not sent. */
  hidden?: string
} = {}): FakeService {
  const logs = new Map<string, ReadFact[]>()
  const requests: FakeService['requests'] = []
  const failures: FakeService['failures'] = []

  const stateOf = (source: string) => {
    const log = logs.get(source) ?? []
    const versions = new Set(log.map((f) => f.sourceVersion))
    const floor = log.length > 0 ? (log[0] as ReadFact).sourceVersion - 1 : 0
    let contiguous = floor
    while (versions.has(contiguous + 1)) contiguous += 1
    return {
      source,
      position: log.length,
      contiguous,
      highest: Math.max(floor, ...versions),
      gaps: [],
      pending: 0,
      floor,
      floorOrigin: 'first-fact',
      durable: false,
      shared: false,
      damaged: false,
      lastAt: '2026-10-06T00:00:00.000Z',
      freshnessSeconds: null,
    }
  }

  const page = (source: string, position: number, window: number) => {
    const log = logs.get(source) ?? []
    const end = Math.min(log.length, position + window)
    const read = log.slice(position, end)
    const visible = read.filter((f) => f.entityType !== op.hidden)
    return {
      read: 1,
      project: 'acme',
      source,
      facts: visible,
      cursor: { from: position, next: end, total: log.length, hasMore: end < log.length },
      withheld: { type: read.length - visible.length, sensitivity: 0 },
      state: stateOf(source),
    }
  }

  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const fakeFetch = (async (url: string, init: RequestInit) => {
    const u = new URL(url)
    if (init.headers && (init.headers as Record<string, string>).authorization !== `Bearer ${TOKEN}`) {
      return respond(401, { code: 'credential_refused', reason: 'unknown' })
    }
    const refuse = (sources: string[]) => {
      const outside = op.scope ? sources.find((s) => !op.scope!.includes(s)) : undefined
      return outside === undefined
        ? null
        : respond(403, { code: 'source_not_granted', message: `source ${outside} is not granted`, source: outside })
    }

    if (u.pathname === '/api/read/v1/facts') {
      const source = u.searchParams.get('source') as string
      requests.push({ route: 'facts', sources: [source] })
      const refused = refuse([source])
      if (refused) return refused
      return respond(200, page(source, Number(u.searchParams.get('position') ?? 0), Number(u.searchParams.get('limit') ?? 500)))
    }

    if (u.pathname === '/api/read/v1/batch' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { sources: { source: string; position: number }[]; limit?: number }
      requests.push({ route: 'batch', sources: body.sources.map((s) => s.source) })
      const failure = failures.shift()
      if (failure === '503') return respond(503, { code: 'internal_error', message: 'try again' })
      if (failure === 'network') throw new TypeError('fetch failed')
      if (failure === '404') return respond(404, { code: 'not_found' })
      if (failure === 'hang') {
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }
      const max = op.maxSources ?? 100
      if (body.sources.length > max) {
        return respond(400, { code: 'invalid_field', field: 'sources', reason: 'too_many', max })
      }
      const refused = refuse(body.sources.map((s) => s.source))
      if (refused) return refused
      const limit = Math.min(body.limit ?? 500, 500)
      let left = op.budget ?? 1000
      const pages: unknown[] = []
      const deferred: { source: string; position: number }[] = []
      for (const { source, position } of body.sources) {
        const due = Math.max(0, (logs.get(source) ?? []).length - position)
        if (due > 0 && left === 0) {
          deferred.push({ source, position })
          continue
        }
        const window = Math.min(limit, due, left)
        left -= window
        pages.push(page(source, position, window))
      }
      return respond(200, { read: 1, project: 'acme', pages, deferred, limits: { maxSources: max, limit } })
    }
    return respond(404, { code: 'not_found' })
  }) as unknown as typeof fetch

  return {
    requests,
    failures,
    fetch: fakeFetch,
    publish: (...facts) => {
      for (const f of facts) {
        const log = logs.get(f.source) ?? []
        log.push({
          position: log.length + 1,
          eventId: `${f.source}-v${f.sourceVersion}-${log.length + 1}`,
          source: f.source,
          sourceVersion: f.sourceVersion,
          type: 'thing.changed',
          entityType: f.entityType ?? 'thing',
          entityId: f.source,
          schemaVersion: 1,
          occurredAt: '2026-10-06T00:00:00.000Z',
          recordedAt: '2026-10-06T00:00:00.000Z',
          observedAt: '2026-10-06T00:00:00.000Z',
          payload: { v: f.sourceVersion },
        })
        logs.set(f.source, log)
      }
    },
  }
}

const consumerFor = (s: FakeService, extra: Record<string, unknown> = {}) =>
  createConsumer({
    url: 'http://retick.test',
    token: TOKEN,
    fetch: s.fetch,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 2,
    ...extra,
  })

/** 17 facts in 7 sources, the synthetic case from the feedback: 3+3+3+2+2+2+2. */
function seventeen(s: FakeService): string[] {
  const sources = ['user-a', 'user-b', 'user-c', 'room-1', 'room-2', 'room-3', 'room-4']
  sources.forEach((source, i) => {
    for (let v = 1; v <= (i < 3 ? 3 : 2); v++) s.publish({ source, sourceVersion: v })
  })
  return sources
}

/** What each source received, in delivery order. */
function collector() {
  const bySource = new Map<string, number[]>()
  const order: string[] = []
  return {
    bySource,
    order,
    onFacts: (facts: ReadFact[], source: string) => {
      for (const f of facts) assert.equal(f.source, source, 'one onFacts batch mixes sources')
      bySource.set(source, [...(bySource.get(source) ?? []), ...facts.map((f) => f.sourceVersion)])
      order.push(source)
    },
  }
}

test('17 facts in 7 sources: a single request, each source in sourceVersion order', async () => {
  const s = fakeService()
  const sources = seventeen(s)
  const c = collector()
  const r = await consumerFor(s).replaySources({ sources: sources, onFacts: c.onFacts })

  assert.equal(r.requests, 1)
  assert.deepEqual(s.requests.map((p) => p.route), ['batch'])
  assert.equal(r.applied, 17)
  assert.equal(r.caughtUp, true)
  for (const [i, source] of sources.entries()) {
    assert.deepEqual(c.bySource.get(source), i < 3 ? [1, 2, 3] : [1, 2])
    assert.equal(r.resume[source]?.source, source)
  }
})

test('each source\'s checkpoint is the one replay() would return', async () => {
  const s = fakeService()
  const sources = seventeen(s)
  s.publish({ source: 'user-a', sourceVersion: 5 }) // held behind v4
  const c = consumerFor(s)
  const batch = await c.replaySources({ sources: sources, onFacts: () => {} })
  for (const source of sources) {
    const single = await c.replay({ source, onFacts: () => {} })
    assert.deepEqual(batch.resume[source], single.resume, source)
  }
  assert.equal(batch.held, 1)
  assert.equal(batch.sources['user-a']?.held, 1)
})

test('a fact held behind a gap is delivered once, when the gap closes, in a later call', async () => {
  const s = fakeService()
  s.publish({ source: 'a', sourceVersion: 1 }, { source: 'a', sourceVersion: 3 }, { source: 'b', sourceVersion: 1 })
  const c = consumerFor(s)
  const first = collector()
  const r1 = await c.replaySources({ sources: ['a', 'b'], onFacts: first.onFacts })
  assert.deepEqual(first.bySource.get('a'), [1])
  assert.equal(r1.held, 1)

  s.publish({ source: 'a', sourceVersion: 2 }, { source: 'b', sourceVersion: 2 })
  const second = collector()
  const r2 = await c.replaySources({ sources: ['a', 'b'], resume: r1.resume, onFacts: second.onFacts })
  assert.deepEqual(second.bySource.get('a'), [2, 3])
  assert.deepEqual(second.bySource.get('b'), [2])
  assert.equal(r2.held, 0)

  const third = collector()
  await c.replaySources({ sources: ['a', 'b'], resume: r2.resume, onFacts: third.onFacts })
  assert.equal(third.order.length, 0, 'nothing is delivered twice')
})

test('full response: a deferred source goes first in the next request and no fact is lost', async () => {
  const s = fakeService({ budget: 3 })
  const sources = seventeen(s)
  const c = collector()
  const r = await consumerFor(s).replaySources({ sources: sources, onFacts: c.onFacts })

  assert.equal(r.applied, 17)
  assert.ok(r.deferred > 0)
  assert.ok(r.requests >= 6)
  for (const [i, source] of sources.entries()) assert.deepEqual(c.bySource.get(source), i < 3 ? [1, 2, 3] : [1, 2])
  // A source deferred in one request opens the next one.
  const batches = s.requests.filter((p) => p.route === 'batch')
  assert.equal(batches[1]?.sources[0], 'user-b')
})

test('delivery order within each source does not depend on page size or budget', async () => {
  const sources = ['a', 'b', 'c']
  const delivered = async (budget: number, limit: number) => {
    const s = fakeService({ budget })
    for (const v of [1, 3, 2, 5, 4]) for (const source of sources) s.publish({ source, sourceVersion: v })
    const c = collector()
    await consumerFor(s).replaySources({ sources: sources, limit, onFacts: c.onFacts })
    return sources.map((f) => c.bySource.get(f))
  }
  const baseline = await delivered(1000, 500)
  assert.deepEqual(baseline, [[1, 2, 3, 4, 5], [1, 2, 3, 4, 5], [1, 2, 3, 4, 5]])
  for (const [o, l] of [[1, 1], [2, 1], [4, 2], [7, 3]] as const) assert.deepEqual(await delivered(o, l), baseline)
})

test('more sources than one request takes: requests of at most 100', async () => {
  const s = fakeService()
  const sources = Array.from({ length: 150 }, (_, i) => `user-${i}`)
  for (const source of sources) s.publish({ source, sourceVersion: 1 })
  const r = await consumerFor(s).replaySources({ sources: sources, onFacts: () => {} })
  assert.equal(r.applied, 150)
  assert.deepEqual(s.requests.map((p) => p.sources.length), [100, 50])
})

test('a service with a lower limit: the client uses the max from the refusal and finishes', async () => {
  const s = fakeService({ maxSources: 3 })
  const sources = seventeen(s)
  const r = await consumerFor(s).replaySources({ sources: sources, onFacts: () => {} })
  assert.equal(r.applied, 17)
  assert.ok(s.requests.every((p, i) => i === 0 || p.sources.length <= 3))
})

test('a source outside the credential\'s exact list: refused before any fact is delivered', async () => {
  const s = fakeService({ scope: ['user-a', 'user-b'] })
  seventeen(s)
  const c = collector()
  await assert.rejects(
    consumerFor(s).replaySources({ sources: ['user-a', 'user-c'], onFacts: c.onFacts }),
    RetickAuthError,
  )
  assert.equal(c.order.length, 0)
})

test('a checkpoint of another source is refused before any request', async () => {
  const s = fakeService()
  seventeen(s)
  const c = consumerFor(s)
  const r = await c.replaySources({ sources: ['user-a'], onFacts: () => {} })
  const swapped = { 'user-b': r.resume['user-a'] as ReplayCheckpoint }
  await assert.rejects(c.replaySources({ sources: ['user-b'], resume: swapped, onFacts: () => {} }), RetickConfigError)
  assert.equal(s.requests.length, 1)
})

test('a checkpoint read past the end of the log is refused, as in replay()', async () => {
  const s = fakeService()
  s.publish({ source: 'a', sourceVersion: 1 })
  const resume = { a: { source: 'a', position: 9, readTo: 9, floor: 0, settled: [{ from: 1, to: 1 }] } }
  await assert.rejects(consumerFor(s).replaySources({ sources: ['a'], resume, onFacts: () => {} }), /past the end/)
})

test('a repeated source is refused; an empty list makes no request', async () => {
  const s = fakeService()
  await assert.rejects(consumerFor(s).replaySources({ sources: ['a', 'a'], onFacts: () => {} }), RetickConfigError)
  const r = await consumerFor(s).replaySources({ sources: [], onFacts: () => {} })
  assert.equal(r.requests, 0)
  assert.equal(r.caughtUp, true)
  assert.equal(s.requests.length, 0)
})

test('checkpoints from replay() and replaySources() work in both directions', async () => {
  const s = fakeService()
  const sources = seventeen(s)
  const c = consumerFor(s)
  const singles: Record<string, ReplayCheckpoint> = {}
  for (const source of sources) singles[source] = (await c.replay({ source, onFacts: () => {} })).resume

  for (const source of sources) s.publish({ source, sourceVersion: 4 })
  const collected = collector()
  const r = await c.replaySources({ sources: sources, resume: singles, onFacts: collected.onFacts })
  for (const [i, source] of sources.entries()) assert.deepEqual(collected.bySource.get(source), i < 3 ? [4] : undefined)
  assert.equal(r.held, 4, 'v4 without v3 is held in the four rooms')

  for (const source of sources.slice(3)) s.publish({ source, sourceVersion: 3 })
  const back: number[] = []
  await c.replay({ source: 'room-1', resume: r.resume['room-1'] as ReplayCheckpoint, onFacts: (fs) => void back.push(...fs.map((f) => f.sourceVersion)) })
  assert.deepEqual(back, [3, 4])
})

test('a version outside the credential\'s map takes a position, is not sent, and does not become a permanent gap', async () => {
  const s = fakeService({ hidden: 'secret' })
  s.publish(
    { source: 'a', sourceVersion: 1 },
    { source: 'a', sourceVersion: 2, entityType: 'secret' },
    { source: 'a', sourceVersion: 3 },
  )
  const c = collector()
  const r = await consumerFor(s).replaySources({ sources: ['a'], onFacts: c.onFacts })
  assert.deepEqual(c.bySource.get('a'), [1, 3])
  assert.equal(r.sources['a']?.withheld.type, 1)
  assert.equal(r.held, 0)
})

test('a 503 and a network failure on the batch are retried with the same body, and the result does not change', async () => {
  const s = fakeService()
  const sources = seventeen(s)
  s.failures.push('503', 'network')
  const c = collector()
  const r = await consumerFor(s).replaySources({ sources: sources, onFacts: c.onFacts })
  assert.equal(r.applied, 17)
  assert.equal(r.requests, 1, 'retries do not count as requests')
  const batches = s.requests.filter((p) => p.route === 'batch')
  assert.equal(batches.length, 3)
  assert.deepEqual(batches[0], batches[2])
})

test('a batch timeout: retried when retries are left; without one it throws and the next call delivers again', async () => {
  const s = fakeService()
  const sources = seventeen(s)
  s.failures.push('hang')
  const r = await consumerFor(s, { timeoutMs: 20 }).replaySources({ sources: sources, onFacts: () => {} })
  assert.equal(r.applied, 17)

  // Without retries: the call's first request answers, the second hangs.
  const s2 = fakeService({ budget: 3 })
  seventeen(s2)
  const noRetry = consumerFor(s2, { timeoutMs: 20, retries: 0 })
  const r1 = await noRetry.replaySources({ sources: sources, maxRequests: 2, onFacts: () => {} })
  assert.equal(r1.caughtUp, false)
  s2.failures.push('ok', 'hang')
  const failed = collector()
  await assert.rejects(
    noRetry.replaySources({ sources: sources, resume: r1.resume, onFacts: failed.onFacts }),
    RetickTimeoutError,
  )
  assert.ok(failed.order.length > 0, 'the failed call had already delivered facts')
  const after = collector()
  const r2 = await noRetry.replaySources({ sources: sources, resume: r1.resume, onFacts: after.onFacts })
  assert.equal(r2.caughtUp, true)
  // From checkpoint r1 on everything arrives, including what the failed call had already delivered.
  assert.equal(r1.applied + r2.applied, 17)
  for (const [source, vs] of failed.bySource) {
    assert.deepEqual(after.bySource.get(source)?.slice(0, vs.length), vs, source)
  }
})

test('maxRequests stops midway, and the following calls finish without losing or repeating', async () => {
  const s = fakeService({ budget: 2 })
  const sources = seventeen(s)
  const c = collector()
  let resume: Record<string, ReplayCheckpoint> | undefined
  let calls = 0
  for (;;) {
    calls += 1
    const r = await consumerFor(s).replaySources({ sources: sources, maxRequests: 2, onFacts: c.onFacts, ...(resume ? { resume } : {}) })
    resume = r.resume
    assert.ok(r.requests >= 1)
    if (r.caughtUp) break
    assert.ok(calls < 20)
  }
  assert.ok(calls > 1)
  for (const [i, source] of sources.entries()) assert.deepEqual(c.bySource.get(source), i < 3 ? [1, 2, 3] : [1, 2])
})

test('a service without the batch route: the error says to use replay()', async () => {
  const s = fakeService()
  s.failures.push('404')
  await assert.rejects(
    consumerFor(s).replaySources({ sources: ['a'], onFacts: () => {} }),
    (e: unknown) => e instanceof RetickHttpError && e.status === 404 && /replay\(\)/.test(e.message),
  )
})

test('a response about a source that was not asked for does not pass silently', async () => {
  const s = fakeService()
  s.publish({ source: 'a', sourceVersion: 1 }, { source: 'intruder', sourceVersion: 1 })
  const crooked = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { sources: { source: string }[] }
    const swapped = { ...body, sources: [{ source: 'intruder', position: 0 }] }
    return s.fetch(url, { ...init, body: JSON.stringify(swapped) })
  }) as unknown as typeof fetch
  await assert.rejects(consumerFor(s, { fetch: crooked }).replaySources({ sources: ['a'], onFacts: () => {} }), RetickError)
})

test('a fact released after a held one is not delivered again when the held one is released', async () => {
  // Log of a: v1, v4 (held), v2 (released). The checkpoint goes back to before
  // v4, so v2 is read again: only what the checkpoint remembers prevents a repeat.
  const s = fakeService()
  s.publish({ source: 'a', sourceVersion: 1 }, { source: 'a', sourceVersion: 4 }, { source: 'a', sourceVersion: 2 })
  const c = consumerFor(s)
  const single = collector()
  const r1 = await c.replaySources({ sources: ['a'], onFacts: single.onFacts })
  assert.deepEqual(single.bySource.get('a'), [1, 2])
  s.publish({ source: 'a', sourceVersion: 3 })
  const next = collector()
  await c.replaySources({ sources: ['a'], resume: r1.resume, onFacts: next.onFacts })
  assert.deepEqual(next.bySource.get('a'), [3, 4])
})

test('first version outside the map and a gap right after: the floor comes from the service, and v3 waits for v2', async () => {
  const s = fakeService({ hidden: 'secret' })
  s.publish({ source: 'a', sourceVersion: 1, entityType: 'secret' }, { source: 'a', sourceVersion: 3 })
  const c = consumerFor(s)
  const single = collector()
  const r1 = await c.replaySources({ sources: ['a'], onFacts: single.onFacts })
  assert.equal(single.order.length, 0)
  assert.equal(r1.held, 1)
  s.publish({ source: 'a', sourceVersion: 2 })
  const next = collector()
  await c.replaySources({ sources: ['a'], resume: r1.resume, onFacts: next.onFacts })
  assert.deepEqual(next.bySource.get('a'), [2, 3])
})

test('a page at a position that was not asked for is refused, even for the right source', async () => {
  const s = fakeService()
  s.publish({ source: 'a', sourceVersion: 1 }, { source: 'a', sourceVersion: 2 })
  const c = consumerFor(s)
  const r1 = await c.replaySources({ sources: ['a'], limit: 1, maxRequests: 1, onFacts: () => {} })
  const fromStart = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { sources: { source: string; position: number }[] }
    const swapped = { ...body, sources: body.sources.map((x) => ({ ...x, position: 0 })) }
    return s.fetch(url, { ...init, body: JSON.stringify(swapped) })
  }) as unknown as typeof fetch
  await assert.rejects(
    consumerFor(s, { fetch: fromStart }).replaySources({ sources: ['a'], resume: r1.resume, onFacts: () => {} }),
    /did not ask for/,
  )
})

test('a response that advances no source stops the call instead of asking again forever', async () => {
  let n = 0
  const stuck = (async (_url: string, init: RequestInit) => {
    if (++n > 50) throw new Error('the client did not stop')
    const body = JSON.parse(String(init.body)) as { sources: { source: string; position: number }[] }
    const pages = body.sources.map(({ source, position }) => ({
      read: 1,
      project: 'acme',
      source,
      facts: [],
      cursor: { from: position, next: position, total: position + 1, hasMore: true },
      withheld: { type: 0, sensitivity: 0 },
      state: null,
    }))
    return new Response(JSON.stringify({ read: 1, project: 'acme', pages, deferred: [] }), { status: 200 })
  }) as unknown as typeof fetch
  await assert.rejects(
    consumerFor(fakeService(), { fetch: stuck, retries: 0 }).replaySources({ sources: ['a'], onFacts: () => {} }),
    /advanced no source/,
  )
})

test('a deferred source opens the next request even when another came before it in the list', async () => {
  // Page of 1 and budget of 2: a and b read one fact each, c and the rest are deferred.
  const s = fakeService({ budget: 2 })
  const sources = seventeen(s)
  await consumerFor(s).replaySources({ sources: sources, limit: 1, onFacts: () => {} })
  const batches = s.requests.filter((p) => p.route === 'batch')
  assert.deepEqual(batches[0]?.sources.slice(0, 3), ['user-a', 'user-b', 'user-c'])
  assert.equal(batches[1]?.sources[0], 'user-c')
})
