# @retick/client

A TypeScript client for the Retick v1 publication gate. It publishes facts, reads back your own
scope and cursor, and handles batching, retries, timeouts and errors so a producer does not have
to write that code again.

Zero dependencies. It speaks HTTP to a frozen contract, and carries no core and no Firebase.

Apache-2.0.

## Start here

If you have a Retick and have never used it, [docs/QUICKSTART.md](docs/QUICKSTART.md)
goes from nothing to a fact visible in the Console in six steps.
[docs/FIRST-USE.md](docs/FIRST-USE.md) is the same journey with the reasons
attached, including the two places where the product stops short today, and
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) is what to do when something
refuses you.

The rest of this file is the client's own surface, option by option.

## Install

```sh
npm install @retick/client
```

`0.2.0` is the first release on npm, published from GitHub Actions on the `v0.2.0` tag.
Every tarball carries a signed provenance attestation, so `npm audit signatures` verifies which
repository, commit and workflow built it. `CHANGELOG.md` is the record of what changed.

Node 18.17 or newer, for `fetch`. CI installs the packed tarball and runs it on 18, 20, 22 and
24 on every push, so that floor is a measurement rather than a guess.

Running this repository's own test suite needs Node 22.18 or newer, because the tests are
TypeScript that Node strips types from directly. The published package is plain JavaScript and
does not care.

## Use

```ts
import { createProducer } from '@retick/client'
import type { Fact } from '@retick/client'

const producer = createProducer({
  url: 'https://retick.example',   // without the /api/v1 suffix
  token: process.env.RETICK_TOKEN!,
})

const fact: Fact = {
  eventId: 'invoice-2026-0001',    // your id; the deduplication key
  source: 'billing',               // must be in your token's scope
  sourceVersion: 1,                // your numbering, monotonic per source
  type: 'invoice.issued',
  entityType: 'invoice',
  occurredAt: new Date().toISOString(),
  payload: { number: 'INV-1' },
}

const result = await producer.publish([fact])
console.log(result.accepted, result.outcomes[0].status)

const contract = await producer.contract()
console.log(contract.scope.project, contract.sources[0]?.contiguous)
```

`examples/minimo/` is that, as a project you can copy: one file, one dependency, two calls.
`examples/primeiro-fato/` is the publish-and-read pair the first-use guide walks
through, and `examples/nextjs/` is the same thing from a Next app, with the
credential kept on the server side of the boundary.

## Reading back

The publication gate is write-only. Reading your own project is a separate
surface, with a separate credential:

```ts
import { createConsumer } from '@retick/client'

const consumer = createConsumer({ url: 'https://retick.example', token: process.env.RETICK_READ_TOKEN! })

await consumer.replay({
  source: 'billing',
  onFacts: (facts) => { for (const f of facts) apply(f) },
})
```

`replay` pulls until caught up and hands you facts in `sourceVersion` order. It
returns `{ position, applied, held, withheld }`; persist `position` and hand it
back next time.

The read token starts with `rtl_`, not `rtk_`. Passing a publication token to
`createConsumer` throws before anything leaves the machine — the separation is
in the token format, not in a capability flag, so there is no code path where
one credential does the other one's job.

**Order is the part that looks easy.** The service hands facts over in log
order, which is arrival order: a producer that sends 1, then 4, then 2 and 3
produces a log that reads `1, 4, 2, 3`. Log position only ever grows, which is
what makes it a usable cursor; the price is that `sourceVersion` order gets
restored on this side. `replay` does it, and `OrderedBuffer` is the piece, tested
without a server.

`pull` gives you one raw page if you want to handle the gaps yourself. A projection built from
those pages is pure functions over facts, and never calls the system of record.

## Reading the Agora from a browser

`createAgoraReader` is the third surface, and the only one meant for a tab. It
reads the compact projection the service already materialized, with an `rtv_`
credential the host supplies:

```ts
import { createAgoraReader } from '@retick/client'

const reader = createAgoraReader({
  url: 'https://retick.example',
  // The reader never learns where this comes from, and never stores what it returns.
  credentials: async () => mintFromMyOwnBackend(),
})

const unsubscribe = reader.subscribe((snapshot, freshness) => render(snapshot, freshness))
await reader.snapshot()
```

It holds nothing on disk — no `localStorage`, no cookie — and never puts the
token in a URL, which is why the live path is NDJSON over `fetch` and not
`EventSource`.

### Leaving is two different acts

| call | what it does | when |
|---|---|---|
| `close()` | forgets the credential here | unmount: route change, re-render, discarded tab |
| `revoke()` | `DELETE`s the session at the service, then forgets | someone deliberately logged out |

They are separate because only the host knows which happened. A reader that
revoked on every unmount would end the session of someone who clicked a link,
and the next screen would have to mint another one. Sessions that nobody
revokes end on their own `expiresAt`.

`revoke()` resolves to a `RevocationOutcome` and never throws:

| outcome | meaning |
|---|---|
| `revoked` | `204`. The service ended it, and the end is persisted. |
| `already-closed` | `401`. It already refuses this credential; the goal was met before you asked. |
| `nothing-to-revoke` | there was no credential in memory, so nothing was sent |
| `refused` | the service answered, but not with an end |
| `unreachable` | network failure or timeout; the session will expire on its own clock |

It sends at most one `DELETE` per reader, ever — repeat calls return the first
call's outcome without touching the network, and concurrent calls share one
request. It never asks `credentials()` for anything: a teardown that could mint
would be a teardown that opens a session in the middle of a logout. And
`revokeTimeoutMs` (default `2000`) caps how long it may hold whoever is logging
out, enforced both by the abort signal and by a race, so a `fetch` that ignores
its signal cannot hang an exit.


## Two calls, because the contract has two routes

`publish(facts)` splits the array into batches that fit the contract's limits and sends them one
at a time, in order. Order is the reason, not throughput. A fact that arrives ahead of a missing
`sourceVersion` comes back `pending` and waits, so sending batch 3 while batch 2 is in flight
would manufacture the gap that ordering exists to close.

`contract()` returns your scope, the limits in force and the cursor of each of your sources.

There is no third method. The v1 contract has two routes, and a client with more methods than
the service has routes would be inventing a surface nobody can honour.

## What comes back, and what throws

A rejected fact comes back in `outcomes` and does not throw. `422` means at least one fact was
rejected and the rest of the batch went in; the body has the same shape as a `200`:

| `status` | what happened |
|---|---|
| `accepted` | in, ordered and consolidated |
| `duplicate` | already in; nothing changed |
| `stale` | late resend of something already past the intact point |
| `pending` | arrived ahead of the sequence; waiting for the gap to close |
| `rejected` | not in; `reason` says why |

Five values, and the list is frozen. A sixth would be additive on paper and break every producer
that switched over the five.

What does throw:

| class | when | retried |
|---|---|---|
| `RetickAuthError` | `401`, `403` | no |
| `RetickRequestError` | `400`, `405`, `413` | no |
| `RetickServerError` | `5xx`, `429` | yes |
| `RetickSourceClosedError` | `503` naming a closed source | no |
| `RetickNetworkError` | never got an answer | yes |
| `RetickTimeoutError` | no answer inside `timeoutMs` | yes |
| `RetickConfigError` | no url, no token, url with the route suffix, publication token on the read surface | — |

All of them extend `RetickError`, which carries `retryable`.

`RetickSourceClosedError` deserves its own branch. It means what the service applied in memory
did not reach storage, so the whole batch fell, including the part that had passed: half-confirmed
would make you advance your cursor over a fact that exists nowhere. That pair stays closed until
the process comes back up, and `whatToDo` carries the service's own instruction. Do not advance
the cursor; resend from the last confirmed fact.

## Retries

Retrying is safe because publishing is idempotent on `(source, tenant, eventId)`: the same batch
sent twice comes back `duplicate` and moves nothing. That makes an unanswered request cheap to
repeat and an answered refusal pointless to repeat, which is the whole retry policy.

Backoff is exponential with full jitter, capped by `retryMaxDelayMs`. The jitter is there because
the failure this protects against is a service coming back up, and producers that all waited the
same amount would return in one wave. `Retry-After` wins over the calculated delay when the
service sends one.

`429` is retried and v1 never emits it, because there is a size limit and no rate limit. It is handled
because a proxy in front of the service can emit it, and meeting it unhandled costs a retry storm.

## Options

| option | default | |
|---|---|---|
| `url` | — | base URL, without `/api/v1` |
| `token` | — | `rtk_...`, held in memory only |
| `timeoutMs` | `30000` | per request, covering the body |
| `retries` | `3` | extra attempts after the first |
| `retryBaseDelayMs` | `200` | first backoff ceiling, doubling per attempt |
| `retryMaxDelayMs` | `5000` | cap on that ceiling |
| `limits` | contract values | batching limits |
| `fetch` | `globalThis.fetch` | for a test, a proxy agent, or a runtime without a global |
| `sleep`, `random` | real | injectable so tests do not spend seconds in backoff |

`limits` defaults to what the contract declares: 500 facts per batch, 1048576 body bytes, 65536
payload bytes per fact. An operator can configure the service lower, and `contract().limits`
reports what it actually enforces.

## What this client does not do

It does not generate `sourceVersion`. Numbering belongs to the origin, and a client that
generated it would be a second authority over order, and the two would disagree the first time a
process restarted.

It does not add an idempotency header. Idempotency in v1 is structural: the key is
`(source, tenant, eventId)` and it is already in the fact. A header would be a second, weaker key
that the service does not read.

It does not validate facts before sending. The service decides what it accepts, and refusing more
is never a compatible change: a client that pre-rejected would keep rejecting after the service
learned to accept.

It does not write the token anywhere. It is held in a closure and sent in an `Authorization`
header. Only the prefix `rtk_<12 hex>` appears in an error, which is what the service logs and
what identifies a credential for revocation. A token that does not match the format is not echoed
at all.

## Two traps

**Your `entityType` probably will not project.** v1 promises the fact is validated, deduplicated,
ordered and counted in the cursor. It does not promise anyone understood the content. Only five
`entityType`s have reducers (`dispatch`, `machine`, `session`, `block`, `approval`), and they
read keys in English that came from the first producer. Use one of those five with your own
vocabulary and you get `projected: true` with every field `null`, and nothing fails.

Publish with an `entityType` of your own and accept `projected: false`. The fact is still ordered,
deduplicated and in the cursor, which is what v1 promises.

Whether it shows up on the Console is a second question, with a second list.
[docs/FIRST-USE.md §5](docs/FIRST-USE.md#5-publish-your-first-fact) has both.

**`payload` is declared optional and required in practice.** `GET /api/v1/contrato` lists it as
optional; the route rejects a fact that arrives without it. That is divergence 17, the fix is one
line and strictly widening, and the type here follows the declared contract rather than today's
behaviour so that nothing has to change the day it lands. Until then, send an object.

## Where the rules come from

`src/types.ts` carries the contract in full: the envelope version, the required and forbidden
fields, the five fact statuses, the limits and the routes. Read it to find out what the service
promises.

It is a second copy and not an import, because importing the service's own copy would drag a
server into the dependency tree of a package whose job is to speak HTTP. A test in the core
repository fails when the two drift.

## The name

`retick` without a scope belongs to someone else on npm, an unrelated Redis task scheduler
published in 2017. So this package is `@retick/client`, under a scope. The scope earns its keep
anyway: `@retick/cli` and whatever comes after it arrive without a second round of naming.

## Versioning

Semantic versioning.

**While the version starts with `0.`, a minor bump may break you.** That is the semver rule and
most people read past it, so: pin with `~0.2.0` if a break would cost you something.

`1.0.0` is one specific promise. `createProducer`, `createConsumer` and `createAgoraReader` stop
changing shape without a major. The publication surface has held still since the contract was
frozen; the read and Agora surfaces are days old and nobody but their author has used them. Once
somebody has, this goes to `1.0.0`.

`CHANGELOG.md` says what changed, and the release will not build without an entry for the
version being published.

## What this repository does not have

The full test suite. The tests that drive this client against a running Retick, `producer` and
`consumer`, need the service on the other end, and the service is a separate, private
repository. What lives here is the 53 tests that need nothing standing up: the Agora reader,
batching, and the network layer with `fetch` injected.

The split costs something. A fork can change `src/producer.ts` and still see green.
`scripts/provar-instalacao-avulsa.sh` is what covers the gap: it packs the tarball, installs it
into a throwaway project outside the tree, imports it by name and runs it. CI does that on four
versions of Node.

## Development

```sh
npm install
npm run typecheck
npm test
./scripts/provar-instalacao-avulsa.sh   # pack, install outside the tree, run
./scripts/varrer-o-pacote.sh            # what the tarball carries, and what it must not
```

`examples/minimo/` is one file: publish a fact, read the cursor, run it twice and watch the
second one come back as a duplicate instead of an error.

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`.
