# Troubleshooting

Grouped by what you were doing when it happened. Every refusal listed here is
one this client or the service actually produces; nothing is invented to fill a
row.

Two habits worth having first:

- **`RetickError` is safe to log in full.** Only the non-secret prefix
  `rtk_<12 hex>` ever appears in a message, and a token that does not match the
  format is not echoed at all. So print the error rather than hand-building a
  message from your options object.
- **read `retryable`.** Every error in this package carries it. If it is
  `false`, repeating the call gets the same answer, and the fix is somewhere
  else.

## Configuration, before anything leaves the machine

`RetickConfigError` is thrown by `createProducer`, `createConsumer` and
`createAgoraReader` at construction, so build them where you can catch them.

| message mentions | what happened | fix |
|---|---|---|
| no url | `url` missing or empty | pass the base URL |
| the route suffix | your `url` already carries `/api/v1`, `/api/leitura/v1` or `/api/navegador/v1` | pass the base URL; the client appends the route |
| no token | `token` missing or empty | pass the credential |
| publication token on the read surface | an `rtk_` went into `createConsumer` | issue a consumer credential; it starts with `rtl_` |

The last one is the most common one in the first hour, and it is deliberate. The
separation between publishing and reading is in the token format, so there is no
code path where one credential does the other one's job.

## Publishing

### `RetickAuthError`

| service says | meaning | what to do |
|---|---|---|
| `401 credencial ausente` | no `Authorization` header, or not `Bearer` | your token is empty at runtime; check how the environment reaches the process |
| `401 credencial recusada`, `motivo: desconhecido` | the secret does not match anything | wrong credential, wrong service, or it was revoked |
| `401 credencial recusada`, `motivo: expirado` | it matched, and its window closed | rotate. This is a separate answer on purpose: you already proved possession, so there is nothing to leak by saying which of the two it is |
| `503 ingestao nao configurada` | the service has no publication credential store at all | not your side. Tell your operator |

A revoked credential may keep working briefly. The store is reloaded per request
in some deployments and at boot in others, so if a revocation has not taken hold,
that is why.

### `RetickRequestError`

`400`, `405` and `413`. Not retryable, because repeating sends the same body.

| what | why |
|---|---|
| `400 corpo malformado` | not JSON, or not `{ fatos: [...] }` / a bare array |
| `400 lote vazio` | you called `publish([])` |
| `413 corpo grande demais` | over 1 048 576 bytes. The body is cut at the byte that overflows, so nothing is applied |
| `413 lote grande demais` | over 500 facts. `publish()` splits for you, so this means you overrode `limits` upward |
| `405` | you called `GET /api/v1/fatos`. The publication route is write-only |

### A fact came back `rejected`

This does not throw. Read `outcomes[i].reason`.

| reason says | what happened |
|---|---|
| `campo 'tenant' nao e aceito` (also `project`, `projeto`) | you tried to declare the project in the body. It comes from the credential, and only from there |
| `fonte '…' fora do escopo do token` | that `source` is not in this credential's scope. The message lists the ones that are |
| `campo obrigatorio ausente ou vazio: source` | and the same for the other five required fields |
| `payload com N bytes excede o limite` | one fact over 65 536 payload bytes. That fact is refused and the rest of the batch goes in |
| `fato precisa ser objeto` | an array or a scalar in the `fatos` list |

**A fact with no `payload` is refused**, even though `GET /api/v1/contrato` lists
`payload` as optional. That is a known divergence; the fix is widening, so code
written against the declared contract keeps working. Send an object.

### It said `pending`, and nothing appeared

The fact arrived ahead of a missing `sourceVersion`. Nothing is applied past a
hole, and it waits, held, until the missing one arrives. Then both go in, in
order.

Check `sources[]` in the response: `gaps` names the ranges, `pending` counts what
is held, and `resendSuggestion` names a range the service knows it is missing.
Deciding to resend is yours; Retick never fetches.

### It said `accepted`, but the Console shows nothing

Read `projected` in the outcome.

The Agora projection reduces six `entityType`s (`dispatch`, `machine`, `session`,
`block`, `approval`, `state`), and their reducers read keys in English inherited
from the first producer: `code`, `title`, and `state`, `to` or `initialState`.
Anything else is stored, ordered, deduplicated and counted in the cursor, and
rendered nowhere.

| what you published | `projected` | on the Console |
|---|---|---|
| one of the six, with those keys | `true` | appears, populated |
| one of the six, with your own keys | `true` | appears, every field `null` |
| an `entityType` of your own | `false` | nothing |

The middle row is the one that costs time. `projected: true` says a reducer
exists. It says nothing about whether the reducer understood you.

### `RetickSourceClosedError`

`503` naming a closed source. What was applied in memory did not reach storage,
so the **whole** batch fell, including the part that had passed.

**Do not advance your cursor.** Resend from the last confirmed fact once the
service is back. `whatToDo` carries the service's own instruction. Half-confirmed
would be worse than nothing: you would advance over a fact that exists nowhere.

### `RetickServerError`, `RetickNetworkError`, `RetickTimeoutError`

All three are retryable, and this client already retried: three extra attempts by
default, exponential backoff with full jitter, honouring `Retry-After`. If you
still see one, the service was down for longer than your retry budget.

Timeouts against a service you can reach at all are usually a wrong base URL:
`http` where the service wants `https`, or a host that resolves and silently
drops. `curl -sS -o /dev/null -w '%{http_code}\n' <url>/api/v1/contrato -H
"Authorization: Bearer $RETICK_TOKEN"` separates the two in one line. A `401`
means you reached Retick and the credential is wrong; no answer means you did not
reach it.

`429` is handled and v1 never emits it: there is a size limit and no rate limit.
Seeing one means a proxy in front of the service produced it.

## Reading your own project

### `applied: 0`, and `withheld.type` counts every fact

Your credential's type map is empty, so nothing passed. `contract().scope.types`
shows it.

A consumer credential issued from the Console has an empty map today. The Console
has no screen for choosing which payload keys per `entityType` a credential may
see, and defaulting to a wide cut would decide that for you. The
cut is an allow-list: a type outside the map has no intersection, and the fact is
taken out of the page.

A credential with an explicit map comes from
`POST /api/plano/v1/projetos/:id/credenciais`, called with an `rta_` key that
carries `credencial.emitir`:

```jsonc
{
  "tipo": "consumidor",
  "nome": "orders reader",
  "fontes": ["orders"],
  "tipos": { "order": ["number", "totalCents", "currency"] }
}
```

`rta_` keys are not issued from the Console either, so today this is a request to
whoever operates your Retick. Until it exists, the Console's own Estado Live
panel is the way to see your project's state.

### The facts came back out of order

They did not. The read route serves the log in **arrival** order, which is what
makes position a usable cursor, and `sourceVersion` order is restored on this
side. Use `replay`, which does it; `pull` hands you raw pages on purpose.

### `held` is not zero and stays that way

`replay` is holding facts behind a hole that never closed. Check the producer:
either a `sourceVersion` was skipped, or a fact was refused and never resent.

### I resumed and got the same facts again

You resumed by `sourceVersion` instead of `position`. Persist `result.position`
and pass it back as `position`.

## The Console

| what you see | what it is |
|---|---|
| *this account was not invited* | access is closed. Every refusal reason shows this same text; the specific one stays in the audit trail |
| back at the sign-in page after signing in | the session was refused. A session is a row in the database, so a role change, a deactivation or a sign-out in another tab ends it in the next request |
| another tab stopped working after you signed out | same reason, and it is the point of not using a signed cookie |
| the issued secret is gone after a reload | it appears once and no route returns it. Issue another and revoke the old one |
| the *issue credential* button is disabled | your role is `viewer`. Issuing is `developer` and up |
| the Estado Live panel says nothing is there | either no fact has been published to that project, or none of them used a vocabulary the projection reduces. See *It said `accepted`, but the Console shows nothing* |

## Reading the Agora from a browser

This surface needs the operator to have registered your identity issuer for the
project. Failures divide cleanly into that and the rest.

| status / state | meaning | retried |
|---|---|---|
| `403` with `emissor_nao_cadastrado` | your issuer is not registered. The answer will not change by asking again | no, and the reader stops |
| `403` with `audiencia` | the assertion was issued for a different audience. A token minted for somewhere else does not become a Retick credential | no |
| `400` with `escopo_vazio` | the intersection of what your issuer asked for and the registered ceiling is empty | no |
| `400` with `assercao_reusada` | the assertion was already exchanged. They are single-use, and they live sixty seconds | no, mint a new one |
| `401` | the credential is dead. The reader asks `credentials()` once, and a second `401` becomes `unauthorized` and stops | once |
| `429`, `5xx` | backs off with jitter | yes |
| status `offline` | no contact. The last snapshot is kept and `ageSeconds` grows, so you can tell stale from current | yes |

### CORS

The browser port checks `Origin` before anything else, and it refuses an origin
it does not know. The refusals, in the order they are checked: `ausente`,
`malformada`, `insegura` (not `https`), `local_fora_de_dev` (a `localhost` origin
against a production deployment), `nao_cadastrada`.

A refusal here shows up in the browser as a CORS error with no body, because that
is what a browser does with a response that lacks the header. Registering an
origin is on the operator's side.

The publication and read ports have no CORS headers at all, and that is not an
oversight: they serve raw facts to servers. Calling them from a tab fails, and
moving a long-lived `rtk_` or `rtl_` into a browser to make it work hands a
visitor your write or read access.

## Still stuck

- the full client surface, option by option: [../README.md](../README.md)
- the journey with the reasons attached: [FIRST-USE.md](FIRST-USE.md)
- a bug in this package: https://github.com/neilor/retick-client/issues
- anything about a specific Retick (access, origins, `rta_` keys, whether a
  deployment is durable) is with whoever operates it. This package does not know.
