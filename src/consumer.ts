/**
 * The consumer: reads back the facts of your own project, by cursor.
 *
 * This is the other half of the boundary drawn in `docs/COLECOES-GENERICAS.md`
 * section 3. The hosted service is an ordered log with authentication and
 * isolation; it does not run anybody's reducer. The projection belongs to the
 * process that declared the collections, which is this one.
 *
 * So this client does exactly two things: it pulls facts in order, and it holds
 * back the ones that arrived ahead of a gap. It does not know what a fact means,
 * it has no collections of its own, and it names no domain. What you build on
 * top of it is yours — `examples/agora.ts` builds one graph; yours will differ.
 *
 * ORDER IS THE PART THAT LOOKS EASY AND IS NOT.
 *
 * The service hands over facts in LOG order, which is arrival order. A producer
 * that sends 1, then 4, then 2 and 3 produces a log that reads 1, 4, 2, 3. The
 * log position only ever grows, which is what makes it a usable cursor; the
 * price is that `sourceVersion` order has to be restored on this side.
 *
 * `replay` restores it: a fact whose `sourceVersion` sits ahead of a hole is
 * held, and it is released — together with anything else the hole was blocking —
 * the moment the hole closes. It is the same rule the service applies to its own
 * projection, and it has to be applied again here because the cursor cannot
 * reorder without ceasing to be a cursor.
 *
 * A held fact is not kept between calls. `ReplayResult.resume` points before
 * it and remembers what was released, so the next call reads it again and
 * releases it when its hole has closed (`resume.ts`).
 */

import { resolveCredential, type CredentialOptions } from './credential.ts'
import { RetickConfigError } from './errors.ts'
import { request, type HttpConfig } from './http.ts'
import { checkCheckpoint, ResumableOrder, type FloorLowered, type ReplayCheckpoint } from './resume.ts'
import type { Fact } from './types.ts'
import {
  toReadContract,
  toSourceReadState,
  type ReadContractWire,
  type ReadPageWire,
} from './wire.ts'

/** Version of the read contract this client speaks. */
export const READ_VERSION = 1

export const READ_ROUTES = Object.freeze({
  base: '/api/read/v1',
  contract: '/api/read/v1/contract',
  facts: '/api/read/v1/facts',
})

/** A fact as the reader receives it. Never the envelope, never the raw payload. */
export type ReadFact = {
  /**
   * Position in this source's log. This, and only this, is the cursor.
   *
   * Not `sourceVersion`: a producer's numbering can repeat — restart, resend,
   * backfill lowering the floor — and resuming by it would deliver a fact twice
   * or skip one. Position only grows.
   */
  position: number
  eventId: string
  source: string
  sourceVersion: number
  type: string
  entityType: string
  entityId: string | null
  schemaVersion: number
  occurredAt: string
  recordedAt: string
  /** The service's clock at receipt. Basis of freshness, and not the producer's. */
  observedAt: string
  payload: Record<string, unknown>
  provenance?: Fact['provenance']
  integrity?: Fact['integrity']
}

/** A closed interval of `sourceVersion` values that never arrived. */
export type ReadRange = { from: number; to: number }

export type SourceReadState = {
  source: string
  /** Cursor: how many facts this source's log has numbered. */
  position: number
  /** Last `sourceVersion` with the sequence intact since the floor. */
  contiguous: number
  highest: number
  gaps: ReadRange[]
  pending: number
  floor: number
  /** Typed as `string`: narrowing it would break the day a third origin appears. */
  floorOrigin: string
  durable: boolean
  shared: boolean
  damaged: boolean
  lastAt: string
  /** Age of the newest fact, computed by the service at response time. */
  freshnessSeconds: number | null
}

/** How many facts a page withheld, and why. A count, never the content. */
export type Withheld = {
  /** `entityType` outside this token's map. */
  type: number
  /** Marked above this token's sensitivity ceiling. */
  sensitivity: number
}

export type Page = {
  project: string
  source: string
  facts: ReadFact[]
  cursor: { from: number; next: number; total: number; hasMore: boolean }
  withheld: Withheld
  state: SourceReadState | null
  /** Untranslated body, for a field this client version does not yet name. */
  response: unknown
}

export type ReadContract = {
  read: number
  envelope: number
  token: { name: string; prefix: string; capabilities: string[]; expiresAt: string | null }
  scope: {
    project: string
    sources: string[]
    /** Payload keys visible per `entityType`. Knowing your own cut is in scope. */
    types: Record<string, string[]>
    provenance: boolean
    integrity: boolean
    maxSensitivity: string
  }
  limits: { factsPerPage: number }
  sources: SourceReadState[]
  response: unknown
}

export type ConsumerOptions = CredentialOptions & {
  /** Base URL of the service, without the `/api/read/v1` suffix. */
  url: string
  /**
   * The single Retick API key, `rt_...`, issued in the Console with the
   * `log:read` operation. This is the credential to use. Server-side only;
   * see `credential.ts`.
   */
  apiKey?: string
  /**
   * Legacy: an `rtl_...` read token from before the single key. Still accepted
   * by the service when its operator loads it (`RETICK_LEITURA_TOKENS`); the
   * Console no longer issues them. A publication token (`rtk_...`) is refused
   * here before any request.
   */
  token?: string
  timeoutMs?: number
  retries?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
  fetch?: typeof globalThis.fetch
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export type PullOptions = {
  source: string
  /** Resume point. `0`, the default, means from the beginning. */
  position?: number
  limit?: number
}

export type ReplayOptions = {
  source: string
  /**
   * Where the previous call stopped, exactly as it returned it in `resume`.
   * Omit both this and `position` to replay from the beginning.
   */
  resume?: ReplayCheckpoint
  /**
   * The 0.2.0 way to resume, kept so existing calls compile and behave as
   * before. It loses facts that were held behind a gap and drops versions that
   * lowered the floor; use `resume`. Passing both is refused.
   *
   * @deprecated Persist `ReplayResult.resume` and pass it back as `resume`.
   */
  position?: number
  limit?: number
  /**
   * Called once per batch of facts that are ready to apply, already in
   * `sourceVersion` order. Held facts are not passed until their hole closes.
   */
  onFacts: (facts: ReadFact[]) => void | Promise<void>
  /**
   * Stop after this many pages of log not read before. Pages that only read
   * again facts a previous call held do not count.
   */
  maxPages?: number
}

export type ReplayResult = {
  /**
   * Where the next call should start: persist it and pass it as `resume`. It
   * reads again any fact still held and remembers what was already released,
   * so nothing is delivered twice and nothing is skipped.
   */
  resume: ReplayCheckpoint
  /**
   * The log position after the last fact read. Not a safe place to resume
   * while `held > 0`, or across a gap or a lowered floor; it stays for code
   * written against 0.2.0. Use `resume`.
   */
  position: number
  applied: number
  /**
   * Facts received but still blocked by a hole. They are not kept between
   * calls: `resume.position` points before them, so the next call reads them
   * again.
   */
  held: number
  pages: number
  withheld: Withheld
  state: SourceReadState | null
  /**
   * Set when the source's floor moved down after facts above it had been
   * released (a backfill on a durable log). The versions between the new and
   * the old floor were then delivered after higher ones. If your projection
   * depends on order, rebuild it: a replay with neither `resume` nor `position`
   * delivers the whole source in `sourceVersion` order from the current floor.
   */
  floorLowered: FloorLowered | null
}

export type Consumer = {
  /** Your scope, the limits in force, and the cursor of each source you can see. */
  contract(): Promise<ReadContract>
  /** One page, raw and in log order. Gaps are yours to handle. */
  pull(options: PullOptions): Promise<Page>
  /**
   * Pulls until caught up, releasing facts in `sourceVersion` order.
   *
   * Deterministic: replaying the same log from the same checkpoint produces
   * the same sequence of `onFacts` payloads, whatever the page size.
   */
  replay(options: ReplayOptions): Promise<ReplayResult>
}

const DEFAULTS = { timeoutMs: 30_000, retries: 3, retryBaseDelayMs: 200, retryMaxDelayMs: 5_000 }

/**
 * Restores `sourceVersion` order over facts that arrive in log order.
 *
 * Exported because determinism is a property worth testing without a server,
 * and because the service's own projections use it. `replay()` does not: it
 * needs to resume, and this buffer only knows the floor it started from.
 *
 * The floor starts at the `sourceVersion` before the first fact seen, rather
 * than at zero. A producer does not have to start at 1 — the contract says the
 * first accepted fact of a pair sets the floor — and assuming 1 would make this
 * hold every fact forever against a hole that never existed.
 */
export class OrderedBuffer {
  #floor: number | null = null
  readonly #held = new Map<number, ReadFact>()

  get held(): number {
    return this.#held.size
  }

  /** Highest `sourceVersion` released so far. `null` before the first release. */
  get contiguous(): number | null {
    return this.#floor
  }

  /** Feeds log-ordered facts; returns those ready to apply, in order. */
  offer(facts: ReadFact[]): ReadFact[] {
    for (const f of facts) {
      if (this.#floor === null) this.#floor = f.sourceVersion - 1
      // A fact at or below the floor was already released. Duplicates are
      // normal — the producer resends after a timeout — and dropping them here
      // is what makes a repeated page harmless.
      if (f.sourceVersion <= this.#floor) continue
      this.#held.set(f.sourceVersion, f)
    }

    const pronto: ReadFact[] = []
    for (;;) {
      if (this.#floor === null) break
      const proximo = this.#held.get(this.#floor + 1)
      if (!proximo) break
      this.#held.delete(this.#floor + 1)
      this.#floor += 1
      pronto.push(proximo)
    }
    return pronto
  }
}

export function createConsumer(options: ConsumerOptions): Consumer {
  const url = (options.url ?? '').trim()
  if (url === '') throw new RetickConfigError('url is required')
  if (/\/api\/read\/v1\/?$/.test(url)) {
    throw new RetickConfigError(
      `url must not include the ${READ_ROUTES.base} suffix; the client appends it`,
    )
  }

  const token = resolveCredential(options, {
    factory: 'createConsumer',
    legacyPrefix: 'rtl_',
    // This entry point pages the RAW log. Never a browser.
    allowBrowser: false,
  })
  if (/^rtk_/.test(token)) {
    // Caught here rather than as a 401 from the server, because the message the
    // server can safely give is "malformed" and that sends people looking for a
    // typo instead of for the wrong token.
    throw new RetickConfigError(
      'this is a publication token; the read surface needs a read token (rtl_...) ' +
        'or an rt_ API key with the log:read operation',
    )
  }

  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new RetickConfigError('no fetch available; pass one in options.fetch')
  }

  const cfg: HttpConfig = {
    url,
    token,
    fetch: fetchImpl,
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    retries: options.retries ?? DEFAULTS.retries,
    retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULTS.retryBaseDelayMs,
    retryMaxDelayMs: options.retryMaxDelayMs ?? DEFAULTS.retryMaxDelayMs,
    sleep: options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
    random: options.random ?? Math.random,
  }

  async function pull(op: PullOptions): Promise<Page> {
    const q = new URLSearchParams({ source: op.source })
    if (op.position !== undefined) q.set('position', String(op.position))
    if (op.limit !== undefined) q.set('limit', String(op.limit))

    const { body } = await request<ReadPageWire>(
      cfg,
      'GET',
      `${READ_ROUTES.facts}?${q.toString()}`,
    )

    return {
      project: body.project,
      source: body.source,
      facts: (body.facts ?? []).map((f) => ({
        position: f.position,
        eventId: f.eventId,
        source: f.source,
        sourceVersion: f.sourceVersion,
        type: f.type,
        entityType: f.entityType,
        entityId: f.entityId,
        schemaVersion: f.schemaVersion,
        occurredAt: f.occurredAt,
        recordedAt: f.recordedAt,
        observedAt: f.observedAt,
        payload: f.payload,
        ...(f.provenance !== undefined ? { provenance: f.provenance } : {}),
        ...(f.integrity !== undefined ? { integrity: f.integrity } : {}),
      })),
      cursor: {
        from: body.cursor.from,
        next: body.cursor.next,
        total: body.cursor.total,
        hasMore: body.cursor.hasMore,
      },
      withheld: { type: body.withheld?.type ?? 0, sensitivity: body.withheld?.sensitivity ?? 0 },
      state: body.state ? toSourceReadState(body.state) : null,
      response: body,
    }
  }

  return {
    async contract(): Promise<ReadContract> {
      const { body } = await request<ReadContractWire>(
        cfg,
        'GET',
        READ_ROUTES.contract,
      )
      return toReadContract(body, body)
    },

    pull,

    async replay(op: ReplayOptions): Promise<ReplayResult> {
      if (op.resume !== undefined && op.position !== undefined) {
        throw new RetickConfigError('pass resume or position to replay(), not both')
      }
      const from = op.resume !== undefined ? checkCheckpoint(op.resume, op.source) : null
      // A bare position past 0 is the 0.2.0 resume. It keeps the 0.2.0 floor
      // rule, because the facts before that position are not read again and a
      // floor taken from the service would hold everything after them.
      const order = new ResumableOrder(op.source, from, {
        floorFromFirstFact: from === null && (op.position ?? 0) > 0,
      })
      const withheld: Withheld = { type: 0, sensitivity: 0 }
      let position = from ? from.position : (op.position ?? 0)
      let applied = 0
      let pages = 0
      // Pages that only read again what a previous call held do not count
      // against maxPages: otherwise a small maxPages behind a long hold would
      // reread the same facts on every call and never move.
      let newPages = 0
      const readTo = from?.readTo ?? 0
      let state: SourceReadState | null = null
      const teto = op.maxPages ?? 10_000

      const deliver = async (ready: ReadFact[]) => {
        if (ready.length === 0) return
        applied += ready.length
        await op.onFacts(ready)
      }

      for (;;) {
        const pagina = await pull({
          source: op.source,
          position,
          ...(op.limit !== undefined ? { limit: op.limit } : {}),
        })
        if (from !== null && pages === 0 && pagina.cursor.total < from.readTo) {
          // The log is shorter than what was already read: a log that did not
          // survive a restart, or a checkpoint from another service. Resuming
          // would silently skip whatever now sits below the checkpoint.
          throw new RetickConfigError(
            `resume was read up to position ${from.readTo}, past the end of source ${op.source}'s log ` +
              `(${pagina.cursor.total} facts); replay from the beginning without resume`,
          )
        }
        pages += 1
        if (position >= readTo) newPages += 1
        position = pagina.cursor.next
        state = pagina.state
        withheld.type += pagina.withheld.type
        withheld.sensitivity += pagina.withheld.sensitivity

        order.observeFloor(pagina.state?.floor)
        await deliver(order.offer(pagina.facts))

        if (!pagina.cursor.hasMore) {
          // Read to the end of the log as this response saw it: whatever the
          // service applied and this credential did not receive is settled.
          await deliver(order.settleUnseen(pagina.state?.contiguous))
          break
        }
        if (newPages >= teto) break
      }

      return {
        resume: order.checkpoint(position),
        position,
        applied,
        held: order.held,
        pages,
        withheld,
        state,
        floorLowered: order.floorLowered,
      }
    },
  }
}
