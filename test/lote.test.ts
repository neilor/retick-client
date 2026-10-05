/**
 * Loteamento e traducao — as duas coisas que o cliente faz sozinho, sem rede.
 *
 * O loteamento e onde um erro nao apareceria em teste de integracao: um lote
 * um byte acima do limite volta 413 e o produtor conclui que o Retick e que
 * esta apertado. Por isso as contas sao conferidas contra o corpo que sai, e
 * nao contra a intencao.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { splitIntoBatches, LIMITS } from '../src/index.ts'
import {
  toChange,
  toContract,
  toFactStatus,
  toOutcome,
  toSourceState,
  type SourceStateWire,
} from '../src/wire.ts'
import type { Fact } from '../src/types.ts'

const fato = (n: number, enchimento = ''): Fact => ({
  eventId: `e${n}`,
  source: 'folha',
  sourceVersion: n,
  type: 't',
  entityType: 'c',
  occurredAt: '2026-09-22T00:00:00.000Z',
  payload: enchimento === '' ? {} : { x: enchimento },
})

const bytes = (s: string): number => new TextEncoder().encode(s).length

test('um lote so quando tudo cabe', () => {
  const lotes = splitIntoBatches([fato(1), fato(2)], LIMITS)
  assert.equal(lotes.length, 1)
  assert.equal(lotes[0]?.offset, 0)
  assert.deepEqual(JSON.parse(lotes[0]!.body), { facts: [fato(1), fato(2)] })
})

test('o corte por contagem respeita o limite e os offsets seguem', () => {
  const fatos = Array.from({ length: 7 }, (_, i) => fato(i + 1))
  const lotes = splitIntoBatches(fatos, { ...LIMITS, factsPerBatch: 3 })

  assert.deepEqual(
    lotes.map((l) => l.offset),
    [0, 3, 6],
  )
  assert.deepEqual(
    lotes.map((l) => JSON.parse(l.body).facts.length),
    [3, 3, 1],
  )
  // Nenhum fato se perdeu e nenhum foi duplicado, na ordem original.
  const devolta = lotes.flatMap((l) => JSON.parse(l.body).facts)
  assert.deepEqual(devolta, fatos)
})

test('nenhum corpo passa do limite de bytes, e o corte e o maior que cabe', () => {
  const limites = { ...LIMITS, bodyBytes: 400, factsPerBatch: 500 }
  const fatos = Array.from({ length: 12 }, (_, i) => fato(i + 1, 'z'.repeat(40)))
  const lotes = splitIntoBatches(fatos, limites)

  assert.ok(lotes.length > 1, 'precisava ter cortado')
  for (const l of lotes) {
    assert.ok(bytes(l.body) <= limites.bodyBytes, `corpo com ${bytes(l.body)} bytes`)
  }
  // Apertado: enfiar o proximo fato em qualquer lote estouraria.
  for (const [i, l] of lotes.entries()) {
    if (i === lotes.length - 1) break
    const proximo = JSON.stringify(fatos[JSON.parse(l.body).facts.length + l.offset])
    assert.ok(bytes(l.body) + 1 + bytes(proximo) > limites.bodyBytes, `lote ${i} coube mais`)
  }
  assert.deepEqual(lotes.flatMap((l) => JSON.parse(l.body).facts), fatos)
})

test('um fato que nao cabe sozinho vai sozinho, e quem recusa e o servico', () => {
  // Cortar ainda mais e impossivel e recusar aqui nao e desta camada: o limite
  // e do servico, um operador pode aumenta-lo, e um cliente com a propria
  // copia continuaria recusando depois do aumento.
  const limites = { ...LIMITS, bodyBytes: 100 }
  const lotes = splitIntoBatches([fato(1), fato(2, 'z'.repeat(500)), fato(3)], limites)

  assert.equal(lotes.length, 3)
  assert.deepEqual(lotes.map((l) => l.offset), [0, 1, 2])
  assert.ok(bytes(lotes[1]!.body) > limites.bodyBytes)
})

test('lote vazio nao vira corpo nenhum', () => {
  assert.deepEqual(splitIntoBatches([], LIMITS), [])
})

test('the five statuses, and only them', () => {
  for (const s of ['accepted', 'duplicate', 'stale', 'pending', 'rejected']) assert.equal(toFactStatus(s), s)
  assert.throws(() => toFactStatus('accepted '), /unknown fact status/)
  assert.throws(() => toFactStatus('aceito'), /unknown fact status/, 'the legacy name is not spoken by this client')
})

test('the outcome index goes back to the position in the caller array', () => {
  const r = toOutcome({ index: 2, eventId: 'e9', status: 'pending' }, 500)
  assert.deepEqual(r, { index: 502, eventId: 'e9', status: 'pending' })
})

test('a field missing from the answer does not become a field present as undefined', () => {
  const bare = toOutcome({ index: 0, eventId: null, status: 'accepted' }, 0)
  assert.deepEqual(Object.keys(bare), ['index', 'eventId', 'status'])

  const full = toOutcome(
    { index: 0, eventId: 'e', status: 'rejected', reason: 'payload_not_object', message: 'payload must be a JSON object', projected: false },
    0,
  )
  assert.equal(full.reason, 'payload_not_object')
  assert.equal(full.message, 'payload must be a JSON object')
  assert.equal(full.projected, false)
})

test('a change keeps its values', () => {
  const change = {
    collection: 'despachos',
    id: 'D-1',
    seq: 3,
    fact: 'dispatch.running',
    at: '2026-09-22T00:00:00.000Z',
    origin: 'folha',
    value: { state: 'RUNNING' },
  }
  assert.deepEqual(toChange(change), change)
})

const SOURCE: SourceStateWire = {
  project: 'acme',
  source: 'folha',
  contiguous: 7,
  highest: 9,
  gaps: [{ from: 8, to: 8 }],
  pending: 1,
  facts: 8,
  floor: 0,
  firstAt: '2026-09-22T00:00:00.000Z',
  lastAt: '2026-09-22T01:00:00.000Z',
  durable: true,
  shared: false,
  floorOrigin: 'first_fact',
  floorSetAt: '2026-09-22T00:00:00.000Z',
  damaged: false,
  demotions: 2,
  logSeq: 41,
  resendSuggestion: { from: 8, to: 8, reason: 'gap', message: 'this range never arrived' },
}

test('the source state crosses whole, field by field', () => {
  assert.deepEqual(toSourceState(SOURCE), {
    project: 'acme',
    source: 'folha',
    contiguous: 7,
    highest: 9,
    gaps: [{ from: 8, to: 8 }],
    pending: 1,
    facts: 8,
    floor: 0,
    firstAt: '2026-09-22T00:00:00.000Z',
    lastAt: '2026-09-22T01:00:00.000Z',
    durable: true,
    shared: false,
    floorOrigin: 'first_fact',
    floorSetAt: '2026-09-22T00:00:00.000Z',
    damaged: false,
    demotions: 2,
    logSeq: 41,
    resendSuggestion: { from: 8, to: 8, reason: 'gap' },
  })
})

test('floorOrigin crosses as a value, so a new origin does not break this client', () => {
  // `docs/CONTRATO-V1.md` section 7 shows this field gaining a value without
  // breaking anyone. Narrowing it here would make this client the piece that breaks.
  assert.equal(toSourceState({ ...SOURCE, floorOrigin: 'log' }).floorOrigin, 'log')
  assert.equal(toSourceState({ ...SOURCE, floorOrigin: 'something_new' }).floorOrigin, 'something_new')
  assert.deepEqual(toSourceState({ ...SOURCE, gaps: undefined }).gaps, [])
})

test('the translated contract keeps the original body reachable', () => {
  const raw = {
    envelope: 1,
    token: { name: 'n', prefix: 'abc', capabilities: ['facts:publish'], expiresAt: null },
    scope: { project: 'acme', sources: ['folha'] },
    limits: { bodyBytes: 10, factsPerBatch: 20, payloadBytes: 30 },
    required: ['eventId'],
    optional: ['payload'],
    definedByRetick: { tenant: 'comes from the credential' },
    durability: { durable: false, shared: true },
    sources: [SOURCE],
    fieldThatDoesNotExistYet: 'additive',
  }
  const c = toContract(raw as never, raw)

  assert.equal(c.scope.project, 'acme')
  assert.equal(c.sources[0]?.contiguous, 7)
  assert.equal(
    (c.response as Record<string, unknown>).fieldThatDoesNotExistYet,
    'additive',
    'a new field stays readable without updating the client',
  )
})
