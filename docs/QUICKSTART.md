# Quickstart

From nothing to a fact you can see in the Console, with `@retick/client` 0.3.0.
Five steps, one file.

You need an account on a Retick Console. Access is by invitation, so ask
whoever operates your Retick. The examples use `https://retick.dev`; use your
service's base URL if it is another one. The long version of every step is in
[FIRST-USE.md](FIRST-USE.md).

## 1. Open the project

Sign in to the Console, open a workspace and pick or create a project. The
project's **Overview** shows its **tenant key** (`prj_…`). It names the project
and authorizes nothing. You do not send it when publishing; the key carries it.

## 2. Declare a source

In **Settings → Sources**, declare a source called `orders`. A source is one
sequence of facts with its own numbering.

## 3. Issue a key

In **Access → API keys**, issue a key with `facts:publish` and `log:read`. Leave
the restrictions empty. The secret starts with `rt_`, appears once, and no route
gives it back. Keep it on a server, never in a page.

## 4. Install and publish

```sh
npm install @retick/client
```

Node 18.17 or newer.

```ts
import { createProducer } from '@retick/client'

const producer = createProducer({
  url: 'https://retick.dev', // base URL, without /api/v1
  apiKey: process.env.RETICK_API_KEY!,
})

const result = await producer.publish([
  {
    eventId: 'order-1-placed', // yours, and the deduplication key
    source: 'orders',
    sourceVersion: 1, // your numbering, one sequence per source
    type: 'order.placed',
    entityType: 'order',
    entityId: 'ORD-1',
    occurredAt: new Date().toISOString(),
    payload: { number: 'ORD-1', totalCents: 12900 },
  },
])

console.log(result.accepted, result.outcomes[0].status)
```

Prints `1 accepted`. Run it again and it prints `0 duplicate`: the
deduplication key is `(source, tenant, eventId)`, so resending is safe.

`examples/primeiro-fato/` is this as a project you can copy, with the read side.

## 5. See it in the Console

Reload the project. The Overview lists it under **Latest facts**, and the
**Studio** shows the `order` entity `ORD-1` with its fields. Any `entityType`
you publish appears there.

## Next

- the same journey with the reasons, and reading your facts back:
  [FIRST-USE.md](FIRST-USE.md)
- a producer that runs as serverless functions or several instances:
  [PRODUCERS.md](PRODUCERS.md)
- many sources, order across them, and the batch read route:
  [MANY-SOURCES.md](MANY-SOURCES.md)
- reading state from a browser, per user: [BROWSER.md](BROWSER.md)
- something refused you: [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- the client's surface, option by option: [../README.md](../README.md)
