#!/usr/bin/env bash
#
# Prova que o pacote empacota, instala e EXECUTA fora do repositorio, sem
# precisar de um Retick do outro lado.
#
#   packages/client/scripts/provar-instalacao-avulsa.sh [caminho-do-node]
#
# Existe porque `provar-instalacao.sh` sobe um Retick de verdade a partir de
# `src/ingestao`, e isso so existe no monorepo do nucleo. Este aqui roda em
# qualquer lugar, e e o que a integracao continua do repositorio publico usa
# para dizer "instala em Node 18, 20, 22 e 24".
#
# O que ele prova: o tarball tem o que diz ter, o import pelo NOME funciona, os
# nomes exportados estao la, os tipos chegam junto, e o codigo compilado roda
# de verdade nessa versao de Node.
#
# O que ele NAO prova: que o cliente e o servico concordam. Isso e o trabalho
# de `test/producer.test.ts` e `test/consumer.test.ts`, que precisam do nucleo
# e por isso vivem no monorepo privado.
set -euo pipefail

PACOTE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${1:-node}"
FORA="$(mktemp -d)"
trap 'rm -rf "$FORA"' EXIT

echo "── node: $("$NODE" --version)"

echo "── 1. build e empacotamento"
cd "$PACOTE"
rm -rf dist
npx --no-install tsc -p tsconfig.json 2>/dev/null || ./node_modules/.bin/tsc -p tsconfig.json 2>/dev/null || tsc -p tsconfig.json
TARBALL="$(npm pack --pack-destination "$FORA" --silent | tail -1)"
echo "   $TARBALL"

echo "── 2. um projeto que nao conhece este repositorio"
cd "$FORA"
cat > package.json <<'JSON'
{ "name": "consumidor-avulso", "version": "1.0.0", "type": "module", "private": true }
JSON
npm install --no-audit --no-fund --silent "$FORA/$TARBALL"
echo "   instalado: $("$NODE" -p "JSON.parse(require('fs').readFileSync('./node_modules/@retick/client/package.json','utf8')).version")"

echo "── 3. importar pelo nome, e usar"
cat > usar.mjs <<'JS'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import {
  createProducer,
  createConsumer,
  createAgoraReader,
  splitIntoBatches,
  OrderedBuffer,
  LIMITS,
  ENVELOPE_VERSION,
  REQUIRED_FIELDS,
  RetickError,
  RetickConfigError,
  RetickNetworkError,
} from '@retick/client'

// Os nomes chegaram.
for (const [nome, valor] of Object.entries({
  createProducer, createConsumer, createAgoraReader, splitIntoBatches, OrderedBuffer,
})) {
  assert.equal(typeof valor, 'function', `${nome} deveria ser funcao`)
}
assert.equal(ENVELOPE_VERSION, 1)
assert.ok(LIMITS.factsPerBatch > 0)
assert.ok(REQUIRED_FIELDS.includes('eventId'))
console.log(`   exports     envelope=${ENVELOPE_VERSION} fatosPorLote=${LIMITS.factsPerBatch}`)

// O codigo compilado executa: validacao de configuracao e erro tipado, nao TypeError.
assert.throws(() => createProducer({ url: '', token: 'rtk_0' }), RetickConfigError)
assert.throws(() => createConsumer({ url: 'https://x', token: 'rtk_publicacao' }), RetickConfigError)
console.log('   validacao   configuracao invalida vira RetickConfigError')

// O lote respeita o limite do contrato, sem servidor nenhum.
const fatos = Array.from({ length: LIMITS.factsPerBatch + 3 }, (_, i) => ({
  eventId: `e-${i}`, source: 'billing', sourceVersion: i + 1, type: 't',
  entityType: 'x', occurredAt: new Date().toISOString(), payload: {},
}))
const lotes = splitIntoBatches(fatos, LIMITS)
assert.ok(lotes.length >= 2, 'mais fatos que o limite deveria virar mais de um lote')
assert.equal(lotes[0].offset, 0)
assert.ok(lotes.every((l) => Buffer.byteLength(l.body) <= LIMITS.bodyBytes))
console.log(`   lote        ${fatos.length} fatos viraram ${lotes.length} lotes`)

// A camada de rede roda de verdade: porta fechada, erro da hierarquia do pacote.
const servidor = createServer(() => {})
servidor.listen(0, '127.0.0.1')
await once(servidor, 'listening')
const porta = servidor.address().port
servidor.close()
await once(servidor, 'close')

const erro = await createProducer({ url: `http://127.0.0.1:${porta}`, token: 'rtk_000000000000_x', retries: 0 })
  .publish([fatos[0]])
  .catch((e) => e)
assert.ok(erro instanceof RetickNetworkError, `esperava RetickNetworkError, veio ${erro?.constructor?.name}`)
assert.ok(erro instanceof RetickError)
console.log(`   rede        porta fechada -> ${erro.constructor.name}`)

// O token nunca aparece inteiro numa mensagem de erro.
assert.ok(!JSON.stringify({ m: erro.message, s: erro.stack }).includes('000000000000'))
console.log('   segredo     o token nao vazou para a mensagem de erro')
JS
"$NODE" usar.mjs

echo "── 4. os tipos chegam junto"
"$NODE" -e "
const fs = require('node:fs')
const d = './node_modules/@retick/client/dist/index.d.ts'
if (!fs.existsSync(d)) { console.error('   faltou o index.d.ts'); process.exit(1) }
const c = fs.readFileSync(d, 'utf8')
for (const nome of ['createProducer','createConsumer','createAgoraReader','Fact','ReadFact','PublishResult','ReadContract','AgoraSnapshot','RetickError']) {
  if (!c.includes(nome)) { console.error('   faltou ' + nome); process.exit(1) }
}
const src = './node_modules/@retick/client/src/index.ts'
if (!fs.existsSync(src)) { console.error('   faltou src/, e os source maps apontam para la'); process.exit(1) }
console.log('   tipos       index.d.ts completo, e src/ veio junto para os maps resolverem')
"

echo ""
echo "instalavel em $("$NODE" --version): saiu do repositorio, entrou noutro projeto e executou."
