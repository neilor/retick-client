# Next.js

The point of this example is where the credential lives. Everything else is one
route handler and one page.

```sh
npm install

RETICK_URL=https://retick.dev \
RETICK_API_KEY=rt_... \
RETICK_SOURCE=orders \
npm run dev
```

Open `localhost:3000` for the cursor, then publish:

```sh
curl -sS localhost:3000/api/orders \
  -H 'content-type: application/json' \
  -d '{"code":"ORD-1","sourceVersion":1,"title":"First order"}'
```

Twice. The second call answers `duplicate`, which is a success.

The key needs `facts:publish`; add `log:read` to use `readOrders`.

## The one rule

An `rt_` key is long-lived and reaches the whole project, or the sources it was
restricted to. A browser that can read it can do whatever the key can do. So:

- it lives in `lib/retick.ts`, which throws if it is ever loaded in a browser;
- no `NEXT_PUBLIC_` prefix, which would put them in the client bundle by name;
- `next.config.ts` lists `@retick/client` in `serverExternalPackages`, so a stray
  import from a client component fails at build time instead of shipping;
- `app/page.tsx` is a server component. It reads the contract on the server and
  sends numbers to the browser.

If you want live state in a tab, read it with `createStateReader`, through a
short credential your backend obtains per session for the sources that user may
see. That path needs your backend registered as an issuer on the project first:
see [BROWSER.md](../../docs/BROWSER.md). Until then, a server component that
re-reads on navigation is the simple version, and it is what this example does.

## `sourceVersion` comes from the caller

`POST /api/orders` takes it in the body. Numbering belongs to your system of
record: a database sequence, an outbox row. This client will not generate it. A
client that did would be a second authority over order, and the two would
disagree the first time a process restarted. On a serverless platform, where
several instances run this route at once, follow
[PRODUCERS.md](../../docs/PRODUCERS.md).

That also means this route is only as idempotent as your numbering. Same
`eventId`, same number, any number of times: safe. Same `eventId` with a different
number comes back `duplicate`: Retick deduplicates on `eventId`, and the second
number is not stored.

## Checked, not assumed

`npm run typecheck` compiles `lib/`, `app/` and the route handler against the
package's own declaration files.
