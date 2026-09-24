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
  toRange,
  toSourceState,
  type EstadoDaFonteWire,
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
  assert.deepEqual(JSON.parse(lotes[0]!.body), { fatos: [fato(1), fato(2)] })
})

test('o corte por contagem respeita o limite e os offsets seguem', () => {
  const fatos = Array.from({ length: 7 }, (_, i) => fato(i + 1))
  const lotes = splitIntoBatches(fatos, { ...LIMITS, factsPerBatch: 3 })

  assert.deepEqual(
    lotes.map((l) => l.offset),
    [0, 3, 6],
  )
  assert.deepEqual(
    lotes.map((l) => JSON.parse(l.body).fatos.length),
    [3, 3, 1],
  )
  // Nenhum fato se perdeu e nenhum foi duplicado, na ordem original.
  const devolta = lotes.flatMap((l) => JSON.parse(l.body).fatos)
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
    const proximo = JSON.stringify(fatos[JSON.parse(l.body).fatos.length + l.offset])
    assert.ok(bytes(l.body) + 1 + bytes(proximo) > limites.bodyBytes, `lote ${i} coube mais`)
  }
  assert.deepEqual(lotes.flatMap((l) => JSON.parse(l.body).fatos), fatos)
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

test('as cinco situacoes, e so elas', () => {
  assert.equal(toFactStatus('aceito'), 'accepted')
  assert.equal(toFactStatus('duplicado'), 'duplicate')
  assert.equal(toFactStatus('vencido'), 'stale')
  assert.equal(toFactStatus('pendente'), 'pending')
  assert.equal(toFactStatus('recusado'), 'rejected')
  assert.throws(() => toFactStatus('aceito '), /unknown fact status/)
  assert.throws(() => toFactStatus('accepted'), /unknown fact status/)
})

test('o indice do desfecho volta para a posicao no array do chamador', () => {
  const r = toOutcome({ indice: 2, eventId: 'e9', situacao: 'pendente' }, 500)
  assert.deepEqual(r, { index: 502, eventId: 'e9', status: 'pending' })
})

test('campo ausente na resposta nao vira campo presente com undefined', () => {
  const semMotivo = toOutcome({ indice: 0, eventId: null, situacao: 'aceito' }, 0)
  assert.deepEqual(Object.keys(semMotivo), ['index', 'eventId', 'status'])

  const completo = toOutcome(
    { indice: 0, eventId: 'e', situacao: 'aceito', motivo: 'm', projetado: false },
    0,
  )
  assert.equal(completo.reason, 'm')
  assert.equal(completo.projected, false)
})

test('a mudanca troca de nome sem trocar de valor', () => {
  assert.deepEqual(
    toChange({
      colecao: 'despachos',
      id: 'D-1',
      seq: 3,
      fato: 'dispatch.running',
      em: '2026-09-22T00:00:00.000Z',
      origem: 'folha',
      valor: { estado: 'RUNNING' },
    }),
    {
      collection: 'despachos',
      id: 'D-1',
      seq: 3,
      fact: 'dispatch.running',
      at: '2026-09-22T00:00:00.000Z',
      origin: 'folha',
      value: { estado: 'RUNNING' },
    },
  )
})

test('faixa e reenvio sugerido', () => {
  assert.deepEqual(toRange({ de: 4, ate: 9 }), { from: 4, to: 9 })
})

const FONTE: EstadoDaFonteWire = {
  projeto: 'acme',
  fonte: 'folha',
  contiguo: 7,
  maior: 9,
  lacunas: [{ de: 8, ate: 8 }],
  pendentes: 1,
  fatos: 8,
  piso: 0,
  primeiroEm: '2026-09-22T00:00:00.000Z',
  ultimoEm: '2026-09-22T01:00:00.000Z',
  duravel: true,
  compartilhada: false,
  origemDoPiso: 'primeiro_fato',
  pisoFixadoEm: '2026-09-22T00:00:00.000Z',
  avariada: false,
  rebaixamentos: 2,
  seqRegistro: 41,
  reenvioSugerido: { desde: 8, ate: 8, motivo: 'lacuna aberta' },
}

test('o estado da fonte atravessa inteiro, campo por campo', () => {
  assert.deepEqual(toSourceState(FONTE), {
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
    floorOrigin: 'primeiro_fato',
    floorSetAt: '2026-09-22T00:00:00.000Z',
    damaged: false,
    demotions: 2,
    logSeq: 41,
    resendSuggestion: { from: 8, to: 8, reason: 'lacuna aberta' },
  })
})

test('origemDoPiso atravessa como valor, nao como nome traduzido', () => {
  // `docs/CONTRATO-V1.md` secao 7 mostra este campo ganhando valor novo sem
  // quebrar ninguem. Traduzi-lo aqui faria deste cliente a peca que quebra na
  // proxima vez.
  assert.equal(toSourceState({ ...FONTE, origemDoPiso: 'registro' }).floorOrigin, 'registro')
  assert.equal(toSourceState({ ...FONTE, origemDoPiso: 'algo_novo' }).floorOrigin, 'algo_novo')
})

test('o contrato traduzido guarda o corpo original alcancavel', () => {
  const bruto = {
    envelope: 1,
    token: { nome: 'n', prefixo: 'abc', capacidades: ['fatos.publicar'], expiraEm: null },
    escopo: { projeto: 'acme', fontes: ['folha'] },
    limites: { corpoBytes: 10, fatosPorLote: 20, payloadBytes: 30 },
    obrigatorios: ['eventId'],
    opcionais: ['payload'],
    definidosPeloRetick: { tenant: 'vem do token' },
    durabilidade: { duravel: false, compartilhado: true },
    fontes: [FONTE],
    campoQueAindaNaoExiste: 'aditivo',
  }
  const c = toContract(bruto as never, bruto)

  assert.equal(c.scope.project, 'acme')
  assert.equal(c.sources[0]?.contiguous, 7)
  assert.equal(
    (c.response as Record<string, unknown>).campoQueAindaNaoExiste,
    'aditivo',
    'um campo novo continua legivel sem atualizar o cliente',
  )
})
