// Step 6 of docs/FIRST-USE.md: publish your first facts.
//
//   npm install
//   RETICK_URL=https://retick.dev \
//   RETICK_API_KEY=rt_... \
//   RETICK_SOURCE=orders \
//   npm run publish
//
// Two facts about the same order, in one source: placed, then paid. The
// Console's Studio shows one order with the fields of both, because it draws
// state, not history.
//
// Run it twice. The second run returns duplicates instead of errors: the
// deduplication key is (source, tenant, eventId), which is what makes a resend
// after a timeout safe.

import { createProducer, RetickAuthError, RetickConfigError, RetickError } from '@retick/client'

const url = process.env.RETICK_URL
const apiKey = process.env.RETICK_API_KEY
const source = process.env.RETICK_SOURCE ?? 'orders'

if (!url || !apiKey) {
  console.error('set RETICK_URL and RETICK_API_KEY. RETICK_SOURCE defaults to "orders".')
  console.error('RETICK_URL is the base URL, without the /api/v1 suffix.')
  process.exit(2)
}

const facts = [
  {
    eventId: 'first-use-0001',
    source,
    // Your numbering for this source. Versions 1 and 2 here; a real producer
    // takes them from its own records (docs/PRODUCERS.md).
    sourceVersion: 1,
    type: 'order.placed',
    entityType: 'order',
    entityId: 'ORD-1',
    occurredAt: new Date().toISOString(),
    payload: { number: 'ORD-1', totalCents: 12900, currency: 'BRL', status: 'placed' },
  },
  {
    eventId: 'first-use-0002',
    source,
    sourceVersion: 2,
    type: 'order.paid',
    entityType: 'order',
    entityId: 'ORD-1',
    occurredAt: new Date().toISOString(),
    payload: { status: 'paid' },
  },
]

try {
  // Built inside the try so that a bad `url` (one that already carries the
  // /api/v1 suffix) or a malformed key lands in the RetickConfigError branch.
  const producer = createProducer({ url, apiKey })
  const result = await producer.publish(facts)

  console.log(`project           ${result.project}`)
  console.log(`accepted          ${result.accepted}`)
  console.log(`duplicates        ${result.duplicates}`)
  for (const o of result.outcomes) {
    console.log(`fact ${o.index} (${facts[o.index].type})  ${o.status}${o.reason ? ` reason=${o.reason}` : ''}`)
  }

  // The cursor of the source you just wrote to. `contiguous` is the last
  // sourceVersion with no hole behind it, which says the source is intact
  // rather than merely non-empty.
  const contract = await producer.contract()
  const state = contract.sources.find((s) => s.source === source)
  console.log(`contiguous        ${state?.contiguous ?? 0}`)
  console.log(`durable / shared  ${contract.durability.durable} / ${contract.durability.shared}`)
} catch (e) {
  // Three failures worth telling apart, because each sends you somewhere else.
  // docs/TROUBLESHOOTING.md has the full table.
  if (e instanceof RetickConfigError) {
    console.error(`configuration: ${e.message}`)
    process.exit(2)
  }
  if (e instanceof RetickAuthError) {
    console.error(`key refused: ${e.message} (${e.code ?? ''} ${e.reason ?? ''})`)
    console.error('the key needs facts:publish. Its secret starts with rt_ and is shown once, when issued.')
    process.exit(3)
  }
  if (e instanceof RetickError) {
    console.error(`${e.name}: ${e.message} (retryable: ${e.retryable})`)
    process.exit(4)
  }
  throw e
}
