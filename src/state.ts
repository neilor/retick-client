/**
 * `StateReader`: the browser-side reader for the generic `state/v1` view
 * (browser contract §4 and §11).
 *
 * It reads the current state of a project's entities, cut by the credential:
 * exactly the sources the credential names, and nothing else. It never pulls
 * facts, never serves history, and keeps only the latest view in memory.
 *
 * The rules are the ones `createAgoraReader` already follows, and the two
 * readers share their public types (`Credentials`, `ReaderStatus`,
 * `RevocationOutcome`):
 *
 * - Nothing is persisted. Token and view live in memory.
 * - The token travels in the `Authorization` header and never in a URL, which
 *   is why the live path is NDJSON over `fetch` and not `EventSource`.
 * - A `401`, or an `end` line saying the session is over, renews the
 *   credential once. A renewed credential that is refused again stops the
 *   reader (`unauthorized`).
 * - One renewal is in flight per reader. When the snapshot and the stream learn
 *   at the same moment that the credential is dead, the host's `credentials()`
 *   is called once, and a late `401` about a token already replaced reuses the
 *   current one (A017, `ac15051`).
 * - `403` stops the reader. `429` and `5xx` back off with jitter, and `429`
 *   waits at least as long as `retry-after` says.
 * - `close()` forgets the credential here; `revoke()` ends the session at the
 *   service first, with one `DELETE`, and then forgets it.
 *
 * WHAT IS DIFFERENT FROM THE AGORA READER.
 *
 * Reasons are an English union (`StateReaderReason`), not free text. And a
 * renewed credential never resumes the stream with `since`: the new credential
 * may name different sources (a user who left a party), and the service sends
 * nothing for a `since` equal to its cursor, so resuming would keep showing the
 * old credential's view. The first line after a renewal is always a whole,
 * restarted view of the new credential's scope.
 */

import type { Credentials, ReaderStatus, RevocationOutcome } from './reader-session.ts'
import { API_KEY_FORMAT, isBrowser } from './credential.ts'
import { RetickConfigError, RetickError } from './errors.ts'

export const STATE_ROUTES = {
  session: '/api/browser/v1/session',
  snapshot: '/api/browser/v1/state',
  stream: '/api/browser/v1/state/stream',
} as const

export const STATE_VERSION = 'state/v1'

export type FieldProvenance = { source: string; sourceVersion: number; observedAt: string }

export type StateEntity = {
  fields: Record<string, unknown>
  provenance: Record<string, FieldProvenance>
  observedAt: string
}

export type SourceHealth = {
  applied: number
  held: number
  contiguousVersion: number | null
  lastObservedAt: string | null
}

/** Entity type → entity id → entity. Types, ids, field keys and source names are the customer's. */
export type StateView = {
  entities: Record<string, Record<string, StateEntity>>
  sources: Record<string, SourceHealth>
}

export type StateSnapshot = {
  version: 'state/v1'
  /**
   * Names this credential's view (contract §4.2). Opaque, compared for
   * equality only: it has no order and is not a log position. A server that
   * still sends a number has it converted to a string here.
   */
  cursor: string
  issuedAt: string
  restart: boolean
  /**
   * The credential's scope, echoed by the service. `allSources` is `true` only
   * for a session that covers the whole project (project delegation, #71), and
   * then `sources` is empty: read the sources from `state.sources`.
   */
  scope: { project: string; sources: string[]; allSources: boolean }
  state: StateView
}

export type StateReaderReason =
  /** The host's `credentials()` threw, or returned an API key inside a browser. */
  | 'no_credential'
  /** The request did not reach the service. */
  | 'network'
  /** `403`: `capability_missing` or `origin_refused`. The reader stops. */
  | 'forbidden'
  /** A renewed credential was refused too. The reader stops. */
  | 'session_closed'
  /** `429`. */
  | 'rate_limited'
  /** `5xx`, including `503 single_key_unavailable`. */
  | 'service_unavailable'
  /** The stream was open and the connection dropped. */
  | 'connection_lost'
  /** `close()` or `revoke()` ran here, or the service ended the stream because the session was logged out. */
  | 'closed'
  /** The service ended the stream because the session expired. */
  | 'expired'
  /** The service ended the stream because the credential was revoked. */
  | 'revoked'

export type StateFreshness = {
  status: ReaderStatus
  /**
   * How old the view is, in seconds, as last confirmed by the service: the
   * `issuedAt` of the latest state, or the time of the latest heartbeat on the
   * live stream that delivered it (the service sends a state line only when
   * the view changes, and heartbeats every 20 s otherwise).
   */
  ageSeconds: number | null
  /** When the reader last heard from the service. */
  lastContactAt: string | null
  /** Why the reader is not `live`. */
  reason: StateReaderReason | null
}

export type StateReaderOptions = {
  /** Base URL of the Retick service. */
  url: string
  /**
   * Browser path. Supplied by the host: usually a call to the app's own
   * backend, which authenticates its user, exchanges a short assertion at
   * `POST /api/browser/v1/session`, and returns `{ token, expiresAt }`. The
   * reader never learns where it comes from and never stores it.
   */
  credentials?: () => Promise<Credentials>
  /** Server path: an `rt_` key with the `state:read` operation. Refused in a browser. */
  apiKey?: string
  /** Floor between snapshot requests. Default 1000 ms. */
  minIntervalMs?: number
  /** Ceiling for reconnection backoff. Default 30000 ms. */
  maxBackoffMs?: number
  /** How long `revoke()` may hold its caller. Default 2000 ms. */
  revokeTimeoutMs?: number
  /** Injected for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
  /** Clock in epoch milliseconds. Injected for tests. */
  now?: () => number
}

export type StateReader = {
  /** Fetches the current view. Starts the live stream after the first success. */
  snapshot(): Promise<StateSnapshot>
  /** Called with every new view and every freshness change after the first view. Returns the unsubscribe. */
  subscribe(fn: (s: StateSnapshot, f: StateFreshness) => void): () => void
  freshness(): StateFreshness
  /** A snapshot request, unless one was made less than `minIntervalMs` ago. */
  refresh(): Promise<void>
  /** Forgets the credential here. Tells the service nothing. This is what unmounting calls. */
  close(): void
  /**
   * Ends the session at the service with one `DELETE /api/browser/v1/session`,
   * then forgets it here. Never throws. At most one request per reader, ever.
   * With an API key nothing is sent: keys are revoked in the Console.
   */
  revoke(): Promise<RevocationOutcome>
}

const DEFAULT_MIN_INTERVAL_MS = 1_000
const DEFAULT_MAX_BACKOFF_MS = 30_000
const DEFAULT_REVOKE_TIMEOUT_MS = 2_000
const NO_EXPIRY = '9999-12-31T23:59:59.999Z'
const TERMINAL: ReaderStatus[] = ['unauthorized', 'forbidden']
/** `end` reasons that name a session outcome; any other `end` reason is a key refusal. */
const END_REASONS = new Set<StateReaderReason>(['closed', 'expired', 'revoked'])

type Decision = 'ok' | 'renew' | 'stop' | 'back_off'

function decide(status: number, renewed: boolean): Decision {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 401) return renewed ? 'stop' : 'renew'
  if (status === 403) return 'stop'
  return 'back_off'
}

/** Accepts a state line, with a string cursor or a numeric one from an older server, and normalizes the cursor. */
function asStateSnapshot(o: Record<string, unknown>): StateSnapshot | null {
  if (o.version !== STATE_VERSION || typeof o.state !== 'object' || o.state === null) return null
  if (typeof o.cursor === 'string' && o.cursor !== '') return o as unknown as StateSnapshot
  if (typeof o.cursor === 'number') return { ...(o as unknown as StateSnapshot), cursor: String(o.cursor) }
  return null
}

export function createStateReader(options: StateReaderOptions): StateReader {
  if (options.apiKey !== undefined && options.credentials !== undefined) {
    throw new RetickConfigError('createStateReader: pass either apiKey or credentials, not both')
  }
  if (options.apiKey === undefined && options.credentials === undefined) {
    throw new RetickConfigError('createStateReader: apiKey or credentials is required')
  }
  let apiKey: string | null = null
  if (options.apiKey !== undefined) {
    apiKey = options.apiKey.trim()
    if (isBrowser()) {
      throw new RetickConfigError(
        'createStateReader: apiKey is a server credential and must not run in a browser. ' +
          'In a page, pass credentials: a function that asks your backend for a browser session (rtv_).',
      )
    }
    if (!API_KEY_FORMAT.test(apiKey)) {
      throw new RetickConfigError('createStateReader: apiKey must look like rt_<12 hex>_<secret>')
    }
  }

  const base = options.url.replace(/\/+$/, '')
  const now = options.now ?? Date.now
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const minInterval = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  const maxBackoff = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
  const revokeTimeout = options.revokeTimeoutMs ?? DEFAULT_REVOKE_TIMEOUT_MS
  const mint: () => Promise<Credentials> =
    apiKey === null
      ? (options.credentials as () => Promise<Credentials>)
      : async () => ({ token: apiKey as string, expiresAt: NO_EXPIRY })

  let credential: Credentials | null = null
  let pendingRenewal: Promise<Credentials | null> | null = null
  let latest: StateSnapshot | null = null
  /** Views applied so far. A snapshot overtaken by a stream line while in flight is not applied. */
  let applied = 0
  /** The token under which `latest` was read. A stream resumes with `since` only under the same token. */
  let latestToken: string | null = null
  let confirmedAt: number | null = null
  let status: ReaderStatus = 'idle'
  let reason: StateReaderReason | null = null
  let lastContact: number | null = null
  let closed = false
  let attempts = 0
  let retryAfterMs = 0
  let streamAbort: AbortController | null = null
  let supervisor: Promise<void> | null = null
  let lastFetch = Number.NEGATIVE_INFINITY
  let revocation: Promise<RevocationOutcome> | null = null
  const subscribers = new Set<(s: StateSnapshot, f: StateFreshness) => void>()

  function freshness(): StateFreshness {
    return {
      status,
      ageSeconds: confirmedAt === null ? null : Math.max(0, Math.round((now() - confirmedAt) / 1000)),
      lastContactAt: lastContact === null ? null : new Date(lastContact).toISOString(),
      reason,
    }
  }

  function announce(): void {
    if (!latest) return
    const f = freshness()
    for (const fn of subscribers) {
      try {
        fn(latest, f)
      } catch {
        /* a broken subscriber must not take the reader down */
      }
    }
  }

  function setStatus(s: ReaderStatus, r: StateReaderReason | null): void {
    status = s
    reason = r
    announce()
  }

  /**
   * Applies a whole view. Every line is the whole visible state, so applying
   * is replacing. The cursor only says whether this is the view already shown
   * (equality, never order): the same view under the same credential is not
   * announced again, but still counts as a fresh confirmation.
   */
  function apply(s: StateSnapshot, token: string): void {
    if (closed) return
    lastContact = now()
    const issued = Date.parse(s.issuedAt)
    const confirmed = Number.isFinite(issued) ? issued : now()
    if (latest !== null && latestToken === token && latest.cursor === s.cursor) {
      if (confirmedAt === null || confirmed > confirmedAt) confirmedAt = confirmed
      return
    }
    latest = s
    latestToken = token
    confirmedAt = confirmed
    applied += 1
    announce()
  }

  /**
   * The credential to send. `force` asks for a fresh one; `refused` is the one
   * a 401 or an `end` line was about. If that is no longer the current one,
   * another path already renewed, and its answer is reused.
   */
  async function currentCredential(force = false, refused?: Credentials): Promise<Credentials | null> {
    const c = credential
    const valid = c !== null && Date.parse(c.expiresAt) > now()
    if (valid && (!force || (refused !== undefined && c.token !== refused.token))) return c
    pendingRenewal ??= (async () => {
      try {
        const fresh = await mint()
        if (closed) return null
        if (apiKey === null && isBrowser() && API_KEY_FORMAT.test(fresh.token)) {
          // The host handed a server key to a page. Never send it.
          throw new RetickConfigError('credentials() returned an rt_ API key inside a browser')
        }
        credential = fresh
        return fresh
      } catch {
        credential = null
        if (!closed) setStatus('unauthorized', 'no_credential')
        return null
      } finally {
        pendingRenewal = null
      }
    })()
    return pendingRenewal
  }

  function request(path: string, c: Credentials, signal?: AbortSignal): Promise<Response> {
    return fetchImpl(`${base}${path}`, {
      headers: { authorization: `Bearer ${c.token}` },
      signal,
      credentials: 'omit',
    })
  }

  function backOffFor(r: Response): void {
    if (r.status === 429) {
      const seconds = Number(r.headers.get('retry-after'))
      retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
      setStatus('stale', 'rate_limited')
    } else {
      retryAfterMs = 0
      setStatus('stale', 'service_unavailable')
    }
  }

  async function fetchSnapshot(renewed = false, refused?: Credentials): Promise<StateSnapshot | null> {
    if (closed) return null
    lastFetch = now()
    const c = await currentCredential(renewed, refused)
    if (!c) return null
    const appliedBefore = applied
    let r: Response
    try {
      r = await request(STATE_ROUTES.snapshot, c)
    } catch {
      if (!closed) setStatus('offline', 'network')
      return null
    }
    if (closed) return null
    const d = decide(r.status, renewed)
    if (d === 'renew') return fetchSnapshot(true, c)
    if (d === 'stop') {
      setStatus(r.status === 403 ? 'forbidden' : 'unauthorized', r.status === 403 ? 'forbidden' : 'session_closed')
      return null
    }
    if (d === 'back_off') {
      backOffFor(r)
      return null
    }
    const body = asStateSnapshot((await r.json()) as Record<string, unknown>)
    if (closed) return null
    if (!body) {
      setStatus('stale', 'service_unavailable')
      return null
    }
    // Cursors have no order, so a snapshot cannot tell it is older than a
    // stream line that arrived while it was in flight. The stream's line wins.
    if (applied !== appliedBefore && latestToken === c.token && latest) return latest
    apply(body, c.token)
    return body
  }

  /**
   * One stream connection. Resolves when it ends. Returns the credential the
   * service said is over (an `end` line), so the next connection renews once
   * instead of spending a request to earn a 401.
   */
  async function openStream(renewed = false, refused?: Credentials): Promise<Credentials | null> {
    if (closed) return null
    const c = await currentCredential(renewed, refused)
    if (!c) return null
    streamAbort = new AbortController()
    const resume = latest !== null && latestToken === c.token
    const path = resume
      ? `${STATE_ROUTES.stream}?since=${encodeURIComponent((latest as StateSnapshot).cursor)}`
      : STATE_ROUTES.stream
    let r: Response
    try {
      r = await request(path, c, streamAbort.signal)
    } catch {
      if (!closed) setStatus('offline', 'network')
      return null
    }
    if (closed) return null
    const d = decide(r.status, renewed)
    if (d === 'renew') return openStream(true, c)
    if (d === 'stop') {
      setStatus(r.status === 403 ? 'forbidden' : 'unauthorized', r.status === 403 ? 'forbidden' : 'session_closed')
      return null
    }
    if (d === 'back_off' || !r.body) {
      backOffFor(r)
      return null
    }

    attempts = 0
    retryAfterMs = 0
    lastContact = now()
    setStatus('live', null)

    const reader = r.body.getReader()
    const utf8 = new TextDecoder()
    let rest = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done || closed) break
        rest += utf8.decode(value, { stream: true })
        const lines = rest.split('\n')
        rest = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          let o: Record<string, unknown>
          try {
            o = JSON.parse(line) as Record<string, unknown>
          } catch {
            continue
          }
          if (o.type === 'heartbeat') {
            lastContact = now()
            const at = typeof o.at === 'string' ? Date.parse(o.at) : Number.NaN
            // A heartbeat on the stream that delivered the view confirms it is unchanged up to `at`.
            if (latestToken === c.token && Number.isFinite(at) && (confirmedAt === null || at > confirmedAt)) {
              confirmedAt = at
            }
            continue
          }
          if (o.type === 'end') {
            const ended = o.reason as StateReaderReason
            // Announced before the renewal, so a host can say why the view paused.
            setStatus('stale', END_REASONS.has(ended) ? ended : 'session_closed')
            return c
          }
          const view = asStateSnapshot(o)
          if (view) apply(view, c.token)
        }
      }
      if (!closed) setStatus('offline', 'connection_lost')
    } catch {
      if (!closed) setStatus('offline', 'connection_lost')
    } finally {
      void reader.cancel().catch(() => {})
    }
    return null
  }

  function backoff(): number {
    const ceiling = Math.min(maxBackoff, 500 * 2 ** Math.min(attempts, 6))
    const jittered = Math.round(ceiling / 2 + Math.random() * (ceiling / 2))
    return Math.max(jittered, retryAfterMs)
  }

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  async function supervise(): Promise<void> {
    let endedFor: Credentials | null = null
    while (!closed) {
      const afterEnd = endedFor !== null
      endedFor = endedFor ? await openStream(true, endedFor) : await openStream()
      if (closed || TERMINAL.includes(status)) return
      if (endedFor && !afterEnd) {
        // The service ended the session: reconnect at once with a renewed credential.
        continue
      }
      // A renewed credential whose stream was ended again, or any other drop: back off.
      // Without this, a host minting sessions the service keeps ending would loop with no pause.
      attempts += 1
      if (status === 'live') setStatus('offline', 'connection_lost')
      await sleep(backoff())
    }
  }

  function forget(): void {
    closed = true
    streamAbort?.abort()
    subscribers.clear()
    credential = null
    status = 'idle'
    reason = 'closed'
  }

  async function revokeOnce(): Promise<RevocationOutcome> {
    const c = credential
    closed = true
    streamAbort?.abort()
    if (!c || apiKey !== null) {
      forget()
      return 'nothing-to-revoke'
    }
    const stop = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'unreachable'>((resolve) => {
      timer = setTimeout(() => {
        stop.abort()
        resolve('unreachable')
      }, revokeTimeout)
    })
    try {
      const r = await Promise.race([
        fetchImpl(`${base}${STATE_ROUTES.session}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${c.token}` },
          signal: stop.signal,
          credentials: 'omit',
        }),
        timeout,
      ])
      if (r === 'unreachable') return 'unreachable'
      if (r.status >= 200 && r.status < 300) return 'revoked'
      if (r.status === 401) return 'already-closed'
      return 'refused'
    } catch {
      return 'unreachable'
    } finally {
      clearTimeout(timer)
      forget()
    }
  }

  return {
    async snapshot(): Promise<StateSnapshot> {
      const s = await fetchSnapshot()
      if (s) {
        if (!supervisor && !closed) supervisor = supervise()
        return s
      }
      if (latest) return latest
      throw new RetickError(`createStateReader: no view (${reason ?? 'unknown'})`)
    },

    subscribe(fn): () => void {
      subscribers.add(fn)
      if (latest) {
        try {
          fn(latest, freshness())
        } catch {
          /* subscriber's problem */
        }
      }
      return () => subscribers.delete(fn)
    },

    freshness,

    async refresh(): Promise<void> {
      if (now() - lastFetch < minInterval) return
      await fetchSnapshot()
    },

    close(): void {
      forget()
    },

    revoke(): Promise<RevocationOutcome> {
      revocation ??= revokeOnce()
      return revocation
    },
  }
}
