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
 */

import { RetickConfigError } from './errors.ts'
import { request, type HttpConfig } from './http.ts'
import type { Fact } from './types.ts'
import {
  toReadContract,
  toSourceReadState,
  type PaginaDeLeituraWire,
  type RespostaDeContratoDeLeituraWire,
} from './wire.ts'

/** Version of the read contract this client speaks. */
export const READ_VERSION = 1

export const READ_ROUTES = Object.freeze({
  base: '/api/leitura/v1',
  contract: '/api/leitura/v1/contrato',
  facts: '/api/leitura/v1/fatos',
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

export type ConsumerOptions = {
  /** Base URL of the service, without the `/api/leitura/v1` suffix. */
  url: string
  /** `rtl_...`. A publication token (`rtk_...`) is refused by format. */
  token: string
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
  position?: number
  limit?: number
  /**
   * Called once per batch of facts that are ready to apply, already in
   * `sourceVersion` order. Held facts are not passed until their hole closes.
   */
  onFacts: (facts: ReadFact[]) => void | Promise<void>
  /** Stop after this many pages. Guards against an unbounded loop in a test. */
  maxPages?: number
}

export type ReplayResult = {
  /** Where to resume. Safe to persist and hand back as `position`. */
  position: number
  applied: number
  /** Facts received but still blocked by a hole. They stay in the client. */
  held: number
  pages: number
  withheld: Withheld
  state: SourceReadState | null
}

export type Consumer = {
  /** Your scope, the limits in force, and the cursor of each source you can see. */
  contract(): Promise<ReadContract>
  /** One page, raw and in log order. Gaps are yours to handle. */
  pull(options: PullOptions): Promise<Page>
  /**
   * Pulls until caught up, releasing facts in `sourceVersion` order.
   *
   * Deterministic: replaying the same log from the same position produces the
   * same sequence of `onFacts` payloads, whatever the page size.
   */
  replay(options: ReplayOptions): Promise<ReplayResult>
}

const DEFAULTS = { timeoutMs: 30_000, retries: 3, retryBaseDelayMs: 200, retryMaxDelayMs: 5_000 }

/**
 * Restores `sourceVersion` order over facts that arrive in log order.
 *
 * Exported because determinism is a property worth testing without a server.
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
  if (/\/api\/leitura\/v1\/?$/.test(url)) {
    throw new RetickConfigError(
      `url must not include the ${READ_ROUTES.base} suffix; the client appends it`,
    )
  }

  const token = (options.token ?? '').trim()
  if (token === '') throw new RetickConfigError('token is required')
  if (/^rtk_/.test(token)) {
    // Caught here rather than as a 401 from the server, because the message the
    // server can safely give is "malformed" and that sends people looking for a
    // typo instead of for the wrong token.
    throw new RetickConfigError(
      'this is a publication token; the read surface needs a read token (rtl_...)',
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
    const q = new URLSearchParams({ fonte: op.source })
    if (op.position !== undefined) q.set('posicao', String(op.position))
    if (op.limit !== undefined) q.set('limite', String(op.limit))

    const { body } = await request<PaginaDeLeituraWire>(
      cfg,
      'GET',
      `${READ_ROUTES.facts}?${q.toString()}`,
    )

    return {
      project: body.projeto,
      source: body.fonte,
      facts: (body.fatos ?? []).map((f) => ({
        position: f.posicao,
        eventId: f.eventId,
        source: f.fonte,
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
        from: body.cursor.de,
        next: body.cursor.proxima,
        total: body.cursor.total,
        hasMore: body.cursor.haMais,
      },
      withheld: { type: body.omitidos?.tipo ?? 0, sensitivity: body.omitidos?.classe ?? 0 },
      state: body.estado ? toSourceReadState(body.estado) : null,
      response: body,
    }
  }

  return {
    async contract(): Promise<ReadContract> {
      const { body } = await request<RespostaDeContratoDeLeituraWire>(
        cfg,
        'GET',
        READ_ROUTES.contract,
      )
      return toReadContract(body, body)
    },

    pull,

    async replay(op: ReplayOptions): Promise<ReplayResult> {
      const buffer = new OrderedBuffer()
      const withheld: Withheld = { type: 0, sensitivity: 0 }
      let position = op.position ?? 0
      let applied = 0
      let pages = 0
      let state: SourceReadState | null = null
      const teto = op.maxPages ?? 10_000

      for (;;) {
        const pagina = await pull({
          source: op.source,
          position,
          ...(op.limit !== undefined ? { limit: op.limit } : {}),
        })
        pages += 1
        position = pagina.cursor.next
        state = pagina.state
        withheld.type += pagina.withheld.type
        withheld.sensitivity += pagina.withheld.sensitivity

        const prontos = buffer.offer(pagina.facts)
        if (prontos.length > 0) {
          applied += prontos.length
          await op.onFacts(prontos)
        }

        if (!pagina.cursor.hasMore || pages >= teto) break
      }

      return { position, applied, held: buffer.held, pages, withheld, state }
    },
  }
}
