// O menor programa util com o @retick/client: publica um fato e le o cursor.
//
//   npm install
//   RETICK_URL=https://seu-retick RETICK_TOKEN=rtk_... npm start
//
// Reenviar o mesmo eventId e seguro de proposito: a chave de deduplicacao e
// (source, tenant, eventId), entao a segunda chamada devolve duplicates e nao
// um erro. E por isso que voce pode repetir sem pensar.

import { createProducer } from '@retick/client'

const url = process.env.RETICK_URL
const token = process.env.RETICK_TOKEN

if (!url || !token) {
  console.error('defina RETICK_URL e RETICK_TOKEN')
  process.exit(1)
}

const producer = createProducer({ url, token })

const fato = {
  eventId: 'exemplo-minimo-1', // seu id, e a chave de deduplicacao
  source: 'billing', // precisa estar no escopo do seu token
  sourceVersion: 1, // sua numeracao, monotonica por fonte
  type: 'invoice.issued',
  entityType: 'invoice',
  entityId: 'INV-1',
  occurredAt: new Date().toISOString(),
  payload: { number: 'INV-1' },
}

const resultado = await producer.publish([fato])
console.log('aceitos:', resultado.accepted, '| duplicados:', resultado.duplicates)
console.log('estado do fato:', resultado.outcomes[0].status)

const contrato = await producer.contract()
console.log('projeto:', contrato.scope.project)
console.log('cursor contiguo em billing:', contrato.sources.find((s) => s.source === 'billing')?.contiguous)
