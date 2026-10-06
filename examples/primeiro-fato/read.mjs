// Step 7 of docs/FIRST-USE.md: read your own project back.
//
//   RETICK_URL=https://retick.dev \
//   RETICK_API_KEY=rt_... \
//   RETICK_SOURCE=orders \
//   npm run read
//
// The key needs log:read. The checkpoint is kept in .retick-resume.json next to
// this file, so a second run reads only what is new.

import { readFileSync, writeFileSync } from 'node:fs'
import { createConsumer, RetickAuthError, RetickConfigError, RetickError } from '@retick/client'

const url = process.env.RETICK_URL
const apiKey = process.env.RETICK_API_KEY
const source = process.env.RETICK_SOURCE ?? 'orders'
const checkpointFile = new URL('./.retick-resume.json', import.meta.url)

if (!url || !apiKey) {
  console.error('set RETICK_URL and RETICK_API_KEY. RETICK_SOURCE defaults to "orders".')
  process.exit(2)
}

let resume
try {
  resume = JSON.parse(readFileSync(checkpointFile, 'utf8'))
} catch {
  resume = undefined // first run: read from the beginning
}

try {
  const consumer = createConsumer({ url, apiKey })

  // replay pulls until caught up and hands facts over in sourceVersion order,
  // whatever order they arrived in. `resume` is the checkpoint: store it after
  // you applied the facts, and hand it back next time. Do not resume from
  // `position`, which loses facts held behind a gap.
  /** @type {import('@retick/client').ReadFact[]} */
  const seen = []
  const result = await consumer.replay({
    source,
    resume,
    onFacts: (facts) => {
      for (const f of facts) seen.push(f)
    },
  })

  for (const f of seen) {
    console.log(`  v${f.sourceVersion} ${f.type} ${f.entityId ?? ''} ${JSON.stringify(f.payload)}`)
  }
  console.log(`applied           ${result.applied}`)
  console.log(`held by a gap     ${result.held}`)
  console.log(`withheld by scope ${result.withheld.type} type, ${result.withheld.sensitivity} sensitivity`)

  writeFileSync(checkpointFile, JSON.stringify(result.resume))
} catch (e) {
  if (e instanceof RetickConfigError) {
    console.error(`configuration: ${e.message}`)
    process.exit(2)
  }
  if (e instanceof RetickAuthError) {
    console.error(`key refused: ${e.message} (${e.code ?? ''} ${e.reason ?? ''})`)
    console.error('reading needs a key with log:read.')
    process.exit(3)
  }
  if (e instanceof RetickError) {
    console.error(`${e.name}: ${e.message} (retryable: ${e.retryable})`)
    process.exit(4)
  }
  throw e
}
