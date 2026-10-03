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

export { API_KEY_FORMAT, isBrowser } from './credential.ts'
export type { CredentialOptions } from './credential.ts'

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

export { AGORA_ROUTES, STATE_ROUTES, createAgoraReader } from './agora.ts'
export type {
  AgoraReader,
  AgoraReaderOptions,
  AgoraSnapshot,
  Credentials,
  Freshness,
  ReaderStatus,
  ReaderView,
  RevocationOutcome,
  StateEntity,
  StateView,
} from './agora.ts'

/**
 * The third port: the control plane. Workspaces, projects, environments,
 * sources, usage, API-key metadata and data credentials — never a secret read
 * back, because no route returns one. Added under `D-20260923-007`, when the
 * CLI and the MCP server both needed it and neither could own it.
 */
export {
  createControlPlane,
  controlKeyFamily,
  RetickContractError,
  CONTROL_BASE,
  CONTROL_KEY_PREFIX,
  CONTROL_KEY_PREFIXES,
  CONTROL_ROUTES,
  CONTROL_VERSION,
} from './control.ts'
export type {
  ApiKeyEvent,
  ApiKeyMetadata,
  Capability,
  ControlKeyFamily,
  ControlPlane,
  ControlPlaneOptions,
  DataCredentialMetadata,
  Environment,
  IssuedDataCredential,
  Operation,
  Project,
  ProjectKeyMetadata,
  Source,
  Usage,
  WhoAmI,
  Workspace,
} from './control.ts'
