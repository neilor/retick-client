/**
 * The v1 contract, in English, as an external producer sees it.
 *
 * WHY THESE TYPES ARE DECLARED AGAIN INSTEAD OF IMPORTED.
 *
 * `src/contrato/v1.ts` already declares the frozen contract, and importing it
 * would be the obvious move. It would also drag the whole service into this
 * package: that module imports `src/ingestao/api.ts`, which imports
 * `node:http`, the project registry and the token vault. A producer that
 * installs a client to speak HTTP would end up with the server it is speaking
 * to.
 *
 * So the declaration is duplicated on purpose, exactly the way the route and
 * `src/contrato/v1.ts` already duplicate each other, and for the same reason:
 * `test/sdk-contrato.test.ts` confronts the two field lists, and it fails when
 * they drift. A required field added to the service without this file changing
 * is the change that breaks every existing producer, and it is the change the
 * test exists to make loud.
 *
 * CHANGE RULE, inherited from `docs/CONTRATO-V1.md` section 7: adding an
 * optional field here is compatible. Making a field required, removing one,
 * narrowing a type or changing a meaning is not, and needs envelope 2.
 */

// --------------------------------------------------------------- what you send

/**
 * A fact as the producer writes it.
 *
 * This is not the envelope. The envelope is the internal format, and three of
 * its fields are not the producer's to choose: `tenant` comes from the token,
 * `observedAt` comes from the service clock, and `envelope` is the version of
 * the shell. See {@link DEFINED_BY_RETICK}.
 */
export type Fact = {
  /** Identity of the fact at the origin. Deduplication key, together with `source`. */
  eventId: string
  /** Origin label. Must be one of the sources the token is scoped to. */
  source: string
  /**
   * Non-negative integer, monotonic PER SOURCE — not per project.
   *
   * It does not have to start at 1: the first accepted fact of a
   * (project, source) pair sets the floor at `sourceVersion - 1`.
   *
   * The client never generates this. Numbering belongs to the origin, and a
   * client that invented it would be a second authority over order.
   */
  sourceVersion: number
  /** Kind of fact. Opaque to Retick: it orders and stores, it does not interpret. */
  type: string
  /** Which collection the projection updates. See `projected` on the outcome. */
  entityType: string
  /** ISO 8601. When the fact happened, according to the origin. */
  occurredAt: string
  entityId?: string | null
  /** ISO 8601. When the origin recorded it. Absent falls back to `occurredAt`. */
  recordedAt?: string
  /**
   * Version of the shape of `payload`, declared by the producer. Absent means 1.
   *
   * Versions the CONTENT, while `envelope` versions the SHELL.
   */
  schemaVersion?: number
  /**
   * Declared optional by the contract and REQUIRED IN PRACTICE today.
   *
   * This is divergence 17 in `docs/DIVERGENCIAS.md`: `GET /api/v1/contrato`
   * lists `payload` as optional and the route rejects a fact that arrives
   * without it. The type follows the declared contract rather than the current
   * behaviour, because the fix is one line and strictly widening, and a client
   * typed against the narrower behaviour would have to change the day it lands.
   *
   * Until then, send an object. `test/contract.test.ts` freezes the rejection.
   */
  payload?: Record<string, unknown>
  provenance?: Provenance
  integrity?: Integrity
}

/** Who, where and through what. Every field optional, none of them checked. */
export type Provenance = {
  actor?: string | null
  actorHandle?: string | null
  machine?: string | null
  machineKey?: string | null
  session?: string | null
  client?: string | null
}

/** The origin's own hash chain, when it keeps one. Retick stores, never verifies. */
export type Integrity = {
  hash?: string | null
  prevHash?: string | null
}

// ------------------------------------------------------------ what comes back

/**
 * What happened to one fact.
 *
 * Exactly five values, and the list is frozen. A sixth is additive on paper and
 * breaks in practice, because every producer that switched over the five stops
 * being exhaustive. See `docs/CONTRATO-V1.md` section 5.
 */
export type FactStatus = 'accepted' | 'duplicate' | 'stale' | 'pending' | 'rejected'

export type FactOutcome = {
  /**
   * Position in the array handed to `publish()`, not in the batch that carried
   * it. The client splits into batches and maps the indices back, so a producer
   * never has to know that splitting happened.
   */
  index: number
  eventId: string | null
  status: FactStatus
  /** Why it was rejected. Only present when the service gave a reason. */
  reason?: string
  /** `false` when the fact went in but its `entityType` has no reducer yet. */
  projected?: boolean
}

/** One projection change caused by the batch you just sent. Echo, never a read. */
export type Change = {
  collection: string
  id: string
  seq: number
  fact: string
  at: string
  origin: string
  value: unknown
}

/** A closed interval of `sourceVersion` values that never arrived. */
export type Range = { from: number; to: number }

/**
 * What the service is asking you to send again.
 *
 * This is the only recovery mechanism and it is push: Retick states what it is
 * missing inside a response the producer was already going to read, and the
 * producer decides whether to rewind. No credential of the origin exists on
 * the Retick side.
 */
export type ResendSuggestion = { from: number; to: number; reason: string }

/** Cursor and health of one (project, source) pair. Never the content of a fact. */
export type SourceState = {
  project: string
  source: string
  /** Last `sourceVersion` with the sequence intact since the floor. */
  contiguous: number
  /** Highest `sourceVersion` seen, intact or not. */
  highest: number
  gaps: Range[]
  pending: number
  facts: number
  /** Current floor of this pair. */
  floor: number
  firstAt: string
  lastAt: string
  /** `false` when nothing from this source survives a restart. */
  durable: boolean
  /** `false` when another instance would not see what this source received. */
  shared: boolean
  /**
   * How the floor was set. Typed as `string` on purpose: narrowing it to a
   * union of literals would stop a producer's code from compiling the day the
   * service adds a third origin, and `docs/SDK-TYPESCRIPT.md` section 5 calls
   * that an incompatible change.
   */
  floorOrigin: string
  floorSetAt: string
  /** Closed by a write failure: accepts nothing until the process comes back up. */
  damaged: boolean
  /** How many times the floor of this pair was lowered to fit a backfill. */
  demotions: number
  /** Position in the shared log that this instance has already applied. */
  logSeq: number
  resendSuggestion: ResendSuggestion | null
}

export type PublishResult = {
  /** Project of the token. You did not declare it; this is which one you used. */
  project: string
  received: number
  accepted: number
  duplicates: number
  stale: number
  pending: number
  rejected: number
  /** One outcome per fact, in the order you passed them. */
  outcomes: FactOutcome[]
  /** What the projection changed because of these facts. */
  changes: Change[]
  /** Cursor of every source these facts touched. Never another project's. */
  sources: SourceState[]
  /** How many HTTP requests this took. One per batch. */
  batches: number
  /**
   * The untranslated bodies, one per batch, in the order they were sent.
   *
   * An escape hatch with a specific job. `docs/CONTRATO-V1.md` section 7 makes
   * a new field in the response a compatible change, which means the service
   * can grow fields this client version does not know how to name. Without
   * this, reading one of them would require a client upgrade for a change that
   * was designed not to require one.
   */
  responses: unknown[]
}

export type Limits = {
  /** Bytes of the request body. */
  bodyBytes: number
  /** Facts per batch. */
  factsPerBatch: number
  /** Bytes of one fact's payload, already serialized. */
  payloadBytes: number
}

/** What `GET /api/v1/contrato` says about you: your scope and your cursor. */
export type Contract = {
  envelope: number
  token: {
    name: string
    prefix: string
    /** Typed as `string[]` rather than a union, for the reason in `floorOrigin`. */
    capabilities: string[]
    expiresAt: string | null
  }
  scope: { project: string; sources: string[] }
  limits: Limits
  required: string[]
  optional: string[]
  definedByRetick: Record<string, string>
  /**
   * Whether what you publish survives a restart of this service, and whether
   * more than one instance sees the same state.
   *
   * `shared: false` matters concretely: two consecutive requests can land on
   * different instances and return different cursors, and the
   * `resendSuggestion` of one does not know what the other received.
   */
  durability: { durable: boolean; shared: boolean }
  /** State of this project's sources. Cursor, never fact content. */
  sources: SourceState[]
  /** The untranslated body. Same reason as `PublishResult.responses`. */
  response: unknown
}

// --------------------------------------------------------------- what is frozen

/** Envelope version this client speaks. A 1.x client speaks envelope 1. */
export const ENVELOPE_VERSION = 1

export const ROUTES = Object.freeze({
  base: '/api/v1',
  publish: '/api/v1/fatos',
  contract: '/api/v1/contrato',
})

/** Missing any of these rejects that one fact; the rest of the batch goes on. */
export const REQUIRED_FIELDS = Object.freeze([
  'eventId',
  'source',
  'sourceVersion',
  'type',
  'entityType',
  'occurredAt',
] as const)

export const OPTIONAL_FIELDS = Object.freeze([
  'entityId',
  'recordedAt',
  'schemaVersion',
  'payload',
  'provenance',
  'integrity',
] as const)

/** The body does not declare which project it writes to. That comes from the token. */
export const FORBIDDEN_FIELDS = Object.freeze(['tenant', 'project', 'projeto'] as const)

export const DEFINED_BY_RETICK = Object.freeze({
  tenant: 'comes from the token; the body cannot declare a project',
  observedAt: 'this service clock, at the moment of receipt',
})

/** The five, in the frozen order. */
export const FACT_STATUSES = Object.freeze([
  'accepted',
  'duplicate',
  'stale',
  'pending',
  'rejected',
] as const)

/** Deduplication key, written in the order the core assembles it. */
export const DEDUPLICATION_KEY = Object.freeze(['source', 'tenant', 'sourceId'] as const)

/** Order domain: each pair has its own cursor and its own floor. */
export const ORDER_DOMAIN = Object.freeze(['project', 'source'] as const)

/** The only capability that exists today, and that is deliberate. */
export const CAPABILITY_PUBLISH = 'fatos.publicar'

/**
 * The limits in force, as constants.
 *
 * The client batches against these. An operator can configure the service
 * lower; `contract().limits` reports what the service actually enforces, and
 * `createProducer` takes overrides. See the README.
 */
export const LIMITS: Limits = Object.freeze({
  bodyBytes: 1_048_576,
  factsPerBatch: 500,
  payloadBytes: 65_536,
})

/** Response codes that are part of the contract. */
export const CODES = Object.freeze({
  ok: 200,
  partial: 422,
  invalidBody: 400,
  noCredential: 401,
  noCapability: 403,
  wrongMethod: 405,
  tooLarge: 413,
  noVault: 503,
  sourceClosed: 503,
})
