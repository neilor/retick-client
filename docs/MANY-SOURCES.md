# Many sources: reading back, order and the batch route

A source is one sequence of facts with its own numbering: typically one per
user, per room, per device or per job. An app with many users ends up with many
sources. This page covers reading them back with `@retick/client` 0.4.0, one
source at a time with `replay` or many per request with `replaySources`, what
holds and what does not hold across sources, and the service's batch read route.

## One source: `replay` with `resume`

```ts
import { createConsumer, type ReplayCheckpoint } from '@retick/client'

const consumer = createConsumer({ url: 'https://retick.dev', apiKey: process.env.RETICK_API_KEY! })

const saved: ReplayCheckpoint | undefined = await loadCheckpoint('room-12')
const result = await consumer.replay({
  source: 'room-12',
  resume: saved,
  onFacts: (facts) => {
    for (const f of facts) apply(f)
  },
})
await saveCheckpoint('room-12', result.resume)
```

`replay` pulls until it has caught up and hands facts over in `sourceVersion`
order, whatever order they arrived in. It returns `resume`, a plain JSON
checkpoint for that source. Store it next to your projection, in the same write
or after it, and pass it back next time.

Do not resume from `result.position`. It is the 0.2.0 checkpoint, kept for code
written against 0.2.0, and it loses facts that were held behind a gap when the
replay stopped. The `resume` checkpoint remembers those and which versions were
already delivered, so nothing is skipped or delivered twice.

If `result.floorLowered` is set, a backfill delivered versions below ones you
had already applied. An order-sensitive projection should be rebuilt with a
replay that passes neither `resume` nor `position`.

The key needs the `log:read` operation. See [FIRST-USE.md](FIRST-USE.md#7-read-your-own-project-back).

## No order across sources

- Positions are per source. The first fact of `room-12` and the first fact of
  `user-a` both have position 1. There is no project-wide position.
- Timestamps do not order sources. `occurredAt` is the producer's clock and
  `observedAt` the receiving instance's clock. Neither orders facts from two
  sources.
- If a projection depends on the order of two facts, put them in one
  source, make the later fact name the earlier one in its payload (its `source`
  and `eventId`), or make the projection independent of that order.

## Many sources per request: `replaySources`

Replaying sources one by one costs at least one request per source.
`replaySources` reads them over the service's batch read route, up to 100
sources per request, with the same key, timeouts and retries as `replay`.

```ts
import { createConsumer, type ReplayCheckpoint } from '@retick/client'

const consumer = createConsumer({ url: 'https://retick.dev', apiKey: process.env.RETICK_API_KEY! })

const sources = ['room-01', 'room-02', 'user-a']        // your backend chooses
const saved: Record<string, ReplayCheckpoint> = await loadCheckpoints(sources)

const result = await consumer.replaySources({
  sources,
  resume: saved,
  onFacts: (facts, source) => {
    for (const f of facts) apply(source, f)
  },
})
await saveCheckpoints(result.resume)                   // one ReplayCheckpoint per source
```

- `sources` is required, each named once. The method never lists sources on
  its own. To read every source the key sees, pass
  `(await consumer.contract()).sources`.
- `resume` takes one `ReplayCheckpoint` per source, the same object `replay`
  returns. A checkpoint saved by `replay({ source })` works here, and the
  reverse also works. A listed source without a checkpoint starts from the
  beginning. A checkpoint stored under another source's name is refused.
- `onFacts(facts, source)` gets one source's facts at a time, in that source's
  `sourceVersion` order. The first argument is what `replay` passes. Calls for
  different sources come in the order the service answered, which is not an
  order between sources.
- The result has `resume` (one checkpoint per listed source), `sources` (per
  source: `applied`, `held`, `withheld`, `state`, `floorLowered`), and the
  totals `applied`, `held`, `requests` and `deferred`. `caughtUp` is `false`
  only when `maxRequests` stopped the call.
- `maxRequests` works like `maxPages` in `replay`: a function with a time
  budget stops early and resumes from the checkpoints. Requests that only read
  again facts held by an earlier call do not count.
- `limit` caps facts per source per request, as in `replay`. The service caps
  it too.

What the client leaves to the service: it does not split the response budget or
cut pages by size. It sends the sources the service deferred first in the next
request, takes `maxSources` from the response or from a `too_many` refusal, and
throws if an answer names a source or position it did not ask for, or advances
no source.

What stays as in `replay`:

- A refusal throws. A source outside the key's exact list refuses the whole
  request before any page is read. Facts already passed to `onFacts` in that
  call are passed again by the next call, so key every apply by
  `(source, sourceVersion)`.
- With more than 100 sources, the call takes several requests, and a refused
  source can sit in a later one.
- A service without the batch route answers `404`. The error says to use
  `replay`; the client does not fall back on its own.

## The batch route over HTTP: `POST /api/read/v1/batch`

`replaySources` is built on this route. Code that does not use this client can
call it directly, with the same `rt_` key (`log:read`) that `createConsumer`
uses.

```http
POST /api/read/v1/batch
Authorization: Bearer rt_…
Content-Type: application/json

{ "sources": [{ "source": "room-01", "position": 0 }, { "source": "room-02", "position": 2 }] }
```

- Up to 100 sources per request, each named once. `position` is the
  `cursor.next` of that source's previous page, `0` to start.
- `pages` comes back in request order. Each page is the page
  `GET /api/read/v1/facts?source=&position=` returns for that source: the same
  `facts`, `cursor`, `withheld` and `state`.
- The response is bounded in facts and bytes, and reports its bounds in
  `limits`. Sources the budget did not reach are listed in `deferred`, each with
  the position to ask for again. A deferred source was not read at all; send it
  first in the next request.
- The project comes from the key, and the key's source restriction applies to
  every source in the request. One source outside it refuses the whole request
  before anything is read.

The pages are raw, in log order, like `consumer.pull()`. Calling the route
yourself means doing per source what `replay` and `replaySources` do:

- apply facts in `sourceVersion` order, starting above `state.floor`;
- hold a fact whose version is above the last applied one plus one, until the
  missing version arrives;
- key every apply by `(source, sourceVersion)`, so a page read twice after a
  timeout is harmless;
- store `cursor.next` and the held versions with the projection, never before
  it.

A fact the key may not see is taken out of the page (`withheld` counts it, by
reason) but keeps its version. Once a source is read to its end, treat versions
up to `state.contiguous` as settled, or a withheld version looks like a gap
forever.

## What the service does not do

- Assign `sourceVersion`, or number facts for you. See [PRODUCERS.md](PRODUCERS.md).
- Give a position or an order across sources.
- Archive, expire or delete a source. A source that has received facts stays in
  `contract().sources`, and each one costs at least one call when replaying one
  by one.

## Browsers

None of the above runs in a page. A browser reads the current state of the
sources its user may see with `createStateReader`, which is a different surface
with a different credential: [BROWSER.md](BROWSER.md).
