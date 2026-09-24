/**
 * The only place in this package that knows the service answers in Portuguese.
 *
 * The request side is already English — `eventId`, `sourceVersion`,
 * `occurredAt` are the contract's own field names and this client sends them
 * untouched. The response side is not, and the names there are internal to
 * Retick: `situacao`, `contiguo`, `reenvioSugerido`.
 *
 * Translating at the edge is the whole reason this file exists. If the mapping
 * lived inside the producer, every caller would end up reading one name in the
 * type and another in the debugger, and every new field would be translated in
 * whichever function happened to touch it first.
 *
 * NOTHING here invents a value. Field NAMES are translated; field VALUES are
 * passed through, with one exception that is itself frozen: the five values of
 * `situacao`, which are a closed set that the contract forbids growing. Where a
 * value is an open string — `origemDoPiso` is the live example — it crosses
 * untouched, because renaming data the service may extend later would make this
 * client the thing that breaks.
 */

import type { ReadContract, SourceReadState } from './consumer.ts'
import type {
  Change,
  Contract,
  FactOutcome,
  FactStatus,
  Range,
  ResendSuggestion,
  SourceState,
} from './types.ts'

// ------------------------------------------------------------- what comes back

export type SituacaoWire = 'aceito' | 'duplicado' | 'vencido' | 'pendente' | 'recusado'

export type ResultadoWire = {
  indice: number
  eventId: string | null
  situacao: SituacaoWire
  motivo?: string
  projetado?: boolean
}

export type MudancaWire = {
  colecao: string
  id: string
  seq: number
  fato: string
  em: string
  origem: string
  valor: unknown
}

export type FaixaWire = { de: number; ate: number }

export type ReenvioWire = { desde: number; ate: number; motivo: string }

export type EstadoDaFonteWire = {
  projeto: string
  fonte: string
  contiguo: number
  maior: number
  lacunas: FaixaWire[]
  pendentes: number
  fatos: number
  piso: number
  primeiroEm: string
  ultimoEm: string
  duravel: boolean
  compartilhada: boolean
  origemDoPiso: string
  pisoFixadoEm: string
  avariada: boolean
  rebaixamentos: number
  seqRegistro: number
  reenvioSugerido: ReenvioWire | null
}

export type RespostaDePublicacaoWire = {
  projeto: string
  recebidoEm: string
  recebidos: number
  aceitos: number
  duplicados: number
  vencidos: number
  pendentes: number
  recusados: number
  resultados: ResultadoWire[]
  mudancas: MudancaWire[]
  fontes: EstadoDaFonteWire[]
}

export type RespostaDeContratoWire = {
  envelope: number
  token: { nome: string; prefixo: string; capacidades: string[]; expiraEm: string | null }
  escopo: { projeto: string; fontes: string[] }
  limites: { corpoBytes: number; fatosPorLote: number; payloadBytes: number }
  obrigatorios: string[]
  opcionais: string[]
  definidosPeloRetick: Record<string, string>
  durabilidade: { duravel: boolean; compartilhado: boolean }
  fontes: EstadoDaFonteWire[]
}

/** The error body. Every refusal has `erro`; the rest depends on the case. */
export type ErroWire = {
  erro?: string
  motivo?: string
  comoAutenticar?: string
  limiteBytes?: number
  limiteFatos?: number
  recebidos?: number
  fonte?: string
  oQueFazer?: string
}

// ----------------------------------------------------------------- translation

/**
 * The five, and only the five.
 *
 * A `situacao` this client has never heard of would mean the service grew a
 * sixth, which `docs/CONTRATO-V1.md` section 5 classifies as an incompatible
 * change. Passing it through as an unknown string would let it reach a
 * producer's `switch` and fall out the bottom silently; `toFactStatus` throws
 * instead, so the day it happens someone reads a stack trace.
 */
const STATUS_BY_SITUACAO: Readonly<Record<SituacaoWire, FactStatus>> = Object.freeze({
  aceito: 'accepted',
  duplicado: 'duplicate',
  vencido: 'stale',
  pendente: 'pending',
  recusado: 'rejected',
})

export function toFactStatus(situacao: string): FactStatus {
  const status = STATUS_BY_SITUACAO[situacao as SituacaoWire]
  if (status === undefined) {
    throw new Error(
      `unknown fact status '${situacao}': this service speaks a contract newer than this client`,
    )
  }
  return status
}

/** `offset` shifts the batch-local index back to the caller's array position. */
export function toOutcome(r: ResultadoWire, offset: number): FactOutcome {
  return {
    index: offset + r.indice,
    eventId: r.eventId ?? null,
    status: toFactStatus(r.situacao),
    ...(r.motivo !== undefined ? { reason: r.motivo } : {}),
    ...(r.projetado !== undefined ? { projected: r.projetado } : {}),
  }
}

export function toChange(m: MudancaWire): Change {
  return {
    collection: m.colecao,
    id: m.id,
    seq: m.seq,
    fact: m.fato,
    at: m.em,
    origin: m.origem,
    value: m.valor,
  }
}

export function toRange(f: FaixaWire): Range {
  return { from: f.de, to: f.ate }
}

export function toResendSuggestion(r: ReenvioWire | null): ResendSuggestion | null {
  return r === null ? null : { from: r.desde, to: r.ate, reason: r.motivo }
}

export function toSourceState(e: EstadoDaFonteWire): SourceState {
  return {
    project: e.projeto,
    source: e.fonte,
    contiguous: e.contiguo,
    highest: e.maior,
    gaps: (e.lacunas ?? []).map(toRange),
    pending: e.pendentes,
    facts: e.fatos,
    floor: e.piso,
    firstAt: e.primeiroEm,
    lastAt: e.ultimoEm,
    durable: e.duravel,
    shared: e.compartilhada,
    floorOrigin: e.origemDoPiso,
    floorSetAt: e.pisoFixadoEm,
    damaged: e.avariada,
    demotions: e.rebaixamentos,
    logSeq: e.seqRegistro,
    resendSuggestion: toResendSuggestion(e.reenvioSugerido ?? null),
  }
}

export function toContract(c: RespostaDeContratoWire, raw: unknown): Contract {
  return {
    envelope: c.envelope,
    token: {
      name: c.token.nome,
      prefix: c.token.prefixo,
      capabilities: c.token.capacidades,
      expiresAt: c.token.expiraEm,
    },
    scope: { project: c.escopo.projeto, sources: c.escopo.fontes },
    limits: {
      bodyBytes: c.limites.corpoBytes,
      factsPerBatch: c.limites.fatosPorLote,
      payloadBytes: c.limites.payloadBytes,
    },
    required: c.obrigatorios,
    optional: c.opcionais,
    definedByRetick: c.definidosPeloRetick,
    durability: { durable: c.durabilidade.duravel, shared: c.durabilidade.compartilhado },
    sources: (c.fontes ?? []).map(toSourceState),
    response: raw,
  }
}

// ------------------------------------------------------- a porta de leitura

/**
 * O que a porta de leitura devolve. Formas separadas das de publicacao de
 * proposito: as duas portas versionam em ritmos diferentes, e um tipo
 * compartilhado faria uma mudanca de uma aparecer como quebra da outra.
 */
export type FatoLegivelWire = {
  posicao: number
  eventId: string
  fonte: string
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

export type EstadoDeLeituraWire = {
  fonte: string
  posicao: number
  contiguo: number
  maior: number
  lacunas: FaixaWire[]
  pendentes: number
  piso: number
  origemDoPiso: string
  duravel: boolean
  compartilhada: boolean
  avariada: boolean
  ultimoEm: string
  frescorSegundos: number | null
}

export type PaginaDeLeituraWire = {
  leitura: number
  projeto: string
  fonte: string
  fatos: FatoLegivelWire[]
  cursor: { de: number; proxima: number; total: number; haMais: boolean }
  omitidos: { tipo: number; classe: number }
  estado: EstadoDeLeituraWire | null
}

export type RespostaDeContratoDeLeituraWire = {
  leitura: number
  envelope: number
  token: { nome: string; prefixo: string; capacidades: string[]; expiraEm: string | null }
  escopo: {
    projeto: string
    fontes: string[]
    tipos: Record<string, string[]>
    procedencia: boolean
    integridade: boolean
    classeMaxima: string
  }
  limites: { fatosPorPagina: number }
  fontes: EstadoDeLeituraWire[]
}

export function toSourceReadState(e: EstadoDeLeituraWire): SourceReadState {
  return {
    source: e.fonte,
    position: e.posicao,
    contiguous: e.contiguo,
    highest: e.maior,
    gaps: (e.lacunas ?? []).map(toRange),
    pending: e.pendentes,
    floor: e.piso,
    floorOrigin: e.origemDoPiso,
    durable: e.duravel,
    shared: e.compartilhada,
    damaged: e.avariada,
    lastAt: e.ultimoEm,
    freshnessSeconds: e.frescorSegundos,
  }
}

export function toReadContract(c: RespostaDeContratoDeLeituraWire, raw: unknown): ReadContract {
  return {
    read: c.leitura,
    envelope: c.envelope,
    token: {
      name: c.token.nome,
      prefix: c.token.prefixo,
      capabilities: c.token.capacidades,
      expiresAt: c.token.expiraEm,
    },
    scope: {
      project: c.escopo.projeto,
      sources: c.escopo.fontes,
      types: c.escopo.tipos,
      provenance: c.escopo.procedencia,
      integrity: c.escopo.integridade,
      maxSensitivity: c.escopo.classeMaxima,
    },
    limits: { factsPerPage: c.limites.fatosPorPagina },
    sources: (c.fontes ?? []).map(toSourceReadState),
    response: raw,
  }
}
