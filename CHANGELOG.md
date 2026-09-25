# Changelog

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o
versionamento segue [SemVer](https://semver.org/lang/pt-BR/).

Enquanto a versao comecar com `0.`, **um bump de minor pode quebrar**. A regra
de `1.0.0` esta no README, em "Versionamento".

## Nao lancado

Documentacao e exemplos. Nenhuma mudanca em `src/`, e nada disto vai no tarball.

### Adicionado

- `docs/QUICKSTART.md`: do zero ate um fato visivel na Console, em seis passos.
- `docs/FIRST-USE.md`: a mesma jornada com as razoes, a diferenca entre chave de
  projeto e credencial, e os dois pontos onde o produto para hoje — o mapa de
  tipos vazio de uma credencial de leitura emitida pela Console, e o emissor que
  precisa estar cadastrado antes de `createAgoraReader` funcionar.
- `docs/TROUBLESHOOTING.md`: as recusas reais de cada superficie, agrupadas pelo
  que voce estava fazendo quando aconteceram.
- `examples/primeiro-fato/`: publicar e ler de volta, em dois arquivos. O
  repositorio do nucleo roda estes dois, sem alterar uma linha, contra uma pilha
  Retick de verdade.
- `examples/nextjs/`: o mesmo de um app Next, com a credencial presa ao servidor.

## 0.2.0 — 2026-09-24

Primeira versao destinada a um registro publico. O codigo e o mesmo de `0.1.0`;
o que mudou e tudo o que faltava para alguem de fora instalar, entender e
confiar no pacote.

### Adicionado

- `NOTICE` e `CHANGELOG.md` no que vai junto no pacote.
- `src/` no `files`, para que os source maps e os declaration maps que ja eram
  gerados resolvam de verdade em vez de apontar para nada.
- `keywords`, `homepage`, `bugs` e `author` no `package.json`.
- Exemplo minimo autocontido em `examples/minimo/`, que instala o pacote pelo
  nome e publica contra um Retick que ele mesmo sobe.
- Integracao continua: testes e typecheck em Node 22 e Node 24, e prova de
  instalacao do tarball em Node 18, 20, 22 e 24.
- Publicacao com proveniencia (`--provenance`) e SBOM CycloneDX por release.

### Mudado

- `repository` passa a apontar para o repositorio publico do cliente, e nao
  para o monorepo privado do nucleo.
- O portao de publicacao virou `scripts/portao-de-publicacao.mjs`: alem de
  exigir `RETICK_PUBLICAR_SDK=sim`, ele confere que a versao tem entrada aqui
  e que `LICENSE` e `NOTICE` estao no lugar.

### Nao mudou

- A superficie publica. Nenhum export foi adicionado, removido ou renomeado em
  relacao a `0.1.0`. Quem ja usava o tarball `0.1.0` troca a origem e nada mais.

## 0.1.0 — 2026-09-22

Nunca publicado em registro. Distribuido apenas como tarball por `npm pack`, e
e nessa forma que o Exo o consome ate hoje.

### Adicionado

- `createProducer`: publicacao em lote com os tres limites do contrato,
  repeticao com recuo em `5xx` e em falha de rede, `422` separando o que passou
  do que foi recusado, e o token nunca em disco nem em mensagem de erro.
- `createConsumer`: leitura do proprio escopo por cursor, `pull`, `replay` e
  `OrderedBuffer`.
- `createAgoraReader`: leitura da projecao compacta do Agora a partir do
  navegador, com credencial `rtv_` e revogacao.
- Hierarquia de erros com `RetickError` na raiz.
