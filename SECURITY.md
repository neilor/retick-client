# Seguranca

## Reportar uma falha

Abra um
[security advisory privado](https://github.com/neilor/retick-client/security/advisories/new)
neste repositorio. So voce e os mantenedores enxergam, e da para discutir a
correcao antes de ela existir. Nao abra issue publica para falha de seguranca.

O canal e esse e nao um endereco de e-mail de proposito: endereco em arquivo de
repositorio publico e colhido por robo, e o advisory ja carrega a conversa, o
CVE e a publicacao coordenada.

Espere um primeiro retorno em ate 5 dias uteis. Este e um projeto pequeno e
mantido por uma pessoa; o prazo e uma estimativa honesta, nao um SLA.

## O que este pacote faz com a sua credencial

O token vai num cabecalho `Authorization: Bearer` e em nenhum outro lugar. Ele
nao e gravado em disco, nao entra em log e nao aparece em mensagem de erro —
`test/rede.test.ts` cobre os dois ultimos casos, inclusive o de token com
formato desconhecido, que nao e ecoado nem em pedaco.

O pacote nao tem dependencias. A superficie que voce audita e a deste
repositorio e a do Node.

## Versoes que recebem correcao

Enquanto a versao comecar com `0.`, so a ultima minor recebe correcao. A regra
muda em `1.0.0`, e ela esta no README.
