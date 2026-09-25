# First use, the long version

The [quickstart](QUICKSTART.md) is the happy path with nothing explained. This
is the same journey with the reasons attached, plus the places where Retick
refuses you on purpose and the place where it refuses you because a piece is
missing.

Everything here is a surface that exists today. Where a capability is planned
and absent, this document says so instead of describing it.

## 0. What you need before the first line of code

| | what | where it comes from |
|---|---|---|
| a service | the base URL of a Retick, without any `/api/...` suffix | whoever operates it |
| an account | a sign-in on that service's Console | an invitation |

**Access is closed.** Signing in with a Google account that nobody invited gets
you a refusal, and nothing is created: no user, no workspace, no project. The
Console says *this account was not invited* for every reason it might refuse, and
the specific reason stays in the audit trail, because telling you which check you
passed would be a hint for someone guessing.

So there is no self-service signup to link to. If you got here from npm and have
no Retick, this package has nothing to talk to yet.

## 1. Projects, and why the Console starts with workspaces

Three levels, and each one earns its place:

- a **workspace** holds people and their roles;
- a **project** holds a log. It is the unit of isolation: its cursors and its
  deduplication are its own, and two projects with the same source name and the
  same numbering never touch;
- an **environment** splits one project into stages. Every project is born with
  a `producao` environment, and a second environment gets a key of its own so
  that staging cannot write into production's log.

Create a project from the workspace page: a slug and a name. The slug is unique
inside the workspace and is decoration. Two workspaces can both have `producao`,
which is the case the design exists to make safe.

Roles decide what you can do here. `developer` issues and rotates credentials;
creating an environment is `owner` and `admin`, because a new environment means a
new log, new cursors and new cost.

## 2. The tenant key is not a credential

Getting this wrong either blocks you for an hour or puts your facts in the wrong
log, so it gets a page.

The project page shows a **tenant key**: an opaque string the server generated,
unique across the whole service, that you cannot choose. It is the `project` that
every credential of that project carries in its scope, and it is what separates
this log from every other one.

| | tenant key | credential |
|---|---|---|
| what it is | an identifier | an authorization |
| who makes it | the server, at project creation | the server, when you issue one |
| shape | opaque, stable | `rtk_…`, `rtl_…`, shown once |
| stored as | itself | a SHA-256 of the secret |
| revocable | no, it is the project's name | yes |
| safe to log | yes | no |
| grants anything | no | yes, exactly its scope |

Two consequences you will meet in the first hour:

**You never send the tenant key.** The publication route takes the project from
the credential, and a fact that carries `tenant`, `project` or `projeto` in its
body is refused. That is not strictness for its own sake: if the body could
declare the project, the scope check would be a courtesy.

**The tenant key is not the slug.** The log isolates by the string in the
credential's scope. If that string were the readable name, two workspaces that
both picked `producao` would share log, cursor and deduplication, and nothing
would fail while they did.

You will see the tenant key come back in `publish()`'s `project` field and in
`contract().scope.project`. That is the service telling you which project you
just used, not asking you for it.

### Four prefixes, four vaults

| prefix | what it does | who holds it |
|---|---|---|
| `rtk_` | publishes facts | your server, your CI |
| `rtl_` | reads your project's log by cursor | your server |
| `rta_` | operates the control plane over HTTP | your server, narrowly scoped |
| `rtv_` | reads the compact Agora from a browser tab | minted per session, minutes long |

The separation is in the format, not in a capability flag. Pasting an `rtk_` into
`createConsumer` throws `RetickConfigError` before anything leaves your machine,
and pasting it into the read route server-side gets `malformado` before any scope
check runs. There is no code path where one credential does the other one's job,
and the price is a little duplicated hashing.

## 3. Sources, and the numbering that is yours

A source is a label for one origin of facts inside a project: `orders`,
`billing`, `payroll`. Create it on the project page before issuing a credential
scoped to it.

`sourceVersion` is your number, monotonic per source, and Retick does not
generate it. A client that generated it would be a second authority over order,
and the two would disagree the first time a process restarted.

Two properties this buys you:

- **nothing is applied ahead of a hole.** A fact that arrives before a missing
  `sourceVersion` comes back `pending` and waits. When the missing one arrives,
  both go in, in order. The cost is latency while a hole is open; the gain is
  that a projection and a replay of the same log always agree;
- **you do not have to start at 1.** The first accepted fact of a
  `(project, source)` pair sets the floor at `sourceVersion - 1`, so integrity is
  required from there on and not retroactively.

## 4. Install and configure

```sh
npm install @retick/client
```

Node 18.17 or newer, for `fetch`. Zero runtime dependencies.

```ts
import { createProducer } from '@retick/client'

const producer = createProducer({
  url: process.env.RETICK_URL!, // base URL, WITHOUT /api/v1
  token: process.env.RETICK_TOKEN!, // rtk_…
  timeoutMs: 30_000,
  retries: 3,
})
```

Passing a `url` that already carries `/api/v1` throws `RetickConfigError` at
construction. The client appends the route, and a doubled suffix would produce a
404 that looks like a service problem.

The full option table is in the [README](../README.md#options).

## 5. Publish your first fact

```ts
const result = await producer.publish([
  {
    eventId: 'first-use-0001',
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
`entityType`, `occurredAt`. A seventh is required in practice: **send
`payload`**. The contract route lists it as optional and the publication route
rejects a fact without it. That is a known divergence, the fix is one line and
widening, and this client follows the declared contract so that nothing has to
change the day it lands.

Three fields are not yours to set, and sending them is refused:

| field | who decides | why |
|---|---|---|
| `tenant` | the credential | isolation is not requested by body |
| `observedAt` | the service's clock | it is the basis of freshness, so a producer that chose it could declare itself permanently fresh |
| `envelope` | Retick | it versions the internal format, not yours |

### What comes back

A rejected fact does not throw. It comes back in `outcomes`, and a `422` means
part of the batch was refused while the rest went in — same body shape as a
`200`.

| status | what happened |
|---|---|
| `accepted` | in, ordered, consolidated |
| `duplicate` | already in; nothing changed |
| `stale` | a late resend of something already past the intact point |
| `pending` | ahead of the sequence, waiting for the hole to close |
| `rejected` | not in; `reason` says why |

Five values, frozen. Run your publish twice: the second run returns `duplicate`,
because the deduplication key is `(source, tenant, eventId)`. That is what makes
a retry after a timeout safe, and it is the reason this client retries at all.

### `projected: false` is not a failure

Publish an `entityType` of your own and the outcome comes back
`projected: false`. That is the honest answer, not a rejection: the fact is
validated, ordered, deduplicated and counted in the cursor, which is what v1
promises. Understanding your content is not part of it.

Reducers exist for five `entityType`s (`dispatch`, `machine`, `session`,
`block`, `approval`), and they read keys in English inherited from the first
producer: `code`, `title`, and `state`, `to` or `initialState`.

Two honest choices, and one trap:

- use one of the five with those key names, and get a populated entity;
- use an `entityType` of your own, accept `projected: false`, and know the fact
  is in the log and in the cursor;
- use one of the five with *your* key names, and you get `projected: true`, an
  entity with every field `null`, and nothing failing anywhere. That flag says a
  reducer exists. It says nothing about whether the reducer understood you.

**`projected` and "shows up in the Console" are two different questions.** The
projection behind the publication response has those five reducers; the Agora
projection behind the Console's Estado Live has six, adding `state`. So a `state`
fact comes back `projected: false` and still moves the Console. Neither number is
a promise about the other.

### Batching, and why order beats throughput

`publish(facts)` splits your array into batches that fit the contract's limits
and sends them one at a time, in order. Sending batch 3 while batch 2 is in
flight would manufacture the hole that ordering exists to close.

Limits, unless your operator configured them lower: 500 facts per batch,
1 048 576 body bytes, 65 536 payload bytes per fact. `contract().limits` reports
what the service actually enforces.

## 6. Watch it land in the Console

Open the project page. The **Estado Live** panel is the compact projection of
that project: current state derived from the facts it published, addressed by the
tenant key. A fact in one of the six vocabularies from §5 appears there with a
counter; clicking a dense value expands it.

The panel updates itself. It asks the service for a fragment, sends the version
marker it already has, and the service answers `204` when nothing changed, which
is the common case. So leaving the page open while you publish shows the change
arrive without a reload.

Nothing appearing has exactly two causes, and both are in §5: no fact reached that
project, or none of them used a vocabulary the Agora reduces. A fact in your own
vocabulary publishes, orders and counts, and leaves the panel where it was.

What the panel shows is **state, not history**. A fact that was superseded is not
on screen. If you published `order.placed` and then `order.paid` for the same
entity, you see one order, paid.

## 7. Read your own project back

The publication route is write-only. `GET /api/v1/fatos` answers `405`, and there
is a test that reads the API's own source and fails if it so much as calls the
projection. Reading is a separate surface with a separate credential.

Issue a second credential on the project page, type *consumer*, scoped to the
same source. It starts with `rtl_`.

**And it will read nothing, today.** A consumer's cut is a map of visible payload
keys per `entityType`, and the Console issues that map **empty**, because it has
no screen for choosing types and a wide default would decide your cut for you.
The cut is an allow-list, so a type outside the map has no intersection and the
fact is taken out of the page. What you see is `applied: 0` with
`withheld.type` counting every fact, and `contract().scope.types` showing `{}`.

A credential with a filled map comes from the control plane:

```jsonc
// POST /api/plano/v1/projetos/:id/credenciais
// Authorization: Bearer rta_…   (a key carrying `credencial.emitir`)
{
  "tipo": "consumidor",
  "nome": "orders reader",
  "fontes": ["orders"],
  "tipos": { "order": ["number", "totalCents", "currency"] }
}
```

The secret comes back once, in `tokenMostradoUmaVez`. `rta_` keys are not issued
from the Console either, so today this is a request to whoever operates your
Retick rather than a call you can make. Until you have one, the Console's own
Estado Live from §6 is the way to see your project's state, and it works today.

With a filled map, the read side is this:

```ts
import { createConsumer } from '@retick/client'

const consumer = createConsumer({ url, token: process.env.RETICK_READ_TOKEN! })

const result = await consumer.replay({
  source: 'orders',
  position: 0,
  onFacts: (facts) => {
    for (const f of facts) apply(f)
  },
})

// Persist this and hand it back as `position` next time.
savePosition(result.position)
```

**`position` is the cursor, and `sourceVersion` is not.** Log position only
grows. A producer's numbering can repeat — a restart, a resend, a backfill that
lowers the floor — and resuming by it would deliver a fact twice or skip one.

**Order is the part that looks easy.** The service hands facts over in log order,
which is arrival order: a producer that sent 1, then 4, then 2 and 3 produced a
log that reads `1, 4, 2, 3`. `replay` restores `sourceVersion` order on this
side, holding what it cannot release yet, and `result.held` counts what is still
blocked by a hole. `pull` gives you one raw page if you would rather handle that
yourself, and `OrderedBuffer` is the piece, testable without a server.

`result.withheld` counts what your scope did not let through, split by reason
(`type`, `sensitivity`). A count, never the content. The first number is what
tells you the type map is empty rather than the log.

## 8. Reading the Agora from a browser, and the gate on it

`createAgoraReader` is the third surface and the only one meant for a tab. It
reads the compact projection the service already materialized, with an `rtv_`
credential your own backend supplies:

```ts
const reader = createAgoraReader({
  url,
  credentials: async () => mintFromMyOwnBackend(),
})

const stop = reader.subscribe((snapshot, freshness) => render(snapshot, freshness))
```

It holds nothing on disk and never puts the token in a URL, which is why the live
path is NDJSON over `fetch` instead of `EventSource`. A `401` gets one request
for a fresh credential, and only one.

**The gate.** `rtv_` is minted by exchanging a signed assertion from an identity
issuer that the Retick operator registered for your project, and the effective
scope is the intersection of what your issuer asks for and the ceiling registered
for it. An unregistered issuer is refused with `emissor_nao_cadastrado`, and a
missing ceiling is a refusal rather than an infinite ceiling.

So this surface works today for a host whose issuer is registered. If yours is
not, that registration is an act on the operator's side, not a call you can make.
Until then, §6 (the Console) and §7 (`createConsumer`, server-side) are the two
ways to read your project, and both are fully available.

### Leaving is two acts

| call | what it does | when |
|---|---|---|
| `close()` | forgets the credential here | unmount: route change, re-render, discarded tab |
| `revoke()` | ends the session at the service, then forgets | someone deliberately logged out |

They are separate because only your app knows which happened. A reader that
revoked on every unmount would end the session of someone who clicked a link.
Sessions nobody revokes end on their own `expiresAt`.

## 9. Handling credentials without leaking them

The client's side of this is already done: the token lives in a closure, goes out
in an `Authorization` header, and is never written anywhere. Only the
non-secret prefix `rtk_<12 hex>` appears in an error, which is what the service
logs and what identifies a credential for revocation. A token that does not match
the format is not echoed at all.

Your side:

- read it from the environment or a secret manager. Never from a file in the
  repository, and never from a constant in code;
- it belongs to a server. `rtk_` and `rtl_` are long-lived and scoped to a
  whole source. Shipping either to a browser hands a visitor your write access.
  Browsers get `rtv_`, minted per session by your backend;
- it appears once. No route returns it. If it is lost, issue another and
  revoke the old one;
- rotate, do not revoke, when you are replacing it. Rotation issues a
  successor with the same scope and gives the old one a window, so a deploy has
  time to happen. Revocation cuts now, and is a different operation with a
  different name. Rotating also never widens scope, because nobody reviews a
  rotation, and one that accepted a new scope would be privilege escalation with
  a friendly name;
- do not build a log line out of the secret. `RetickError` is already safe to
  log in full; a hand-rolled `JSON.stringify(options)` is not;
- prefix your environment variables per project. A single `RETICK_TOKEN` in a
  shell that has two projects open is how facts land in the wrong log. The tenant
  key comes from the credential, so they land there quietly and correctly.

If you run a server that needs its own read credential, the `rta_` route is
`POST /api/plano/v1/projetos/:id/credenciais` with a key that carries
`credencial.emitir`. That exists so a service can issue its own `rtl_` instead of
carrying one that a human pasted into an environment and nobody remembers to
rotate. That route does not issue `rta_` keys: a key that mints keys over the
network is the shortest path from one leaked token to a family of them that
nobody can list.

## 10. What is not there yet

Documented here because finding out by experiment costs more.

- No rate limit. There is a size limit and no frequency limit. A producer in
  a loop is not slowed down, and `429` is handled by this client only because a
  proxy in front of the service can emit one.
- No back-pressure signal. The service does not tell you to slow down.
- Per-source projection vocabulary does not exist. §5 covers the
  consequence. It is the gap most likely to bite a first producer.
- Durability is a deployment choice. `contract().durability` reports
  `durable` and `shared` for the service you are talking to. `shared: false`
  matters concretely: two consecutive requests can land on different instances
  and report different cursors.
- Revocation may not be instant. Revoking on the project page stops the
  credential, but a deployment that loads its credential store at boot only
  honours it on the next restart. If a revoked credential still works, that is
  what happened; ask your operator which mode they run.
- No CLI, no MCP server. Both are planned as clients of the same control
  plane, and neither exists.
- Billing, quotas and a marketplace are not in this document, because they are
  not built. `contract()` and `GET /api/plano/v1/projetos/:id/uso` report usage;
  nothing charges for it.

## Where the rules come from

`src/types.ts` in this package carries the v1 contract in full: the envelope
version, required and forbidden fields, the five statuses, the limits and the
routes. It is a second copy of the service's own, on purpose: importing the
service's copy would drag a server into the dependency tree of a package whose
job is to speak HTTP. A test in the core repository fails when the two drift.
