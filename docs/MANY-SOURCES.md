# Many sources: reading back, order and the batch route

A source is one sequence of facts with its own numbering: typically one per
user, per room, per device or per job. An app with many users ends up with many
sources. This page covers reading them back with `@retick/client` 0.3.0, what
holds and what does not hold across sources, and the service's batch read route,
which 0.3.0 has no method for.

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

## Many sources in one request: `POST /api/read/v1/batch`

Replaying sources one by one costs at least one request per source. For an app
that reads hundreds of sources, the service answers a batch route. **0.3.0 has
no method for it**: a server calls it over HTTP, with the same `rt_` key
(`log:read`) that `createConsumer` uses.

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

The pages are raw, in log order, like `consumer.pull()`. 0.3.0 does not apply
them for you. Per source, your code does what `replay` does:

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

If that is more logic than your app needs, `consumer.replay` per source is the
simpler path, and the batch route is an optimization to adopt when the number of
sources makes per-source calls too slow.

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
