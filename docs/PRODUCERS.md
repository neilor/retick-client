# Producers: `sourceVersion`, timeouts and serverless functions

Retick orders facts per source, by the `sourceVersion` your producer puts in
each fact. The service never assigns a version, and this client does not
generate one either. This page covers what each answer to `publish()` means,
what to do when an answer is lost, and how to allocate versions when the
producer runs as several instances at once (serverless functions, workers, a
deploy that overlaps old and new).

Everything here applies to `@retick/client` 0.3.0 and to plain HTTP calls to
`POST /api/v1/facts`.

## What each answer means

| `status` | means | does not mean |
|---|---|---|
| `accepted` | This request stored the fact. | |
| `pending` | Stored, behind a missing earlier version. Nothing after the gap is applied until that version arrives. | That it will ever be applied. Only the missing version closes the gap. |
| `duplicate` | A fact with this `eventId` is already stored, or a different fact already holds this `sourceVersion` as `pending`. | That *your* fact is the one stored. |
| `stale` | The version is at or below the source's contiguous point or its floor. Not stored. | A harmless repeat. If it is a different fact, that fact is lost. |
| `rejected` | Invalid, not stored; `outcome.reason` has a stable code and `outcome.message` the sentence. The slot stays empty. | |

`producer.contract().sources` reports, per source:

- `contiguous`: the last version with the sequence intact since the floor;
- `highest`: the highest version received;
- `gaps`: the missing ranges;
- `floor`: versions at or below it are not taken;
- `resendSuggestion`: a range the service knows it is missing.

After a request whose answer was lost, `contiguous` tells you that *something*
holds version N, not what. To know which fact it is, read the source back
(`consumer.pull`) and compare the `eventId` stored at that version.

The first fact a new source receives sets its floor at `sourceVersion - 1`. A
version below the floor is `stale`. So send version 1 of a new source alone and
wait for its answer before sending later versions; if version 5 arrives first,
versions 1 to 4 can no longer go in.

## Timeouts and retries

The client retries network failures, timeouts, `5xx` and `429` by itself
(`retries`, default 3; `timeoutMs`, default 30000). Every retry sends the same
bytes, so a fact stored by an earlier attempt comes back `duplicate`.

When `publish()` finally throws `RetickTimeoutError`, `RetickNetworkError` or
`RetickServerError`, the facts may or may not be stored. Send the same facts
again later, from any instance, with the same `eventId` and the same
`sourceVersion`. The answer tells you what happened: `duplicate` if the lost
request stored them, `accepted` or `pending` if it did not.

Two responses to an uncertain answer lose data:

- **Giving the uncertain version to a different fact.** If the original was
  stored, the new fact comes back `stale` or `duplicate` and is not stored.
- **Skipping the uncertain version.** If the original never arrived, every later
  fact waits as `pending` until that exact version is sent.

A `rejected` fact is the one case where a version may be reused: fix the fact
and send it with the same `sourceVersion`.

## Allocating `sourceVersion` with several instances

Two rules keep a source healthy:

1. Each version goes to one fact, durably, before that fact is sent.
2. Each allocated fact is sent, with the same bytes, until the service answers
   for it.

Once a source exists, the order in which instances send does not matter: a
later version that arrives first waits as `pending` until the earlier one lands.

Ways to meet the first rule:

- **One source per writer.** If each user, device or job writes only its own
  source, its counter lives with it.
- **A counter or outbox in your own database.** Allocate the version and store
  the fact in one transaction, with a unique key on `(source, sourceVersion)`.
  Any instance can then send any unsent fact. Keep a sweep that sends unsent
  facts in version order, because an instance can die between allocating and
  sending, and everything after that version waits for it.
- **A queue with one consumer per source** that keeps the message until the
  publish is answered.

Not enough on their own:

- **`contract().sources[].highest + 1`.** Two instances that read it before
  either publishes pick the same version. One fact is `accepted`; the other is
  `stale` and lost.
- **One instance at a time, or a lock in process memory.** A platform can run an
  old and a new instance together during a deploy or a scale event, and a
  counter rebuilt at a cold start can repeat a version.

## Batches

`publish(facts)` splits the array into batches that fit the service's limits
and sends them one at a time, in order. Sending batch 3 while batch 2 is in
flight would create the gap that ordering exists to close. `contract().limits`
reports the limits the service enforces. `splitIntoBatches(facts, limits)` is
the same splitting, exported for code that sends over its own transport; it
splits a publish and has nothing to do with reading.

## See also

- [FIRST-USE.md](FIRST-USE.md): project, sources and the server key.
- [MANY-SOURCES.md](MANY-SOURCES.md): reading facts back, and what holds across
  sources.
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md): refusals, by what you were doing.
