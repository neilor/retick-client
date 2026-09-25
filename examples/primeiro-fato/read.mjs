// Step 7 of docs/FIRST-USE.md: read your own project back.
//
//   RETICK_URL=https://retick.example \
//   RETICK_READ_TOKEN=rtl_... \
//   RETICK_SOURCE=orders \
//   npm run read
//
// A different credential, not a flag on the same one. Passing the rtk_ from
// publish.mjs here throws RetickConfigError before anything leaves the machine.

import { createConsumer, RetickAuthError, RetickConfigError, RetickError } from '@retick/client'

const url = process.env.RETICK_URL
const token = process.env.RETICK_READ_TOKEN
const source = process.env.RETICK_SOURCE ?? 'orders'

if (!url || !token) {
  console.error('set RETICK_URL and RETICK_READ_TOKEN. RETICK_SOURCE defaults to "orders".')
  process.exit(2)
}

try {
  // Inside the try on purpose: handing this a publication token (rtk_) throws
  // RetickConfigError right here, before anything leaves the machine, and that
  // refusal is one of the things this example exists to show.
  const consumer = createConsumer({ url, token })

  const contract = await consumer.contract()
  console.log(`scope             ${contract.scope.project} / ${contract.scope.sources.join(', ')}`)
  console.log(`capabilities      ${contract.token.capabilities.join(', ')}`)
  // The type map is the cut. An empty one withholds every fact, and that is
  // what a credential issued from the Console looks like today — see
  // docs/FIRST-USE.md section 7.
  const tipos = Object.keys(contract.scope.types)
  console.log(`visible types     ${tipos.length === 0 ? '(none)' : tipos.join(', ')}`)

  // replay pulls until caught up and hands facts over in sourceVersion order,
  // whatever order they arrived in. `position` is the cursor: persist it and
  // hand it back next time, and you resume instead of re-reading.
  const seen = []
  const result = await consumer.replay({
    source,
    position: 0,
    onFacts: (facts) => {
      for (const f of facts) seen.push(f)
    },
  })

  console.log(`applied           ${result.applied}`)
  console.log(`held by a gap     ${result.held}`)
  console.log(`withheld by scope ${result.withheld.type} type, ${result.withheld.sensitivity} sensitivity`)
  console.log(`next position     ${result.position}`)

  for (const f of seen) {
    console.log(`  #${f.position} v${f.sourceVersion} ${f.type} ${f.entityId ?? ''} ${JSON.stringify(f.payload)}`)
  }
} catch (e) {
  if (e instanceof RetickConfigError) {
    // This is the branch a publication token lands in, and it is on purpose:
    // the separation is in the token format, so there is no code path where one
    // credential does the other one's job.
    console.error(`configuration: ${e.message}`)
    process.exit(2)
  }
  if (e instanceof RetickAuthError) {
    console.error(`credential refused: ${e.message}`)
    console.error('a read credential starts with rtl_, and it is a second issue, not the same one.')
    process.exit(3)
  }
  if (e instanceof RetickError) {
    console.error(`${e.name}: ${e.message} (retryable: ${e.retryable})`)
    process.exit(4)
  }
  throw e
}
