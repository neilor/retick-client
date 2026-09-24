# Contribuir

## Rodar

```sh
npm install
npm run typecheck
npm test
./scripts/provar-instalacao-avulsa.sh
```

## Uma coisa que surpreende

Este repositorio nao tem a suite inteira. Os testes que exercitam o cliente
contra um Retick de verdade — `producer` e `consumer` — precisam do servico do
outro lado, e o servico e de um repositorio privado. Aqui ficam os 53 testes
que nao precisam dele: o leitor do Agora, o loteamento e a camada de rede com
`fetch` injetado.

Isso e de proposito e esta explicado no README, em "O que este repositorio nao
tem". O que voce ganha em troca: os testes que estao aqui rodam sem nenhuma
preparacao, e o `provar-instalacao-avulsa.sh` verifica o artefato de verdade —
empacota, instala fora da arvore, importa pelo nome e executa.

Se voce mudar `src/`, a mudanca precisa passar pelos dois repositorios antes de
ir para o registro. Abra o PR aqui mesmo assim: a conversa acontece aqui.

## Estilo

Sem dependencias. Esta e a regra que mais restringe e a que mais vale: quem
instala este pacote instala este pacote, e nada mais.

`npm run typecheck` roda em modo estrito com `noUncheckedIndexedAccess`. Se o
tipo reclamar, quase sempre ele esta certo.
