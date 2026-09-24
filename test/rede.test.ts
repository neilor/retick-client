/**
 * O que o cliente faz quando o servico nao responde, responde errado, ou
 * responde devagar. Nenhum servidor sobe aqui: o `fetch` e injetado, e e ele
 * que encena cada linha da tabela de codigos do contrato.
 *
 * A pergunta que cada teste faz e sempre a mesma: repetir este pedido pode dar
 * certo? Repetir e seguro porque publicar e idempotente em
 * `(source, tenant, eventId)` — mas so vale a pena quando o pedido nao foi
 * respondido. Recusa respondida repetida e laco.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProducer } from '../src/index.ts'
import {
  RetickAuthError,
  RetickNetworkError,
  RetickRequestError,
  RetickServerError,
  RetickSourceClosedError,
  RetickTimeoutError,
} from '../src/errors.ts'
import type { Fact } from '../src/types.ts'

const TOKEN = 'rtk_0123456789ab_segredoQueNaoPodeVazarNuncaJamais123'

const FATO: Fact = {
  eventId: 'e1',
  source: 'folha',
  sourceVersion: 1,
  type: 'x',
  entityType: 'y',
  occurredAt: '2026-09-22T00:00:00.000Z',
  payload: {},
}

const OK = {
  projeto: 'acme',
  recebidoEm: '2026-09-22T00:00:00.000Z',
  recebidos: 1,
  aceitos: 1,
  duplicados: 0,
  vencidos: 0,
  pendentes: 0,
  recusados: 0,
  resultados: [{ indice: 0, eventId: 'e1', situacao: 'aceito', projetado: true }],
  mudancas: [],
  fontes: [],
}

function resposta(codigo: number, corpo: unknown, cabecalhos: Record<string, string> = {}): Response {
  return new Response(typeof corpo === 'string' ? corpo : JSON.stringify(corpo), {
    status: codigo,
    headers: { 'content-type': 'application/json', ...cabecalhos },
  })
}

/** Encena uma resposta por chamada e anota quanto tempo o cliente dormiu. */
function encenar(roteiro: Array<Response | Error>) {
  const dormiu: number[] = []
  let chamadas = 0
  const fetchFalso = (async () => {
    const passo = roteiro[Math.min(chamadas, roteiro.length - 1)]
    chamadas++
    if (passo instanceof Error) throw passo
    return passo
  }) as unknown as typeof fetch
  return {
    dormiu,
    get chamadas() {
      return chamadas
    },
    cliente: (extra: Record<string, unknown> = {}) =>
      createProducer({
        url: 'http://retick.test',
        token: TOKEN,
        fetch: fetchFalso,
        retries: 3,
        retryBaseDelayMs: 10,
        retryMaxDelayMs: 100,
        sleep: async (ms) => {
          dormiu.push(ms)
        },
        random: () => 1,
        ...extra,
      }),
  }
}

test('5xx e repetido, e a quarta tentativa aproveita a resposta boa', async () => {
  const cena = encenar([
    resposta(500, { erro: 'falha ao publicar' }),
    resposta(502, 'bad gateway'),
    resposta(503, { erro: 'ingestao nao configurada' }),
    resposta(200, OK),
  ])
  const r = await cena.cliente().publish([FATO])

  assert.equal(r.accepted, 1)
  assert.equal(cena.chamadas, 4)
  // Recuo exponencial com teto: 10, 20, 40. `random: () => 1` fixa o jitter no
  // maximo, senao o valor seria qualquer coisa abaixo disso.
  assert.deepEqual(cena.dormiu, [10, 20, 40])
})

test('o recuo nao passa do teto', async () => {
  const cena = encenar([resposta(500, { erro: 'x' })])
  await cena.cliente({ retries: 6 }).publish([FATO]).catch(() => {})
  assert.deepEqual(cena.dormiu, [10, 20, 40, 80, 100, 100])
})

test('Retry-After manda no lugar do recuo calculado', async () => {
  const cena = encenar([resposta(429, { erro: 'devagar' }, { 'retry-after': '2' }), resposta(200, OK)])
  await cena.cliente().publish([FATO])
  assert.deepEqual(cena.dormiu, [2000])
})

test('429 e repetido mesmo nao existindo em v1: quem emite e o proxy da frente', async () => {
  const cena = encenar([resposta(429, { erro: 'devagar' }), resposta(200, OK)])
  const r = await cena.cliente().publish([FATO])
  assert.equal(r.accepted, 1)
  assert.equal(cena.chamadas, 2)
})

test('recusa respondida nao e repetida — nem uma vez', async () => {
  for (const [codigo, classe] of [
    [400, RetickRequestError],
    [401, RetickAuthError],
    [403, RetickAuthError],
    [405, RetickRequestError],
    [413, RetickRequestError],
  ] as const) {
    const cena = encenar([resposta(codigo, { erro: `recusa ${codigo}` })])
    const e = await cena.cliente().publish([FATO]).catch((err) => err)

    assert.ok(e instanceof classe, `${codigo} deveria ser ${classe.name}`)
    assert.equal(e.status, codigo)
    assert.equal(e.retryable, false)
    assert.equal(cena.chamadas, 1, `${codigo} foi repetido`)
    assert.deepEqual(cena.dormiu, [])
  }
})

test('413 carrega o limite que foi estourado', async () => {
  const cena = encenar([
    resposta(413, { erro: 'lote grande demais', recebidos: 900, limiteFatos: 500 }),
  ])
  const e = await cena.cliente().publish([FATO]).catch((err) => err)
  assert.ok(e instanceof RetickRequestError)
  assert.equal((e.body as Record<string, unknown>).limiteFatos, 500)
})

test('503 de fonte fechada e outra coisa: para na hora e diz o que fazer', async () => {
  const cena = encenar([
    resposta(503, {
      erro: 'ingestao indisponivel para esta fonte',
      fonte: 'folha',
      motivo: 'disco cheio',
      oQueFazer: 'nao avance o cursor; reenvie a partir do ultimo fato confirmado',
    }),
    resposta(200, OK),
  ])
  const e = await cena.cliente().publish([FATO]).catch((err) => err)

  assert.ok(e instanceof RetickSourceClosedError)
  assert.equal(e.source, 'folha')
  assert.equal(e.reason, 'disco cheio')
  assert.equal(e.retryable, false)
  assert.match(e.whatToDo, /nao avance o cursor/)
  assert.equal(cena.chamadas, 1, 'a fonte fica fechada ate o processo subir; repetir e laco')
})

test('503 sem fonte continua sendo 5xx comum, e e repetido', async () => {
  const cena = encenar([resposta(503, { erro: 'ingestao nao configurada' }), resposta(200, OK)])
  const r = await cena.cliente().publish([FATO])
  assert.equal(r.accepted, 1)
  assert.equal(cena.chamadas, 2)
})

test('falha de rede e repetida, e o que sobra e RetickNetworkError', async () => {
  const cena = encenar([Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' })])
  const e = await cena.cliente().publish([FATO]).catch((err) => err)

  assert.ok(e instanceof RetickNetworkError)
  assert.equal(e.retryable, true)
  assert.equal(cena.chamadas, 4, 'primeira mais tres repeticoes')
  assert.equal(e.url, 'http://retick.test/api/v1/fatos')
  assert.ok(e.cause instanceof TypeError, 'a causa original fica alcancavel')
})

test('pedido sem resposta dentro do prazo vira RetickTimeoutError', async () => {
  const nunca = ((_url: string, init: RequestInit) =>
    new Promise((_ok, falhar) => {
      init.signal?.addEventListener('abort', () => falhar(new Error('aborted')))
    })) as unknown as typeof fetch

  const p = createProducer({
    url: 'http://retick.test',
    token: TOKEN,
    fetch: nunca,
    retries: 0,
    timeoutMs: 25,
  })

  const e = await p.publish([FATO]).catch((err) => err)
  assert.ok(e instanceof RetickTimeoutError)
  assert.equal(e.timeoutMs, 25)
  assert.equal(e.retryable, true, 'o fato pode ter chegado; reenviar volta duplicado')
})

test('timeout tambem e repetido quando ha tentativas sobrando', async () => {
  let chamadas = 0
  const dormiu: number[] = []
  const lento = ((_url: string, init: RequestInit) => {
    chamadas++
    return new Promise((ok, falhar) => {
      if (chamadas > 2) return ok(resposta(200, OK))
      init.signal?.addEventListener('abort', () => falhar(new Error('aborted')))
    })
  }) as unknown as typeof fetch

  const r = await createProducer({
    url: 'http://retick.test',
    token: TOKEN,
    fetch: lento,
    retries: 3,
    timeoutMs: 20,
    retryBaseDelayMs: 1,
    sleep: async (ms) => {
      dormiu.push(ms)
    },
  }).publish([FATO])

  assert.equal(r.accepted, 1)
  assert.equal(chamadas, 3)
  assert.equal(dormiu.length, 2)
})

test('resposta que nao e JSON nao derruba o cliente: vem inteira no erro', async () => {
  const cena = encenar([
    new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
  ])
  const e = await cena.cliente({ retries: 0 }).publish([FATO]).catch((err) => err)

  assert.ok(e instanceof RetickServerError)
  assert.equal(e.body, '<html>502 Bad Gateway</html>')
  assert.equal(e.message, 'HTTP 502')
})

test('codigo fora do contrato nao e adivinhado como transitorio', async () => {
  const cena = encenar([resposta(404, { erro: 'nao encontrado' })])
  const e = await cena.cliente().publish([FATO]).catch((err) => err)

  assert.equal(e.status, 404)
  assert.equal(e.retryable, false)
  assert.equal(cena.chamadas, 1, 'url errada nao melhora com espera')
})

test('o segredo do token nao aparece em erro nenhum, so o prefixo', async () => {
  const segredo = TOKEN.slice(17)
  const cena = encenar([resposta(401, { erro: 'credencial recusada', motivo: 'desconhecido' })])
  const e = await cena.cliente().publish([FATO]).catch((err) => err)

  assert.equal(e.tokenPrefix, 'rtk_0123456789ab')
  assert.ok(!`${e.message}${e.stack}${JSON.stringify(e.body)}`.includes(segredo))
})

test('token de formato desconhecido nao e ecoado nem em pedaco', async () => {
  const cena = encenar([resposta(401, { erro: 'credencial recusada' })])
  const e = await cena
    .cliente({ token: 'um-token-de-outro-formato-qualquer' })
    .publish([FATO])
    .catch((err) => err)

  assert.equal(e.tokenPrefix, '(unrecognized token format)')
})

test('o cliente manda Bearer, content-type e o corpo no formato do contrato', async () => {
  let visto: { url: string; init: RequestInit } | null = null
  const espiao = ((url: string, init: RequestInit) => {
    visto = { url, init }
    return Promise.resolve(resposta(200, OK))
  }) as unknown as typeof fetch

  await createProducer({ url: 'http://retick.test/', token: TOKEN, fetch: espiao }).publish([FATO])

  const { url, init } = visto as unknown as { url: string; init: RequestInit }
  assert.equal(url, 'http://retick.test/api/v1/fatos')
  assert.equal(init.method, 'POST')
  const cab = init.headers as Record<string, string>
  assert.equal(cab.authorization, `Bearer ${TOKEN}`)
  assert.equal(cab['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(init.body as string), { fatos: [FATO] })
})

test('o contrato e um GET sem corpo', async () => {
  let visto: RequestInit | null = null
  const espiao = ((_url: string, init: RequestInit) => {
    visto = init
    return Promise.resolve(
      resposta(200, {
        envelope: 1,
        token: { nome: 'n', prefixo: 'p', capacidades: ['fatos.publicar'], expiraEm: null },
        escopo: { projeto: 'acme', fontes: ['folha'] },
        limites: { corpoBytes: 1, fatosPorLote: 2, payloadBytes: 3 },
        obrigatorios: [],
        opcionais: [],
        definidosPeloRetick: {},
        durabilidade: { duravel: true, compartilhado: false },
        fontes: [],
      }),
    )
  }) as unknown as typeof fetch

  const c = await createProducer({ url: 'http://retick.test', token: TOKEN, fetch: espiao }).contract()

  assert.equal((visto as unknown as RequestInit).method, 'GET')
  assert.equal((visto as unknown as RequestInit).body, undefined)
  assert.deepEqual(c.limits, { bodyBytes: 1, factsPerBatch: 2, payloadBytes: 3 })
  assert.deepEqual(c.durability, { durable: true, shared: false })
})

test('uma situacao que este cliente nao conhece nao passa em silencio', async () => {
  const cena = encenar([
    resposta(200, { ...OK, resultados: [{ indice: 0, eventId: 'e1', situacao: 'engolido' }] }),
  ])
  await assert.rejects(cena.cliente().publish([FATO]), /unknown fact status 'engolido'/)
})
