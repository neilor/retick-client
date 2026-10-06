# Exemplo minimo

Um arquivo, uma dependencia, duas chamadas.

```sh
npm install
RETICK_URL=https://retick.dev RETICK_API_KEY=rt_... npm start
```

A chave precisa de `facts:publish` e alcancar a fonte `billing`.

Rode duas vezes. Na primeira o fato e aceito; na segunda ele volta como
duplicado, e nao como erro. Reenviar o mesmo fato e seguro, e essa e a
propriedade que o cliente existe para te dar.
