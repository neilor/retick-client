# Exemplo minimo

Um arquivo, uma dependencia, duas chamadas.

```sh
npm install
RETICK_URL=https://seu-retick RETICK_TOKEN=rtk_... npm start
```

Rode duas vezes. Na primeira o fato e aceito; na segunda ele volta como
duplicado, e nao como erro — e essa e a propriedade que o cliente existe para
te dar de graca.

Se voce nao tem um Retick a mao e esta no monorepo do nucleo, `npm run
sdk:exemplo-minimo` sobe um de mentira nenhuma numa porta livre, emite um token
que morre com o processo e roda este mesmo arquivo contra ele.
