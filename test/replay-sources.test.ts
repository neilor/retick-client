/**
 * `consumer.replaySources()`: o replay de varias fontes sobre
 * `POST /api/read/v1/batch`. Nenhum servidor sobe aqui. O `fetch` injetado e
 * um servico de mentira com um log por fonte, que responde a rota de uma fonte
 * e a de lote a partir dos MESMOS logs, para que os dois caminhos possam ser
 * comparados fato a fato.
 *
 * O servico de mentira nao copia o lote do servidor (orcamento justo, corte
 * por bytes). Ele so faz o que o cliente precisa enfrentar: pagina por fonte,
 * fonte adiada quando a resposta enche, recusa de escopo, limite de fontes e
 * falhas de rede. O lote real e provado fora daqui, contra os handlers da
 * main do servico.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createConsumer, type ReadFact, type ReplayCheckpoint } from '../src/index.ts'
import {
  RetickAuthError,
  RetickConfigError,
  RetickError,
  RetickHttpError,
  RetickTimeoutError,
} from '../src/errors.ts'

const TOKEN = 'rtl_0123456789ab_segredoDeLeituraQueNaoPodeVazar123456'

type Entrada = { source: string; sourceVersion: number; entityType?: string }

type Servico = {
  /** Acrescenta ao log da fonte, na ordem de chegada. */
  publicar: (...fatos: Entrada[]) => void
  fetch: typeof fetch
  pedidos: { rota: string; fontes: string[] }[]
  /** Falhas encenadas, consumidas uma por pedido de lote. */
  falhas: Array<'ok' | '503' | 'rede' | 'pendura' | '404'>
}

function servico(op: {
  /** Posicoes de log por resposta de lote, somando todas as fontes. */
  orcamento?: number
  maxSources?: number
  /** Lista exata de fontes da credencial. `null`: todas. */
  escopo?: string[] | null
  /** `entityType` fora do mapa da credencial: ocupa posicao e nao vem. */
  oculto?: string
} = {}): Servico {
  const logs = new Map<string, ReadFact[]>()
  const pedidos: Servico['pedidos'] = []
  const falhas: Servico['falhas'] = []

  const estado = (source: string) => {
    const log = logs.get(source) ?? []
    const versoes = new Set(log.map((f) => f.sourceVersion))
    const floor = log.length > 0 ? (log[0] as ReadFact).sourceVersion - 1 : 0
    let contiguous = floor
    while (versoes.has(contiguous + 1)) contiguous += 1
    return {
      source,
      position: log.length,
      contiguous,
      highest: Math.max(floor, ...versoes),
      gaps: [],
      pending: 0,
      floor,
      floorOrigin: 'first-fact',
      durable: false,
      shared: false,
      damaged: false,
      lastAt: '2026-10-06T00:00:00.000Z',
      freshnessSeconds: null,
    }
  }

  const pagina = (source: string, position: number, janela: number) => {
    const log = logs.get(source) ?? []
    const fim = Math.min(log.length, position + janela)
    const lidos = log.slice(position, fim)
    const visiveis = lidos.filter((f) => f.entityType !== op.oculto)
    return {
      read: 1,
      project: 'acme',
      source,
      facts: visiveis,
      cursor: { from: position, next: fim, total: log.length, hasMore: fim < log.length },
      withheld: { type: lidos.length - visiveis.length, sensitivity: 0 },
      state: estado(source),
    }
  }

  const responder = (status: number, corpo: unknown) =>
    new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } })

  const fetchFalso = (async (url: string, init: RequestInit) => {
    const u = new URL(url)
    if (init.headers && (init.headers as Record<string, string>).authorization !== `Bearer ${TOKEN}`) {
      return responder(401, { code: 'credential_refused', reason: 'unknown' })
    }
    const recusa = (fontes: string[]) => {
      const fora = op.escopo ? fontes.find((s) => !op.escopo!.includes(s)) : undefined
      return fora === undefined
        ? null
        : responder(403, { code: 'source_not_granted', message: `source ${fora} is not granted`, source: fora })
    }

    if (u.pathname === '/api/read/v1/facts') {
      const source = u.searchParams.get('source') as string
      pedidos.push({ rota: 'facts', fontes: [source] })
      const negado = recusa([source])
      if (negado) return negado
      return responder(200, pagina(source, Number(u.searchParams.get('position') ?? 0), Number(u.searchParams.get('limit') ?? 500)))
    }

    if (u.pathname === '/api/read/v1/batch' && init.method === 'POST') {
      const corpo = JSON.parse(String(init.body)) as { sources: { source: string; position: number }[]; limit?: number }
      pedidos.push({ rota: 'batch', fontes: corpo.sources.map((s) => s.source) })
      const falha = falhas.shift()
      if (falha === '503') return responder(503, { code: 'internal_error', message: 'try again' })
      if (falha === 'rede') throw new TypeError('fetch failed')
      if (falha === '404') return responder(404, { code: 'not_found' })
      if (falha === 'pendura') {
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }
      const max = op.maxSources ?? 100
      if (corpo.sources.length > max) {
        return responder(400, { code: 'invalid_field', field: 'sources', reason: 'too_many', max })
      }
      const negado = recusa(corpo.sources.map((s) => s.source))
      if (negado) return negado
      const limit = Math.min(corpo.limit ?? 500, 500)
      let resta = op.orcamento ?? 1000
      const pages: unknown[] = []
      const deferred: { source: string; position: number }[] = []
      for (const { source, position } of corpo.sources) {
        const devido = Math.max(0, (logs.get(source) ?? []).length - position)
        if (devido > 0 && resta === 0) {
          deferred.push({ source, position })
          continue
        }
        const janela = Math.min(limit, devido, resta)
        resta -= janela
        pages.push(pagina(source, position, janela))
      }
      return responder(200, { read: 1, project: 'acme', pages, deferred, limits: { maxSources: max, limit } })
    }
    return responder(404, { code: 'not_found' })
  }) as unknown as typeof fetch

  return {
    pedidos,
    falhas,
    fetch: fetchFalso,
    publicar: (...fatos) => {
      for (const f of fatos) {
        const log = logs.get(f.source) ?? []
        log.push({
          position: log.length + 1,
          eventId: `${f.source}-v${f.sourceVersion}-${log.length + 1}`,
          source: f.source,
          sourceVersion: f.sourceVersion,
          type: 'thing.changed',
          entityType: f.entityType ?? 'thing',
          entityId: f.source,
          schemaVersion: 1,
          occurredAt: '2026-10-06T00:00:00.000Z',
          recordedAt: '2026-10-06T00:00:00.000Z',
          observedAt: '2026-10-06T00:00:00.000Z',
          payload: { v: f.sourceVersion },
        })
        logs.set(f.source, log)
      }
    },
  }
}

const leitor = (s: Servico, extra: Record<string, unknown> = {}) =>
  createConsumer({
    url: 'http://retick.test',
    token: TOKEN,
    fetch: s.fetch,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 2,
    ...extra,
  })

/** 17 fatos em 7 fontes, o caso sintetico do feedback: 3+3+3+2+2+2+2. */
function dezessete(s: Servico): string[] {
  const fontes = ['user-a', 'user-b', 'user-c', 'room-1', 'room-2', 'room-3', 'room-4']
  fontes.forEach((source, i) => {
    for (let v = 1; v <= (i < 3 ? 3 : 2); v++) s.publicar({ source, sourceVersion: v })
  })
  return fontes
}

/** O que cada fonte recebeu, em ordem de entrega. */
function coletor() {
  const porFonte = new Map<string, number[]>()
  const ordem: string[] = []
  return {
    porFonte,
    ordem,
    onFacts: (facts: ReadFact[], source: string) => {
      for (const f of facts) assert.equal(f.source, source, 'um lote de onFacts mistura fontes')
      porFonte.set(source, [...(porFonte.get(source) ?? []), ...facts.map((f) => f.sourceVersion)])
      ordem.push(source)
    },
  }
}

test('17 fatos em 7 fontes: um pedido so, e cada fonte em ordem de sourceVersion', async () => {
  const s = servico()
  const fontes = dezessete(s)
  const c = coletor()
  const r = await leitor(s).replaySources({ sources: fontes, onFacts: c.onFacts })

  assert.equal(r.requests, 1)
  assert.deepEqual(s.pedidos.map((p) => p.rota), ['batch'])
  assert.equal(r.applied, 17)
  assert.equal(r.caughtUp, true)
  for (const [i, source] of fontes.entries()) {
    assert.deepEqual(c.porFonte.get(source), i < 3 ? [1, 2, 3] : [1, 2])
    assert.equal(r.resume[source]?.source, source)
  }
})

test('o checkpoint de cada fonte e o mesmo que replay() devolveria', async () => {
  const s = servico()
  const fontes = dezessete(s)
  s.publicar({ source: 'user-a', sourceVersion: 5 }) // fica retido atras do 4
  const c = leitor(s)
  const lote = await c.replaySources({ sources: fontes, onFacts: () => {} })
  for (const source of fontes) {
    const um = await c.replay({ source, onFacts: () => {} })
    assert.deepEqual(lote.resume[source], um.resume, source)
  }
  assert.equal(lote.held, 1)
  assert.equal(lote.sources['user-a']?.held, 1)
})

test('fato retido atras de lacuna sai uma vez so, quando a lacuna fecha, numa chamada seguinte', async () => {
  const s = servico()
  s.publicar({ source: 'a', sourceVersion: 1 }, { source: 'a', sourceVersion: 3 }, { source: 'b', sourceVersion: 1 })
  const c = leitor(s)
  const primeira = coletor()
  const r1 = await c.replaySources({ sources: ['a', 'b'], onFacts: primeira.onFacts })
  assert.deepEqual(primeira.porFonte.get('a'), [1])
  assert.equal(r1.held, 1)

  s.publicar({ source: 'a', sourceVersion: 2 }, { source: 'b', sourceVersion: 2 })
  const segunda = coletor()
  const r2 = await c.replaySources({ sources: ['a', 'b'], resume: r1.resume, onFacts: segunda.onFacts })
  assert.deepEqual(segunda.porFonte.get('a'), [2, 3])
  assert.deepEqual(segunda.porFonte.get('b'), [2])
  assert.equal(r2.held, 0)

  const terceira = coletor()
  await c.replaySources({ sources: ['a', 'b'], resume: r2.resume, onFacts: terceira.onFacts })
  assert.equal(terceira.ordem.length, 0, 'nada e entregue duas vezes')
})

test('resposta cheia: fonte adiada vai na frente do pedido seguinte e nenhum fato se perde', async () => {
  const s = servico({ orcamento: 3 })
  const fontes = dezessete(s)
  const c = coletor()
  const r = await leitor(s).replaySources({ sources: fontes, onFacts: c.onFacts })

  assert.equal(r.applied, 17)
  assert.ok(r.deferred > 0)
  assert.ok(r.requests >= 6)
  for (const [i, source] of fontes.entries()) assert.deepEqual(c.porFonte.get(source), i < 3 ? [1, 2, 3] : [1, 2])
  // Quem foi adiado num pedido abre o pedido seguinte.
  const lotes = s.pedidos.filter((p) => p.rota === 'batch')
  assert.equal(lotes[1]?.fontes[0], 'user-b')
})

test('a ordem de entrega dentro de cada fonte nao depende do tamanho da pagina nem do orcamento', async () => {
  const fontes = ['a', 'b', 'c']
  const entregue = async (orcamento: number, limit: number) => {
    const s = servico({ orcamento })
    for (const v of [1, 3, 2, 5, 4]) for (const source of fontes) s.publicar({ source, sourceVersion: v })
    const c = coletor()
    await leitor(s).replaySources({ sources: fontes, limit, onFacts: c.onFacts })
    return fontes.map((f) => c.porFonte.get(f))
  }
  const base = await entregue(1000, 500)
  assert.deepEqual(base, [[1, 2, 3, 4, 5], [1, 2, 3, 4, 5], [1, 2, 3, 4, 5]])
  for (const [o, l] of [[1, 1], [2, 1], [4, 2], [7, 3]] as const) assert.deepEqual(await entregue(o, l), base)
})

test('mais fontes que um pedido leva: pedidos de no maximo 100', async () => {
  const s = servico()
  const fontes = Array.from({ length: 150 }, (_, i) => `user-${i}`)
  for (const source of fontes) s.publicar({ source, sourceVersion: 1 })
  const r = await leitor(s).replaySources({ sources: fontes, onFacts: () => {} })
  assert.equal(r.applied, 150)
  assert.deepEqual(s.pedidos.map((p) => p.fontes.length), [100, 50])
})

test('servico com limite menor: o cliente usa o max da recusa e termina', async () => {
  const s = servico({ maxSources: 3 })
  const fontes = dezessete(s)
  const r = await leitor(s).replaySources({ sources: fontes, onFacts: () => {} })
  assert.equal(r.applied, 17)
  assert.ok(s.pedidos.every((p, i) => i === 0 || p.fontes.length <= 3))
})

test('fonte fora da lista exata da credencial: recusa antes de entregar qualquer fato', async () => {
  const s = servico({ escopo: ['user-a', 'user-b'] })
  dezessete(s)
  const c = coletor()
  await assert.rejects(
    leitor(s).replaySources({ sources: ['user-a', 'user-c'], onFacts: c.onFacts }),
    RetickAuthError,
  )
  assert.equal(c.ordem.length, 0)
})

test('checkpoint de outra fonte e recusado antes de qualquer pedido', async () => {
  const s = servico()
  dezessete(s)
  const c = leitor(s)
  const r = await c.replaySources({ sources: ['user-a'], onFacts: () => {} })
  const trocado = { 'user-b': r.resume['user-a'] as ReplayCheckpoint }
  await assert.rejects(c.replaySources({ sources: ['user-b'], resume: trocado, onFacts: () => {} }), RetickConfigError)
  assert.equal(s.pedidos.length, 1)
})

test('checkpoint lido alem do fim do log e recusado, como em replay()', async () => {
  const s = servico()
  s.publicar({ source: 'a', sourceVersion: 1 })
  const resume = { a: { source: 'a', position: 9, readTo: 9, floor: 0, settled: [{ from: 1, to: 1 }] } }
  await assert.rejects(leitor(s).replaySources({ sources: ['a'], resume, onFacts: () => {} }), /past the end/)
})

test('fonte repetida e recusada; lista vazia nao faz pedido', async () => {
  const s = servico()
  await assert.rejects(leitor(s).replaySources({ sources: ['a', 'a'], onFacts: () => {} }), RetickConfigError)
  const r = await leitor(s).replaySources({ sources: [], onFacts: () => {} })
  assert.equal(r.requests, 0)
  assert.equal(r.caughtUp, true)
  assert.equal(s.pedidos.length, 0)
})

test('checkpoints de replay() e de replaySources() valem nos dois sentidos', async () => {
  const s = servico()
  const fontes = dezessete(s)
  const c = leitor(s)
  const avulsos: Record<string, ReplayCheckpoint> = {}
  for (const source of fontes) avulsos[source] = (await c.replay({ source, onFacts: () => {} })).resume

  for (const source of fontes) s.publicar({ source, sourceVersion: 4 })
  const col = coletor()
  const r = await c.replaySources({ sources: fontes, resume: avulsos, onFacts: col.onFacts })
  for (const [i, source] of fontes.entries()) assert.deepEqual(col.porFonte.get(source), i < 3 ? [4] : undefined)
  assert.equal(r.held, 4, 'v4 sem v3 fica retido nas quatro salas')

  for (const source of fontes.slice(3)) s.publicar({ source, sourceVersion: 3 })
  const volta: number[] = []
  await c.replay({ source: 'room-1', resume: r.resume['room-1'] as ReplayCheckpoint, onFacts: (fs) => void volta.push(...fs.map((f) => f.sourceVersion)) })
  assert.deepEqual(volta, [3, 4])
})

test('versao fora do mapa da credencial ocupa posicao, nao vem, e nao vira lacuna eterna', async () => {
  const s = servico({ oculto: 'secret' })
  s.publicar(
    { source: 'a', sourceVersion: 1 },
    { source: 'a', sourceVersion: 2, entityType: 'secret' },
    { source: 'a', sourceVersion: 3 },
  )
  const c = coletor()
  const r = await leitor(s).replaySources({ sources: ['a'], onFacts: c.onFacts })
  assert.deepEqual(c.porFonte.get('a'), [1, 3])
  assert.equal(r.sources['a']?.withheld.type, 1)
  assert.equal(r.held, 0)
})

test('503 e falha de rede no lote sao repetidos com o mesmo corpo, e o resultado nao muda', async () => {
  const s = servico()
  const fontes = dezessete(s)
  s.falhas.push('503', 'rede')
  const c = coletor()
  const r = await leitor(s).replaySources({ sources: fontes, onFacts: c.onFacts })
  assert.equal(r.applied, 17)
  assert.equal(r.requests, 1, 'tentativas nao contam como pedidos')
  const lotes = s.pedidos.filter((p) => p.rota === 'batch')
  assert.equal(lotes.length, 3)
  assert.deepEqual(lotes[0], lotes[2])
})

test('timeout no lote: repetido quando ha tentativa; sem tentativa, lanca e a proxima chamada entrega de novo', async () => {
  const s = servico()
  const fontes = dezessete(s)
  s.falhas.push('pendura')
  const r = await leitor(s, { timeoutMs: 20 }).replaySources({ sources: fontes, onFacts: () => {} })
  assert.equal(r.applied, 17)

  // Sem tentativa: o primeiro pedido da chamada responde, o segundo pendura.
  const s2 = servico({ orcamento: 3 })
  dezessete(s2)
  const semTentativa = leitor(s2, { timeoutMs: 20, retries: 0 })
  const r1 = await semTentativa.replaySources({ sources: fontes, maxRequests: 2, onFacts: () => {} })
  assert.equal(r1.caughtUp, false)
  s2.falhas.push('ok', 'pendura')
  const caiu = coletor()
  await assert.rejects(
    semTentativa.replaySources({ sources: fontes, resume: r1.resume, onFacts: caiu.onFacts }),
    RetickTimeoutError,
  )
  assert.ok(caiu.ordem.length > 0, 'a chamada que caiu chegou a entregar fatos')
  const depois = coletor()
  const r2 = await semTentativa.replaySources({ sources: fontes, resume: r1.resume, onFacts: depois.onFacts })
  assert.equal(r2.caughtUp, true)
  // Do checkpoint r1 em diante tudo chega, inclusive o que a chamada que caiu ja tinha entregado.
  assert.equal(r1.applied + r2.applied, 17)
  for (const [source, vs] of caiu.porFonte) {
    assert.deepEqual(depois.porFonte.get(source)?.slice(0, vs.length), vs, source)
  }
})

test('maxRequests para no meio, e as chamadas seguintes terminam sem perder nem repetir', async () => {
  const s = servico({ orcamento: 2 })
  const fontes = dezessete(s)
  const c = coletor()
  let resume: Record<string, ReplayCheckpoint> | undefined
  let chamadas = 0
  for (;;) {
    chamadas += 1
    const r = await leitor(s).replaySources({ sources: fontes, maxRequests: 2, onFacts: c.onFacts, ...(resume ? { resume } : {}) })
    resume = r.resume
    assert.ok(r.requests >= 1)
    if (r.caughtUp) break
    assert.ok(chamadas < 20)
  }
  assert.ok(chamadas > 1)
  for (const [i, source] of fontes.entries()) assert.deepEqual(c.porFonte.get(source), i < 3 ? [1, 2, 3] : [1, 2])
})

test('servico sem a rota de lote: o erro diz para usar replay()', async () => {
  const s = servico()
  s.falhas.push('404')
  await assert.rejects(
    leitor(s).replaySources({ sources: ['a'], onFacts: () => {} }),
    (e: unknown) => e instanceof RetickHttpError && e.status === 404 && /replay\(\)/.test(e.message),
  )
})

test('resposta que fala de fonte nao pedida nao passa em silencio', async () => {
  const s = servico()
  s.publicar({ source: 'a', sourceVersion: 1 }, { source: 'intrusa', sourceVersion: 1 })
  const torto = (async (url: string, init: RequestInit) => {
    const corpo = JSON.parse(String(init.body)) as { sources: { source: string }[] }
    const trocado = { ...corpo, sources: [{ source: 'intrusa', position: 0 }] }
    return s.fetch(url, { ...init, body: JSON.stringify(trocado) })
  }) as unknown as typeof fetch
  await assert.rejects(leitor(s, { fetch: torto }).replaySources({ sources: ['a'], onFacts: () => {} }), RetickError)
})

test('fato liberado depois de um retido nao sai de novo quando o retido e liberado', async () => {
  // Log de a: v1, v4 (retido), v2 (liberado). O checkpoint volta para antes do
  // v4, e o v2 sera lido de novo: so o que o checkpoint lembra impede a repeticao.
  const s = servico()
  s.publicar({ source: 'a', sourceVersion: 1 }, { source: 'a', sourceVersion: 4 }, { source: 'a', sourceVersion: 2 })
  const c = leitor(s)
  const um = coletor()
  const r1 = await c.replaySources({ sources: ['a'], onFacts: um.onFacts })
  assert.deepEqual(um.porFonte.get('a'), [1, 2])
  s.publicar({ source: 'a', sourceVersion: 3 })
  const dois = coletor()
  await c.replaySources({ sources: ['a'], resume: r1.resume, onFacts: dois.onFacts })
  assert.deepEqual(dois.porFonte.get('a'), [3, 4])
})

test('primeira versao fora do mapa e lacuna logo depois: o piso vem do servico, e o v3 espera o v2', async () => {
  const s = servico({ oculto: 'secret' })
  s.publicar({ source: 'a', sourceVersion: 1, entityType: 'secret' }, { source: 'a', sourceVersion: 3 })
  const c = leitor(s)
  const um = coletor()
  const r1 = await c.replaySources({ sources: ['a'], onFacts: um.onFacts })
  assert.equal(um.ordem.length, 0)
  assert.equal(r1.held, 1)
  s.publicar({ source: 'a', sourceVersion: 2 })
  const dois = coletor()
  await c.replaySources({ sources: ['a'], resume: r1.resume, onFacts: dois.onFacts })
  assert.deepEqual(dois.porFonte.get('a'), [2, 3])
})

test('pagina de uma posicao que nao foi pedida e recusada, mesmo sendo da fonte certa', async () => {
  const s = servico()
  s.publicar({ source: 'a', sourceVersion: 1 }, { source: 'a', sourceVersion: 2 })
  const c = leitor(s)
  const r1 = await c.replaySources({ sources: ['a'], limit: 1, maxRequests: 1, onFacts: () => {} })
  const doInicio = (async (url: string, init: RequestInit) => {
    const corpo = JSON.parse(String(init.body)) as { sources: { source: string; position: number }[] }
    const trocado = { ...corpo, sources: corpo.sources.map((x) => ({ ...x, position: 0 })) }
    return s.fetch(url, { ...init, body: JSON.stringify(trocado) })
  }) as unknown as typeof fetch
  await assert.rejects(
    leitor(s, { fetch: doInicio }).replaySources({ sources: ['a'], resume: r1.resume, onFacts: () => {} }),
    /did not ask for/,
  )
})

test('resposta que nao avanca fonte nenhuma para a chamada em vez de pedir de novo para sempre', async () => {
  let n = 0
  const parado = (async (_url: string, init: RequestInit) => {
    if (++n > 50) throw new Error('o cliente nao parou')
    const corpo = JSON.parse(String(init.body)) as { sources: { source: string; position: number }[] }
    const pages = corpo.sources.map(({ source, position }) => ({
      read: 1,
      project: 'acme',
      source,
      facts: [],
      cursor: { from: position, next: position, total: position + 1, hasMore: true },
      withheld: { type: 0, sensitivity: 0 },
      state: null,
    }))
    return new Response(JSON.stringify({ read: 1, project: 'acme', pages, deferred: [] }), { status: 200 })
  }) as unknown as typeof fetch
  await assert.rejects(
    leitor(servico(), { fetch: parado, retries: 0 }).replaySources({ sources: ['a'], onFacts: () => {} }),
    /advanced no source/,
  )
})

test('fonte adiada abre o pedido seguinte mesmo quando outra veio antes dela na lista', async () => {
  // Pagina de 1 e orcamento de 2: a e b leem um fato cada, c e o resto sao adiados.
  const s = servico({ orcamento: 2 })
  const fontes = dezessete(s)
  await leitor(s).replaySources({ sources: fontes, limit: 1, onFacts: () => {} })
  const lotes = s.pedidos.filter((p) => p.rota === 'batch')
  assert.deepEqual(lotes[0]?.fontes.slice(0, 3), ['user-a', 'user-b', 'user-c'])
  assert.equal(lotes[1]?.fontes[0], 'user-c')
})
