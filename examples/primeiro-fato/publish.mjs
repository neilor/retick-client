// Step 5 of docs/FIRST-USE.md: publish your first facts.
//
//   npm install
//   RETICK_URL=https://retick.example \
//   RETICK_TOKEN=rtk_... \
//   RETICK_SOURCE=orders \
//   npm run publish
//
// Two facts, on purpose. The first one uses the vocabulary the Agora
// projection understands today, so it shows up in the Console's Estado Live.
// The second uses a vocabulary of its own, is stored and ordered exactly the
// same, and does not show up anywhere. Seeing both in one run is cheaper than
// discovering the difference a week later.
//
// Run it twice. The second run returns duplicates instead of errors: the
// deduplication key is (source, tenant, eventId), which is what makes a resend
// after a timeout safe.

import { createProducer, RetickAuthError, RetickConfigError, RetickError } from '@retick/client'

const url = process.env.RETICK_URL
const token = process.env.RETICK_TOKEN
const source = process.env.RETICK_SOURCE ?? 'orders'

if (!url || !token) {
  console.error('set RETICK_URL and RETICK_TOKEN. RETICK_SOURCE defaults to "orders".')
  console.error('RETICK_URL is the base URL, without the /api/v1 suffix.')
  process.exit(2)
}

const occurredAt = new Date().toISOString()

const facts = [
  {
    // `dispatch` is one of the six entityTypes the Agora reduces, and `code`,
    // `title` and `state` are the keys its reducer reads. Publishing this
    // vocabulary is what puts a fact on the Console's screen today.
    eventId: 'first-use-0001',
    source,
    sourceVersion: 1,
    type: 'order.placed',
    entityType: 'dispatch',
    entityId: 'ORD-1',
    occurredAt,
    payload: { code: 'ORD-1', title: 'First order', state: 'QUEUED' },
  },
  {
    // Your own entityType. Validated, deduplicated, ordered, counted in the
    // cursor — and `projected: false`, because no reducer claims to understand
    // it. Nothing fails, and nothing renders.
    eventId: 'first-use-0002',
    source,
    sourceVersion: 2,
    type: 'order.placed',
    entityType: 'order',
    entityId: 'ORD-2',
    occurredAt,
    payload: { number: 'ORD-2', totalCents: 12900, currency: 'BRL' },
  },
]

try {
  // Built inside the try so that a bad `url` — one that already carries the
  // /api/v1 suffix — lands in the RetickConfigError branch below instead of
  // crashing before any of this reads.
  const producer = createProducer({ url, token })
  const result = await producer.publish(facts)

  console.log(`project           ${result.project}`)
  console.log(`accepted          ${result.accepted}`)
  console.log(`duplicates        ${result.duplicates}`)
  for (const o of result.outcomes) {
    const tipo = facts[o.index].entityType
    console.log(
      `fact ${o.index} (${tipo})  ${o.status} projected=${o.projected ?? false}${o.reason ? ` reason=${o.reason}` : ''}`,
    )
  }
  console.log(`changes           ${result.changes.length}`)

  // The cursor of the source you just wrote to. `contiguous` is the last
  // sourceVersion with no hole behind it, which is what says the log is intact
  // rather than merely non-empty.
  const contract = await producer.contract()
  const state = contract.sources.find((s) => s.source === source)
  console.log(`scope             ${contract.scope.project} / ${contract.scope.sources.join(', ')}`)
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
    console.error(`credential refused: ${e.message}`)
    console.error('a publication credential starts with rtk_ and is shown once, at issue time.')
    process.exit(3)
  }
  if (e instanceof RetickError) {
    console.error(`${e.name}: ${e.message} (retryable: ${e.retryable})`)
    process.exit(4)
  }
  throw e
}
