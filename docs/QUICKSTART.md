# Quickstart

From nothing to a fact you can see in the Console. Six steps, one file.

You need two things this package cannot give you: the base URL of a Retick
service, and an account on its Console. Access is by invitation today, so ask
whoever operates your Retick for both. The long version of every step, and what
to do when one of them refuses you, is in [FIRST-USE.md](FIRST-USE.md).

## 1. Open the Console and pick a project

`https://retick.example/console` sends you to a sign-in page, and signing in
lands you on your workspaces. Open one, and either pick a project or create one.
A project is the unit of isolation: its log, its cursors and its deduplication
are its own.

The project page shows a **tenant key** under the project name. It names the
project; it authorizes nothing. Step 3 is where that difference bites.

## 2. Create a source

A source is a label for one origin of facts, and it owns its own numbering.
Create one called `orders`.

## 3. Issue a publication credential

On the project page, issue a credential of type *producer* scoped to `orders`.
The secret appears once, starts with `rtk_`, and no route gives it back. Put it
somewhere your process can read it and nowhere else.

The tenant key from step 1 is not this. It says *which* project; the credential
says *you may write to it*. Publishing sends only the credential, and a fact
that tries to declare its own project is refused.

## 4. Install

```sh
npm install @retick/client
```

Node 18.17 or newer.

## 5. Publish

```js
import { createProducer } from '@retick/client'

const producer = createProducer({
  url: 'https://retick.example', // base URL, without /api/v1
  token: process.env.RETICK_TOKEN,
})

const result = await producer.publish([
  {
    eventId: 'first-use-0001', // yours, and the deduplication key
    source: 'orders', // must be in the credential's scope
    sourceVersion: 1, // your numbering, monotonic per source
    type: 'order.placed',
    entityType: 'dispatch', // see the note below: this is what the Console renders
    entityId: 'ORD-1',
    occurredAt: new Date().toISOString(),
    payload: { code: 'ORD-1', title: 'First order', state: 'QUEUED' },
  },
])

console.log(result.accepted, result.outcomes[0].status)
```

Prints `1 accepted`. Run it again and it prints `0 duplicate`, because the
deduplication key is `(source, tenant, eventId)` and resending is meant to be
cheap.

**Why `dispatch` for an order.** The projection that feeds the Console reduces six
`entityType`s today (`dispatch`, `machine`, `session`, `block`, `approval`,
`state`) with keys inherited from the first producer: `code`, `title`, `state`.
An `entityType` of your own publishes fine, is ordered and deduplicated and
counted in the cursor, and renders nowhere. Step 6 shows both, and
[FIRST-USE.md §5](FIRST-USE.md#5-publish-your-first-fact) explains the trap in the
middle.

`examples/primeiro-fato/` is this as a project you can copy: it publishes one fact
of each kind so you can see the difference in one run, plus the read side.

## 6. Watch the Console

Reload the project page. The **Estado Live** panel now carries `ORD-1`, and the
counter moved. The panel refreshes on its own: it asks for a fragment, sends the
version marker it already has, and gets `204` when nothing changed. So leaving
the page open while you publish shows the change arrive without a reload.

Two results look like failures and are not:

- publish an `entityType` of your own and the outcome says `projected: false` and
  the panel does not move. The fact is still validated, ordered, deduplicated and
  counted in the cursor. That is what v1 promises, and understanding your content
  is not part of it;
- the Estado Live is a projection, not the log. It shows current state, so a fact
  that was superseded is not on screen.

## Next

- read your own project back with a second credential, and the one thing that
  does not work yet when you do: [FIRST-USE.md §7](FIRST-USE.md#7-read-your-own-project-back)
- something refused you: [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- the full client surface, option by option: [../README.md](../README.md)
