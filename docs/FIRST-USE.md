# First use, the long version

The [quickstart](QUICKSTART.md) is the short path. This is the same journey with
the reasons attached: the project and its tenant key, sources, the API key,
publishing, and reading your facts back. Browsers, serverless producers and
apps with many sources have their own pages, linked where they come up.

Everything here describes `@retick/client` 0.3.0 and the service it talks to.
What the service does not do is listed in §10.

## 0. What you need

| | what | where it comes from |
|---|---|---|
| a service | the base URL of a Retick (`https://retick.dev`), without any `/api/...` suffix | whoever operates it |
| an account | a sign-in on that service's Console | an invitation |

**Access is closed.** Signing in with a Google account that nobody invited is
refused with *This account was not invited*, and nothing is created.

## 1. Workspaces and projects

- A **workspace** holds people and their roles.
- A **project** holds a log. It is the unit of isolation: its sources, positions
  and deduplication are its own, and two projects with the same source name and
  the same numbering never touch.

Create a project from the workspace page. Roles decide what you can do in it:
developers, admins and owners issue keys; owners register browser issuers.

## 2. The tenant key is not a credential

The project's **Overview** shows its **tenant key** (`prj_…`), and **Settings**
repeats it with a copy button. The server generates it, it is unique across the
service, and nobody can choose or change it.

| | tenant key | API key |
|---|---|---|
| what it is | the project's identifier | an authorization |
| shape | `prj_…` | `rt_…`, shown once |
| revocable | no | yes |
| safe to log | yes | no |
| grants anything | no | its operations, in this project |

**You never send the tenant key when publishing.** The project comes from the
key. A fact that carries `tenant`, `project` or `projeto` is refused with
`forbidden_field`.

You see the tenant key come back in `publish()`'s `project` field and in
`contract().scope.project`. That is the service telling you which project you
used.

You do send it in one place: the assertion your backend signs for a browser
session names the project by its tenant key. See [BROWSER.md](BROWSER.md).

## 3. Sources, and the numbering that is yours

A source is one sequence of facts with its own numbering: `orders`, `billing`,
one per user, one per room. Sources share nothing: not a counter, not an order,
not a position.

Declare sources in **Settings → Sources**. A key restricted to some sources can
only name declared ones. A key without a source restriction can also publish to
a source nobody declared yet, which is how an app opens a source per user or per
room as they appear.

`sourceVersion` is your number for each fact in its source. Retick never
assigns it, and this client does not generate it. Two properties follow:

- **Nothing is applied ahead of a hole.** A fact that arrives before a missing
  `sourceVersion` comes back `pending` and waits. When the missing one arrives,
  both go in, in order.
- **You do not have to start at 1.** The first fact a source receives sets its
  floor at `sourceVersion - 1`. Versions at or below the floor are not taken
  afterwards, so send the first fact of a new source alone and wait for its
  answer.

How to allocate versions when several instances publish to one source is in
[PRODUCERS.md](PRODUCERS.md).

## 4. The API key

In **Access → API keys**, **Issue key**. One `rt_` key, and you choose what it
can do in this project:

| operation | lets the key |
|---|---|
| `facts:publish` | publish facts (`createProducer`) |
| `log:read` | read the fact log (`createConsumer`) |
| `state:read` | read the current state of the project's entities from a server (`createStateReader` with `apiKey`) |
| `project:admin` | administer the project: sources, credentials and usage |

`project:admin` includes issuing other credentials, and a key issued by it keeps
working after it is revoked. Give it only to automation that needs it.

Under **Restrict further (optional)** you can limit the key to some sources and
limit which types a read returns. Leave both empty and the key reaches every
source of the project and reads every type. An expiry date is optional.

The secret appears once. Only its prefix and a hash are stored, and no route
gives it back. If it is lost, issue another and revoke the old one.

The Console also issues the older per-source credentials (`rtk_` to publish,
`rtl_` to read) under **Older per-source credentials**. New integrations use
`rt_` keys. The client still accepts the older families through `token`, for
existing integrations.

## 5. Install and configure

```sh
npm install @retick/client
```

Node 18.17 or newer, for `fetch`. No runtime dependencies.

```ts
import { createProducer } from '@retick/client'

const producer = createProducer({
  url: process.env.RETICK_URL!, // base URL, without /api/v1
  apiKey: process.env.RETICK_API_KEY!, // rt_…
  timeoutMs: 30_000,
  retries: 3,
})
```

A `url` that already carries `/api/v1` throws `RetickConfigError` at
construction, and so does an `apiKey` in a browser. The full option table is in
the [README](../README.md#options).

## 6. Publish your first fact

```ts
const result = await producer.publish([
  {
    eventId: 'order-1-placed',
    source: 'orders',
    sourceVersion: 1,
    type: 'order.placed',
    entityType: 'order',
    entityId: 'ORD-1',
    occurredAt: new Date().toISOString(),
    payload: { number: 'ORD-1', totalCents: 12900 },
  },
])
```

Six fields are required: `eventId`, `source`, `sourceVersion`, `type`,
`entityType` and `occurredAt`. **Send `payload` too, as an object.**
`GET /api/v1/contract` lists it as optional, and the publish route refuses a
fact without it (`payload_not_object`).

`observedAt` (the service's clock) and the envelope version are set by the
service.

### What comes back

A refused fact does not throw. It comes back in `outcomes` with
`status: 'rejected'`, a stable `reason` code (`missing_field`,
`payload_not_object`, `source_out_of_scope`, ...) and a `message`. The rest of
the batch still goes in, and the HTTP status is `422` instead of `200`.

| `status` | what happened |
|---|---|
| `accepted` | in, ordered |
| `duplicate` | already in; nothing changed |
| `stale` | at or below the source's intact point; not stored |
| `pending` | ahead of a missing version; waiting for it |
| `rejected` | not in; `reason` says why |

Run the publish twice: the second run returns `duplicate`, because the
deduplication key is `(source, tenant, eventId)`. That makes a resend after a
timeout safe, and it is why this client retries. What each status means for a
producer that lost an answer is in [PRODUCERS.md](PRODUCERS.md).

An `accepted` outcome may carry `projected`. It refers to the service's older
compact projection and says nothing about whether the Console shows your fact.

### Where to see it

The project's Overview lists recent facts under **Latest facts**. The **Studio**
draws the entities your facts describe, one column per `entityType`, and an
inspector with the recent facts about each entity. It shows any `entityType`;
there is no vocabulary to adopt.

The Studio shows **state, not history**. If you publish `order.placed` and then
`order.paid` for the same entity, you see one order, with the fields of both.

## 7. Read your own project back

Reading is a separate operation on the same kind of key. Issue a key with
`log:read` (or add it to the one you have), and read with `createConsumer`:

```ts
import { createConsumer, type ReplayCheckpoint } from '@retick/client'

const consumer = createConsumer({ url: process.env.RETICK_URL!, apiKey: process.env.RETICK_API_KEY! })

const saved: ReplayCheckpoint | undefined = await loadCheckpoint('orders')
const result = await consumer.replay({
  source: 'orders',
  resume: saved,
  onFacts: (facts) => {
    for (const f of facts) apply(f)
  },
})
await saveCheckpoint('orders', result.resume)
```

`replay` pulls until caught up and hands facts over in `sourceVersion` order.
Persist `result.resume`, one per source, and hand it back next time. Do not
resume from `result.position`: that is the 0.2.0 checkpoint, and it loses facts
held behind a gap.

The service hands facts over in **arrival** order. A producer that sent 1, then
4, then 2 and 3 produced a log that reads `1, 4, 2, 3`. `replay` restores
`sourceVersion` order on this side. `pull` gives you one raw page if you would
rather handle that yourself.

`result.withheld` counts facts the key did not let through, by reason (`type`,
`sensitivity`): a count, never the content. A key with no type restriction
reads every type with its whole payload.

Several sources, order across them and the batch read route are in
[MANY-SOURCES.md](MANY-SOURCES.md).

## 8. Reading from a browser

A page never holds an `rt_` key. Your backend authenticates the user, chooses the
sources that user may see, and exchanges a short signed assertion for a browser
credential. The page reads with `createStateReader`. The whole path, including
the registration an owner makes in **Access → Browser apps**, is in
[BROWSER.md](BROWSER.md).

## 9. Handling keys without leaking them

The client keeps the key in memory, sends it in an `Authorization` header and
writes it nowhere. An error never contains an `rt_` secret.

Your side:

- read it from the environment or a secret manager, never from a file in the
  repository or a constant in code;
- it belongs to a server. Shipping it to a browser hands a visitor whatever the
  key can do. The client refuses `apiKey` in a browser for that reason;
- give each key the operations it needs and nothing more: a producer does not
  need `log:read`, and almost nothing needs `project:admin`;
- name environment variables per project. A single `RETICK_API_KEY` in a shell
  with two projects open is how facts land in the wrong project, and they land
  there without any error;
- `RetickError` is safe to log in full. A hand-rolled
  `JSON.stringify(options)` is not.

## 10. What is not there

- The service never numbers facts. `sourceVersion` is always yours.
- No order or position across sources. Positions are per source.
- No batch method in 0.3.0. The service answers `POST /api/read/v1/batch`,
  which a server calls over HTTP ([MANY-SOURCES.md](MANY-SOURCES.md)).
- No archiving or deletion of sources.
- No rate limit on publishing or reading. There is a size limit
  (`contract().limits`). The browser state routes do limit requests and answer
  `429` with `retry-after`, which `createStateReader` honours.
- Durability depends on the deployment. `contract().durability` reports
  `durable` and `shared` for the service you are talking to.

## Where the rules come from

`src/types.ts` in this package carries the publication contract: required and
forbidden fields, the five statuses, the limits and the routes. It is a copy of
the service's own, kept apart so that this package speaks HTTP without pulling a
server into your dependency tree.
