# Reading state from a browser

`createStateReader` reads the current state of a project's entities from a
page, cut to exactly the sources the signed-in user may see. Your backend
decides which sources those are, signs a short assertion, and exchanges it for
a browser credential that lives minutes. The page never holds a server key.

Three parties take part:

| who | does |
|---|---|
| the project owner, once | registers your backend as an issuer and the page origins (§1) |
| your backend, per session | authenticates the user, chooses the sources, signs and exchanges an assertion (§2, §3) |
| the page | reads with `createStateReader` and renews through your backend (§4) |

## 1. Register the issuer and the origins

In the Console: project → **Access** → **Browser apps**. Owners register:

- the issuer: `issuer` (the `iss` your backend signs with), `jwksUrl` (public
  HTTPS, serving the public key), `audience`, the capability `state:read`, the
  sources it may grant, and how long the browser credential lives (`ttlSeconds`,
  60 to 86400, default 900). For the sources, choose either **All sources of
  this project, including ones created later** or an exact list;
- the origins: each page origin, exact (`https://app.example`).

The same registry has an HTTP API under
`/api/control/v1/projects/:projectId/browser` for owners who automate it. There
`:projectId` is the project's id from the Console's address. The registry
stores the issuer under the project's **tenant key**, and the assertion names
the tenant key (§2).

## 2. The backend signs an assertion

For each signed-in user, your backend:

1. Authenticates the user. Retick does not know your users and never decides
   membership.
2. Chooses which sources this user reads (§3).
3. Signs an ES256 JWT with the private key behind the registered JWKS:

   ```json
   {
     "iss": "https://api.your-app.example",
     "aud": "retick-browser:prj_…",
     "sub": "<your user id>",
     "jti": "<unique>",
     "iat": 1759540000,
     "exp": 1759540060,
     "retick": { "project": "prj_…", "capabilities": ["state:read"], "sources": ["user-a", "room-12"] }
   }
   ```

4. Calls `POST /api/browser/v1/session` with `{ "assertion": "<jwt>" }` and the
   page's `Origin`, and returns `{ token, expiresAt }` from the `201` to the page.

Most refused first attempts trip on one of these:

- **`retick.project` is the tenant key** (`prj_…`), shown on the project's
  Overview in the Console. The id in the Console's address is a different
  value, and an assertion that names it is refused with
  `issuer_not_registered`.
- **`aud` is the audience registered with the issuer, exactly.**
  `retick-browser:<tenant key>` is what the Console suggests when you register,
  not a rule. Any other value is refused with `audience`.
- **The assertion lives at most 300 seconds** (`exp - now`), and each `jti` is
  exchanged once. `retick` is a nested object; flat `"retick.project"` keys are
  not read.

## 3. Choosing the sources of a session

The backend names the scope explicitly, in one of two modes:

- `"sources": [...]`: an exact, non-empty list of at most 32 sources. A user of a
  room typically gets their own source and the room's. With
  `["user-a", "room-12"]` and `["user-b", "room-12"]`, each user sees the room
  and their own source, never the other user's.
- `"allSources": true` instead of `sources`: every source of the project,
  including sources first written after the session opened.

What each kind of issuer accepts:

| issuer registered with | `"sources": [...]` | `"allSources": true` |
|---|---|---|
| all sources | any well-formed names, including a room created after registration | granted |
| an exact list | every name must be in the list; one outside refuses the whole request with `source_outside_ceiling` | refused, `all_sources_not_granted` |

`sources` missing or `[]` without `allSources` is refused with
`sources_required`; both together with `ambiguous_scope`. Nothing is widened by
default. Under an exact list, a room created later is readable only after the
owner adds it to the issuer's list. Under all sources, nothing needs to change.

Retick checks the project and the limit the owner registered. Which user may
read which room is your backend's decision. Retick has no rule about source
names, prefixes or membership.

## 4. The page

```ts
import { createStateReader } from '@retick/client'

const reader = createStateReader({
  url: 'https://retick.dev',
  credentials: async () => (await fetch('/api/retick-session', { method: 'POST' })).json(),
})

reader.subscribe((snapshot, freshness) => {
  // snapshot.state.entities[entityType][entityId].fields
  // freshness.status: 'live' | 'polling' | 'stale' | 'offline' | 'unauthorized' | 'forbidden' | 'idle'
})
await reader.snapshot()

// On unmount:
reader.close()
// On logout:
await reader.revoke() // 'revoked' | 'already-closed' | 'nothing-to-revoke' | 'refused' | 'unreachable'
```

What the reader does for you:

- Every stream line is the whole visible state, so a new line replaces the view.
  `cursor` names the credential's view and is compared for equality only. It is
  not a position and has no order.
- It keeps only the latest view in memory, sends the token in the
  `Authorization` header and never in a URL, and writes nothing to disk.
- A `401`, or an `end` line saying `closed`, `expired` or `revoked`, renews the
  credential once by calling `credentials()`. A renewed credential refused again
  stops the reader. After a renewal the stream starts over instead of resuming,
  so a user whose sources changed never keeps seeing the old ones.
- A stream already open learns about a logout or a revoked key within about
  5 seconds. New requests are refused at once.
- `freshness()` reports `status`, `ageSeconds`, `lastContactAt` and an English
  `reason`. The `StateReaderReason` type lists every value.

`close()` and `revoke()` are two different acts:

| call | does | when |
|---|---|---|
| `close()` | forgets the credential here | unmount: route change, re-render, discarded tab |
| `revoke()` | ends the session at the service with one `DELETE`, then forgets | the user logged out |

Only your app knows which one happened. A reader that revoked on every unmount
would end the session of someone who clicked a link. `revoke()` never throws and
sends at most one request per reader. Sessions nobody revokes end on their own
`expiresAt`.

A server can read the same state with `apiKey` (an `rt_` key with
`state:read`) instead of `credentials`. There is nothing to renew or revoke on
that path, and an `apiKey` is refused in a browser before anything is sent.

## 5. Moving an existing app

1. Register the issuer and the origins (§1).
2. Add the session route to your backend (§2, §3).
3. Read with `createStateReader` in the page while the current read path still
   runs beside it.
4. Check in production with two test users in one room: each sees their own
   source and the room, and not the other user's.
5. Remove the old read path only after that check.

## 6. From `createAgoraReader`

`createAgoraReader` reads Exo's Agora bridge on `/api/navegador/v1/*`, and its
wire format stays Portuguese. In 0.3.0 it is deprecated at the root and also
exported from `@retick/client/legacy`. New apps use `createStateReader`.

| Agora reader | State reader |
|---|---|
| `AGORA_ROUTES` (`/api/navegador/v1/sessao`, `/agora`, `/agora/stream`) | `STATE_ROUTES` (`/api/browser/v1/session`, `/state`, `/state/stream`) |
| `AgoraSnapshot`, nine fixed Agora collections | `StateSnapshot`, `state.entities[entityType][entityId]` with your own types and ids |
| `Freshness.reason: string` | `StateFreshness.reason: StateReaderReason` |
| `now?: () => Date` | `now?: () => number` |
| claim `retick.projeto/capacidades/fontes`, capability `agora.ler` | claim `retick.project/capabilities/sources`, capability `state:read` |

`close()`, `revoke()`, `subscribe()`, `refresh()`, `snapshot()` and
`freshness()` behave the same way in both.

## See also

- [TROUBLESHOOTING.md](TROUBLESHOOTING.md#browser): refusals of the exchange and
  of the origin check.
- [MANY-SOURCES.md](MANY-SOURCES.md): reading facts, rather than state, on a server.
