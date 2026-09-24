/**
 * A minimal TypeScript client for the Retick v1 publication gate.
 *
 * Two calls, because the contract has two routes:
 *
 * ```ts
 * import { createProducer } from '@retick/client'
 *
 * const producer = createProducer({ url: 'https://retick.example', token: process.env.RETICK_TOKEN! })
 *
 * const result = await producer.publish([fact, fact, fact])
 * const contract = await producer.contract()
 * ```
 *
 * The boundary this package sits on is drawn in `docs/SDK-TYPESCRIPT.md`: the
 * core does not know about the network, and this is the layer that knows there
 * is a service on the other end of a wire. It carries no core, no Firebase and
 * no Exo — it speaks HTTP to a contract and nothing else.
 *
 * What is frozen and what is not is in `docs/CONTRATO-V1.md`. The short
 * version: envelope 1, six required fields, five fact statuses, and a
 * deduplication key of `(source, tenant, eventId)` that makes resending safe.
 */

export { createProducer, splitIntoBatches } from './producer.ts'
export type { Producer, ProducerOptions } from './producer.ts'

export {
  RetickAuthError,
  RetickConfigError,
  RetickError,
  RetickHttpError,
  RetickNetworkError,
  RetickRequestError,
  RetickServerError,
  RetickSourceClosedError,
  RetickTimeoutError,
} from './errors.ts'

export {
  CAPABILITY_PUBLISH,
  CODES,
  DEDUPLICATION_KEY,
  DEFINED_BY_RETICK,
  ENVELOPE_VERSION,
  FACT_STATUSES,
  FORBIDDEN_FIELDS,
  LIMITS,
  OPTIONAL_FIELDS,
  ORDER_DOMAIN,
  REQUIRED_FIELDS,
  ROUTES,
} from './types.ts'

export type {
  Change,
  Contract,
  Fact,
  FactOutcome,
  FactStatus,
  Integrity,
  Limits,
  Provenance,
  PublishResult,
  Range,
  ResendSuggestion,
  SourceState,
} from './types.ts'

export { createConsumer, OrderedBuffer, READ_ROUTES, READ_VERSION } from './consumer.ts'
export type {
  Consumer,
  ConsumerOptions,
  Page,
  PullOptions,
  ReadContract,
  ReadFact,
  ReadRange,
  ReplayOptions,
  ReplayResult,
  SourceReadState,
  Withheld,
} from './consumer.ts'

export { AGORA_ROUTES, createAgoraReader } from './agora.ts'
export type {
  AgoraReader,
  AgoraReaderOptions,
  AgoraSnapshot,
  Credentials,
  Freshness,
  ReaderStatus,
  RevocationOutcome,
} from './agora.ts'
