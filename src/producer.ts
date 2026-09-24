/**
 * The producer: the two things an external project needs to do with Retick.
 *
 * `publish(facts)` and `contract()`. There is no third method, and the reason
 * is not minimalism for its own sake — `docs/CONTRATO-V1.md` section 1 says the
 * v1 contract has two routes and no third one. A client with more methods than
 * the contract has routes would be inventing a surface that the service cannot
 * honour.
 *
 * WHAT THIS CLIENT DELIBERATELY DOES NOT DO.
 *
 * It does not generate `sourceVersion`. Numbering belongs to the origin; a
 * client that generated it would be a second authority over order, and the two
 * would disagree the first time a process restarted.
 *
 * It does not add an idempotency header. Idempotency in v1 is structural —
 * the key is `(source, tenant, eventId)` and it is already in the fact. A
 * header would be a second, weaker key that the service does not read.
 *
 * It does not validate facts before sending. The service decides what it
 * accepts, and `docs/SDK-TYPESCRIPT.md` section 5 is explicit that refusing
 * more is never a compatible change. A client that pre-rejected would keep
 * rejecting after the service learned to accept.
 *
 * It does not write the token anywhere. It is held in the closure, sent in an
 * `Authorization` header, and only its prefix ever appears in an error.
 */

import { RetickConfigError } from './errors.ts'
import { request, type HttpConfig } from './http.ts'
import {
  LIMITS,
  ROUTES,
  type Contract,
  type Fact,
  type FactOutcome,
  type FactStatus,
  type Limits,
  type PublishResult,
  type SourceState,
} from './types.ts'
import {
  toChange,
  toContract,
  toOutcome,
  toSourceState,
  type RespostaDeContratoWire,
  type RespostaDePublicacaoWire,
} from './wire.ts'

export type ProducerOptions = {
  /** Base URL of the service, without the `/api/v1` suffix. */
  url: string
  /** `rtk_...`. Held in memory only. */
  token: string
  /** Per request, covering the answer and its body. Default 30000. */
  timeoutMs?: number
  /** Extra attempts after the first, for the failures worth repeating. Default 3. */
  retries?: number
  /** First backoff ceiling, doubling per attempt. Default 200. */
  retryBaseDelayMs?: number
  /** Cap on the backoff ceiling. Default 5000. */
  retryMaxDelayMs?: number
  /**
   * Batching limits. Defaults to {@link LIMITS}, the values the contract
   * declares. An operator can configure the service lower; `contract().limits`
   * reports what it actually enforces, and this is where you match it.
   */
  limits?: Partial<Limits>
  /** For a test, a proxy agent, or a runtime whose `fetch` is not global. */
  fetch?: typeof globalThis.fetch
  /** Injectable so a test does not spend real seconds in backoff. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable so a test can pin the jitter. */
  random?: () => number
}

export type Producer = {
  /**
   * Sends facts, splitting into batches that respect the contract's limits.
   *
   * Batches go out one at a time, in order. That is not an oversight about
   * throughput: order matters to the service, and a fact that arrives ahead of
   * a missing `sourceVersion` comes back `pending` and waits. Sending batch 3
   * while batch 2 is still in flight would manufacture the very gap the
   * ordering guarantee exists to close.
   *
   * Does not throw on `422`. A rejected fact is a result, not a failure: the
   * rest of the batch went in, and resending the same bytes would be rejected
   * the same way. Read `outcomes` and `rejected`.
   *
   * Throws on everything the service refused outright — see `errors.ts`.
   */
  publish(facts: Fact[]): Promise<PublishResult>

  /** Your own scope, the limits in force, and the cursor of each of your sources. */
  contract(): Promise<Contract>
}

const DEFAULTS = {
  timeoutMs: 30_000,
  retries: 3,
  retryBaseDelayMs: 200,
  retryMaxDelayMs: 5_000,
}

/** `{"fatos":[]}` — the bytes a batch costs before any fact is in it. */
const BATCH_OVERHEAD_BYTES = 12

/** `TextEncoder` and not `Buffer`: this package assumes a `fetch`, not a Node. */
const encoder = new TextEncoder()

type Batch = { offset: number; body: string }

/**
 * Splits serialized facts into bodies that fit both limits.
 *
 * A fact too large to share a body with anything gets a batch of its own and
 * the service answers `413` for it. Splitting it further is not possible and
 * refusing it here is not this client's call: the limit belongs to the service,
 * an operator can raise it, and a client that enforced its own copy would keep
 * refusing after the raise.
 */
export function splitIntoBatches(facts: Fact[], limits: Limits): Batch[] {
  const batches: Batch[] = []
  let offset = 0
  let parts: string[] = []
  let bytes = BATCH_OVERHEAD_BYTES

  const flush = (): void => {
    if (parts.length === 0) return
    batches.push({ offset, body: `{"fatos":[${parts.join(',')}]}` })
    offset += parts.length
    parts = []
    bytes = BATCH_OVERHEAD_BYTES
  }

  for (const fact of facts) {
    const part = JSON.stringify(fact)
    const partBytes = encoder.encode(part).length
    const comma = (): number => (parts.length > 0 ? 1 : 0)
    if (
      parts.length > 0 &&
      (parts.length >= limits.factsPerBatch || bytes + comma() + partBytes > limits.bodyBytes)
    ) {
      flush()
    }
    // Recomputed after the flush on purpose: the separator only exists when
    // something is already in the batch, and the batch may have just emptied.
    bytes += comma() + partBytes
    parts.push(part)
  }
  flush()

  return batches
}

function count(outcomes: FactOutcome[], status: FactStatus): number {
  return outcomes.reduce((n, o) => (o.status === status ? n + 1 : n), 0)
}

export function createProducer(options: ProducerOptions): Producer {
  const url = (options.url ?? '').trim()
  if (url === '') throw new RetickConfigError('url is required')
  if (/\/api\/v1\/?$/.test(url)) {
    // Caught here rather than as a 404 three calls later, because the wrong
    // base URL produces `/api/v1/api/v1/fatos` and the answer to that is a
    // proxy's 404, which says nothing about what went wrong.
    throw new RetickConfigError(
      `url must not include the ${ROUTES.base} suffix; the client appends it`,
    )
  }

  const token = (options.token ?? '').trim()
  if (token === '') throw new RetickConfigError('token is required')

  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new RetickConfigError('no fetch available; pass one in options.fetch')
  }

  const limits: Limits = { ...LIMITS, ...options.limits }

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

  return {
    async publish(facts: Fact[]): Promise<PublishResult> {
      // Publishing nothing makes no request. The service answers `400` to an
      // empty batch and that rule is untouched for anyone who sends one; this
      // is one layer up, where zero facts simply produce zero batches.
      if (facts.length === 0) {
        return {
          project: '',
          received: 0,
          accepted: 0,
          duplicates: 0,
          stale: 0,
          pending: 0,
          rejected: 0,
          outcomes: [],
          changes: [],
          sources: [],
          batches: 0,
          responses: [],
        }
      }

      const batches = splitIntoBatches(facts, limits)
      const outcomes: FactOutcome[] = []
      const changes: PublishResult['changes'] = []
      const responses: unknown[] = []
      // Keyed by `project/source`, last write wins: the later batch carries the
      // later cursor, and a stale cursor is the one thing worse than none.
      const sources = new Map<string, SourceState>()
      let project = ''

      for (const batch of batches) {
        const { body } = await request<RespostaDePublicacaoWire>(
          cfg,
          'POST',
          ROUTES.publish,
          batch.body,
        )
        responses.push(body)
        project = body.projeto ?? project
        for (const r of body.resultados ?? []) outcomes.push(toOutcome(r, batch.offset))
        for (const m of body.mudancas ?? []) changes.push(toChange(m))
        for (const f of body.fontes ?? []) {
          const state = toSourceState(f)
          sources.set(`${state.project}/${state.source}`, state)
        }
      }

      outcomes.sort((a, b) => a.index - b.index)

      return {
        project,
        received: facts.length,
        accepted: count(outcomes, 'accepted'),
        duplicates: count(outcomes, 'duplicate'),
        stale: count(outcomes, 'stale'),
        pending: count(outcomes, 'pending'),
        rejected: count(outcomes, 'rejected'),
        outcomes,
        changes,
        sources: [...sources.values()].sort((a, b) => a.source.localeCompare(b.source)),
        batches: batches.length,
        responses,
      }
    },

    async contract(): Promise<Contract> {
      const { body } = await request<RespostaDeContratoWire>(cfg, 'GET', ROUTES.contract)
      return toContract(body, body)
    },
  }
}
