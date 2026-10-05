/**
 * The English wire format of `/api/v1/facts`, `/api/v1/contract` and
 * `/api/read/v1`, and the
 * small step from it to the types this package exports.
 *
 * The English routes already speak the names in `types.ts` and `consumer.ts`,
 * so most of this file is a shape check plus the untranslated body for
 * `response`. Two things are still checked here instead of trusted:
 *
 *  - `status`: exactly the five frozen values. A sixth means the service speaks
 *    a newer contract, and failing loudly beats switching over an unknown case.
 *  - missing arrays: an older or partial body without `gaps` or `sources`
 *    reads as empty instead of throwing deep inside a producer.
 *
 * The legacy Portuguese publish and read routes are no longer spoken by this
 * package. They keep serving older clients from the service side; see
 * `docs/english-first/public-api.md` in the repository.
 */

import type { ReadContract, SourceReadState } from './consumer.ts'
import {
  FACT_STATUSES,
  type Change,
  type Contract,
  type FactOutcome,
  type FactStatus,
  type Range,
  type ResendSuggestion,
  type SourceState,
} from './types.ts'

// ------------------------------------------------------------- what comes back

export type OutcomeWire = Omit<FactOutcome, 'status'> & { status: string }

export type ResendSuggestionWire = ResendSuggestion & { message?: string }

export type SourceStateWire = Omit<SourceState, 'gaps' | 'resendSuggestion'> & {
  gaps?: Range[]
  resendSuggestion?: ResendSuggestionWire | null
}

export type PublishResponseWire = {
  project: string
  receivedAt: string
  received: number
  accepted: number
  duplicates: number
  stale: number
  pending: number
  rejected: number
  outcomes?: OutcomeWire[]
  changes?: Change[]
  sources?: SourceStateWire[]
}

export type ContractResponseWire = Omit<Contract, 'sources' | 'response'> & {
  sources?: SourceStateWire[]
}

/** The error body of both APIs. `code` is stable; `message` is for people. */
export type ErrorWire = {
  code?: string
  message?: string
  reason?: string
  howToAuthenticate?: string
  howToResolve?: string
  limitBytes?: number
  limitFacts?: number
  received?: number
  source?: string
  whatToDo?: string
}

// ----------------------------------------------------------------- translation

export function toFactStatus(status: string): FactStatus {
  if (!(FACT_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`unknown fact status '${status}': this service speaks a contract newer than this client`)
  }
  return status as FactStatus
}

/** `index` is the position in the batch; `offset` maps it back to the caller's array. */
export function toOutcome(r: OutcomeWire, offset: number): FactOutcome {
  return {
    index: offset + r.index,
    eventId: r.eventId ?? null,
    status: toFactStatus(r.status),
    ...(r.reason !== undefined ? { reason: r.reason } : {}),
    ...(r.message !== undefined ? { message: r.message } : {}),
    ...(r.projected !== undefined ? { projected: r.projected } : {}),
  }
}

export function toChange(m: Change): Change {
  return { collection: m.collection, id: m.id, seq: m.seq, fact: m.fact, at: m.at, origin: m.origin, value: m.value }
}

export function toSourceState(e: SourceStateWire): SourceState {
  const r = e.resendSuggestion ?? null
  return {
    project: e.project,
    source: e.source,
    contiguous: e.contiguous,
    highest: e.highest,
    gaps: (e.gaps ?? []).map((g) => ({ from: g.from, to: g.to })),
    pending: e.pending,
    facts: e.facts,
    floor: e.floor,
    firstAt: e.firstAt,
    lastAt: e.lastAt,
    durable: e.durable,
    shared: e.shared,
    floorOrigin: e.floorOrigin,
    floorSetAt: e.floorSetAt,
    damaged: e.damaged,
    demotions: e.demotions,
    logSeq: e.logSeq,
    resendSuggestion: r === null ? null : { from: r.from, to: r.to, reason: r.reason },
  }
}

export function toContract(c: ContractResponseWire, raw: unknown): Contract {
  return {
    envelope: c.envelope,
    token: {
      name: c.token.name,
      prefix: c.token.prefix,
      capabilities: c.token.capabilities,
      expiresAt: c.token.expiresAt,
    },
    scope: { project: c.scope.project, sources: c.scope.sources },
    limits: { bodyBytes: c.limits.bodyBytes, factsPerBatch: c.limits.factsPerBatch, payloadBytes: c.limits.payloadBytes },
    required: c.required,
    optional: c.optional,
    definedByRetick: c.definedByRetick,
    durability: { durable: c.durability.durable, shared: c.durability.shared },
    sources: (c.sources ?? []).map(toSourceState),
    response: raw,
  }
}

// --------------------------------------------------------------- the read API

export type ReadFactWire = {
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
  observedAt: string
  payload: Record<string, unknown>
  provenance?: Record<string, unknown>
  integrity?: Record<string, unknown>
}

export type SourceReadStateWire = Omit<SourceReadState, 'gaps'> & { gaps?: Range[] }

export type ReadPageWire = {
  read: number
  project: string
  source: string
  facts?: ReadFactWire[]
  cursor: { from: number; next: number; total: number; hasMore: boolean }
  withheld?: { type: number; sensitivity: number }
  state: SourceReadStateWire | null
}

export type ReadContractWire = Omit<ReadContract, 'sources' | 'response'> & {
  sources?: SourceReadStateWire[]
}

export function toSourceReadState(e: SourceReadStateWire): SourceReadState {
  return {
    source: e.source,
    position: e.position,
    contiguous: e.contiguous,
    highest: e.highest,
    gaps: (e.gaps ?? []).map((g) => ({ from: g.from, to: g.to })),
    pending: e.pending,
    floor: e.floor,
    floorOrigin: e.floorOrigin,
    durable: e.durable,
    shared: e.shared,
    damaged: e.damaged,
    lastAt: e.lastAt,
    freshnessSeconds: e.freshnessSeconds,
  }
}

export function toReadContract(c: ReadContractWire, raw: unknown): ReadContract {
  return {
    read: c.read,
    envelope: c.envelope,
    token: {
      name: c.token.name,
      prefix: c.token.prefix,
      capabilities: c.token.capabilities,
      expiresAt: c.token.expiresAt,
    },
    scope: {
      project: c.scope.project,
      sources: c.scope.sources,
      types: c.scope.types,
      provenance: c.scope.provenance,
      integrity: c.scope.integrity,
      maxSensitivity: c.scope.maxSensitivity,
    },
    limits: { factsPerPage: c.limits.factsPerPage },
    sources: (c.sources ?? []).map(toSourceReadState),
    response: raw,
  }
}
