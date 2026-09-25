# Next.js

The point of this example is where the credential lives. Everything else is one
route handler and one page.

```sh
npm install

RETICK_URL=https://retick.example \
RETICK_TOKEN=rtk_... \
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

## The one rule

`rtk_` and `rtl_` are long-lived and scoped to a whole source. A browser that can
read either one can write to your project or read all of it. So:

- they live in `lib/retick.ts`, which throws if it is ever loaded in a browser;
- no `NEXT_PUBLIC_` prefix, which would put them in the client bundle by name;
- `next.config.ts` lists `@retick/client` in `serverExternalPackages`, so a stray
  import from a client component fails at build time instead of shipping;
- `app/page.tsx` is a server component. It reads the contract on the server and
  sends numbers to the browser.

If you want live state in a tab, the credential for that is `rtv_`: minted per
session by your own backend, minutes long, revocable, and read by
`createAgoraReader`. That surface needs your identity issuer registered with the
Retick operator first: see
[FIRST-USE.md §8](../../docs/FIRST-USE.md#8-reading-the-agora-from-a-browser-and-the-gate-on-it).
Until then, a server component that re-reads on navigation is the honest version,
and it is what this example does.

## `sourceVersion` comes from the caller

`POST /api/orders` takes it in the body. Numbering belongs to your system of
record: a database sequence, an outbox row. This client will not generate it. A client that did would be a second authority over order, and the two would
disagree the first time a process restarted.

That also means this route is only as idempotent as your numbering. Same
`eventId`, same number, any number of times: safe. Same `eventId` with a different
number is a different fact by one measure and a duplicate by another, and Retick
resolves it as a duplicate on `eventId`.

## Checked, not assumed

`npm run typecheck` compiles `lib/`, `app/` and the route handler against the
package's own declaration files. The publishing path in `lib/retick.ts` is the
same code the Node example runs, and that one is exercised end to end against a
real Retick from the core repository.
