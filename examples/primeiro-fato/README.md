# First use, as a project you can copy

Two files. `publish.mjs` writes; `read.mjs` reads back. Both take the service and
the key from the environment, because a key in a file is a key in someone's git
history.

```sh
npm install

RETICK_URL=https://retick.dev \
RETICK_API_KEY=rt_... \
RETICK_SOURCE=orders \
npm run publish

RETICK_URL=https://retick.dev \
RETICK_API_KEY=rt_... \
RETICK_SOURCE=orders \
npm run read
```

The key needs `facts:publish` to publish and `log:read` to read: one key with
both, or two keys. `RETICK_URL` is the base URL, without any `/api/...` suffix.
If it already carries one, the client says so at construction instead of
producing a 404 that looks like a service problem.

## What to look at

**Run `publish` twice.** The first run accepts both facts; the second returns
duplicates rather than errors. The deduplication key is
`(source, tenant, eventId)`, and that is what makes a resend after a timeout
free.

**Open the Studio.** The two facts describe one order, placed and then paid. The
Studio shows one `order` entity, `ORD-1`, with the fields of both facts, because
it draws state rather than history.

**Run `read` twice.** The first run prints both facts in `sourceVersion` order
and stores the checkpoint in `.retick-resume.json`. The second run reads only
what is new, which is nothing until you publish more. Delete the file to read
from the beginning again.

**Hand `read` a key without `log:read`.** The service refuses it with
`credential_refused` and `missing_operation`, and the example says which
operation is missing.

More: [../../docs/FIRST-USE.md](../../docs/FIRST-USE.md).
