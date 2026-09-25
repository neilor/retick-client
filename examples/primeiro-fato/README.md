# First use, as a project you can copy

Two files. `publish.mjs` writes; `read.mjs` reads back. Both take the service and
the credentials from the environment, because a credential in a file is a
credential in someone's git history.

```sh
npm install

RETICK_URL=https://retick.example \
RETICK_TOKEN=rtk_... \
RETICK_SOURCE=orders \
npm run publish

RETICK_URL=https://retick.example \
RETICK_READ_TOKEN=rtl_... \
RETICK_SOURCE=orders \
npm run read
```

`RETICK_URL` is the base URL, without any `/api/...` suffix. If it already
carries one, the client says so at construction instead of producing a 404 that
looks like a service problem.

## What to look at

**Run `publish` twice.** The first run accepts; the second returns duplicates
rather than errors. The deduplication key is `(source, tenant, eventId)`, and
that is what makes a resend after a timeout free.

**Read the two outcome lines.** The batch carries one fact with
`entityType: 'dispatch'` and one with `entityType: 'order'`. The first comes back
`projected=true` and shows up in the Console's Estado Live; the second comes back
`projected=false` and shows up nowhere, while being just as ordered, deduplicated
and counted in the cursor. Why that is so, and the trap in between, is in
[../../docs/FIRST-USE.md](../../docs/FIRST-USE.md#5-publish-your-first-fact).

**Read `visible types` in the `read` output.** A consumer credential issued from
the Console has an empty type map, so it reads nothing and says so: `(none)`, and
`applied 0`. The credential is fine.
[FIRST-USE.md §7](../../docs/FIRST-USE.md#7-read-your-own-project-back) has the
working path.

**Hand `RETICK_TOKEN` to `read`.** It refuses before touching the network,
because the split between writing and reading is in the token format rather than
in a flag.

## Where this is tested

The core repository runs these two files, unmodified, against a real Retick stack:
it installs `@retick/client` from npm by name into a throwaway directory, walks
the Console's own click-path to create the project and issue both credentials, and
checks that the Estado Live panel moved afterwards. So the commands above are
measured rather than described.
