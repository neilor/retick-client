/**
 * Portao de publicacao do @retick/client.
 *
 * Roda em `prepublishOnly`, e nao em `prepack`: `npm pack` e `npm publish
 * --dry-run` nao passam por aqui de proposito, para que empacotar de graca
 * continue barato. Quem barra o empacotamento e ninguem; quem barra a
 * publicacao e este arquivo.
 *
 * Tres perguntas, todas respondiveis offline. Se alguma falhar, a publicacao
 * para antes de qualquer byte sair da maquina.
 *
 *   1. Alguem quis publicar? `RETICK_PUBLICAR_SDK=sim`. Um `npm publish`
 *      digitado por engano no diretorio errado nao passa.
 *   2. A versao tem entrada no CHANGELOG? Publicar versao sem nota e como
 *      publicar sem dizer o que mudou.
 *   3. LICENSE e NOTICE estao no diretorio? A Apache-2.0 exige distribuir a
 *      licenca; o NOTICE e convencao, e esta aqui porque a licenca manda
 *      propaga-lo quando ele existe.
 *
 * O que este portao NAO faz: nao verifica se o escopo `@retick` e de quem
 * publica. Isso so o registro sabe, e ele responde na hora certa, com 402 ou
 * 403. Ver README, secao "O nome".
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pacote = dirname(dirname(fileURLToPath(import.meta.url)))
const falhas = []

if (process.env.RETICK_PUBLICAR_SDK !== 'sim') {
  falhas.push(
    'publicacao nao foi pedida de proposito.\n' +
      '    Neilor aprovou o pacote (evento agent.owner.sdk_publication_decided, 23/09),\n' +
      '    mas publicar e um ato deliberado e precisa ser dito:\n' +
      '      RETICK_PUBLICAR_SDK=sim npm publish --provenance',
  )
}

const { version } = JSON.parse(readFileSync(join(pacote, 'package.json'), 'utf8'))

const changelog = join(pacote, 'CHANGELOG.md')
if (!existsSync(changelog)) {
  falhas.push('nao ha CHANGELOG.md')
} else if (!readFileSync(changelog, 'utf8').includes(`## ${version}`)) {
  falhas.push(`o CHANGELOG.md nao tem entrada para a versao ${version}`)
}

for (const arquivo of ['LICENSE', 'NOTICE']) {
  if (!existsSync(join(pacote, arquivo))) {
    falhas.push(`falta ${arquivo} no diretorio do pacote`)
  }
}

if (falhas.length > 0) {
  console.error(`\n@retick/client ${version} nao foi publicado:\n`)
  for (const f of falhas) console.error(`  - ${f}`)
  console.error('')
  process.exit(1)
}

console.error(`@retick/client ${version}: portao aberto de proposito, publicando.`)
