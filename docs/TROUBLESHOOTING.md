# Troubleshooting

Grouped by what you were doing when it happened. The codes are the ones
`@retick/client` 0.3.0 and the service's English routes produce.

Two habits worth having first:

- Log `RetickError` in full. It never contains an `rt_` secret. Print the
  error rather than building a message from your options object.
- Read `retryable`. Every error in this package carries it. If it is
  `false`, repeating the call gets the same answer. HTTP errors also carry
  `status`, `code` and `reason` from the service's answer.

## Configuration, before anything leaves the machine

`RetickConfigError` is thrown at construction, so build clients where you can
catch the error.

| message mentions | what happened | fix |
|---|---|---|
| `url is required` | `url` missing or empty | pass the base URL |
| `must not include the … suffix` | your `url` already ends in `/api/v1` or `/api/read/v1` | pass the base URL; the client appends the route |
| `apiKey must look like rt_<12 hex>_<secret>` | the value is not an `rt_` key, or was cut when copied | copy the secret again; it is shown once, so issue another if it is lost |
| `apiKey is a server credential and must not run in a browser` | an `apiKey` reached code running in a page | read state in a page with `createStateReader` and `credentials` ([BROWSER.md](BROWSER.md)) |
| `pass either apiKey or token` | both were given | pass one |
| `this is a publication token` | an older `rtk_` went into `createConsumer` | use an `rt_` key with `log:read` |
| `pass resume or position to replay(), not both` | both checkpoints were given | pass `resume` only |
| `resume was read up to position …, past the end of source …'s log` | the checkpoint is from another service, or the log did not survive a restart | replay that source from the beginning, without `resume` |

## Publishing

### `RetickAuthError` (`401`, `403`)

| `code` / `reason` | meaning | what to do |
|---|---|---|
| `credential_missing` | no `Authorization: Bearer` header reached the service | your key is empty at runtime; check how the environment reaches the process |
| `credential_refused` / `unknown` | the secret matches no key | wrong key, or wrong service |
| `credential_refused` / `expired` | the key's expiry date passed | issue a new key |
| `credential_refused` / `revoked` | the key was revoked | issue a new key |
| `credential_refused` / `missing_operation` (`403`) | the key lacks `facts:publish` | add the operation, or use the right key |

### `RetickRequestError` (`400`, `405`, `413`)

Not retryable: repeating sends the same body.

| `code` | why |
|---|---|
| `invalid_json` | the body is not JSON |
| `invalid_body` | not `{ "facts": [...] }` |
| `empty_batch` | you called `publish([])` |
| `body_too_large` | over the body limit. Nothing was applied |
| `batch_too_large` | too many facts in one request. `publish()` splits for you, so this means `limits` was overridden upward |

`contract().limits` reports the limits the service enforces.

### A fact came back `rejected`

This does not throw. Read `outcomes[i].reason` (a stable code) and
`outcomes[i].message`.

| `reason` | what happened |
|---|---|
| `forbidden_field` | the fact names `tenant`, `project` or `projeto`. The project comes from the key |
| `source_out_of_scope` | the key is restricted to sources and this is not one of them |
| `missing_field` | one of `eventId`, `source`, `sourceVersion`, `type`, `entityType`, `occurredAt` is missing or empty |
| `payload_not_object` | `payload` is missing, `null`, an array or a scalar. Send an object, even `{}` |
| `payload_too_large` | that one fact's payload is over the limit. The rest of the batch goes in |
| `invalid_timestamp`, `invalid_source_version` | the field is there and unreadable |

The service may add codes; these are the ones a first producer meets.

### It said `pending`, and nothing appeared

The fact arrived ahead of a missing `sourceVersion`. Nothing is applied past a
hole; it waits until the missing version arrives, and then both go in, in order.

`contract().sources` names the ranges in `gaps`, and `resendSuggestion` names a
range the service knows it is missing. Resending is your side's job; Retick
never fetches. [PRODUCERS.md](PRODUCERS.md) covers what to do when the answer to
an earlier publish was lost.

### It said `stale`

The version is at or below the source's intact point, or below its floor. The
fact was not stored. If it is the same fact as the one already there, nothing is
lost. If it is a different fact, two writers picked the same version:
[PRODUCERS.md](PRODUCERS.md#allocating-sourceversion-with-several-instances).

### `RetickServerError`, `RetickNetworkError`, `RetickTimeoutError`

Retried by the client already (`retries`, default 3). When one still reaches you,
the facts may or may not be stored. Send the same facts again later, with the
same `eventId` and `sourceVersion`: `duplicate` means the lost request stored
them. Never give their versions to other facts.

### `RetickSourceClosedError`

`503` naming a closed source: what the service applied in memory did not reach
storage, so the whole batch fell, including what had passed. Do not advance
anything on your side. Resend from the last confirmed fact; `whatToDo` carries
the service's own instruction.

## Reading your own project

### `credential_refused` / `missing_operation`

The key lacks `log:read`. Add it in **Access → API keys**, or issue a key that
has it.

### `applied` is low, and `withheld` counts the rest

The key does not let those facts through. `withheld.type` counts facts of types
outside the key's type restriction; leave **Types a read returns** empty to read
every type. `withheld.sensitivity` counts facts above the key's sensitivity
ceiling.

The older `rtl_` credentials issued from the Console have an empty type map and
read nothing. Use an `rt_` key with `log:read`.

### The facts came back out of order

The read route serves the log in arrival order, and `sourceVersion` order is
restored on this side. `replay` does it; `pull` hands you raw pages on purpose.

### `held` is not zero and stays that way

`replay` is holding facts behind a hole that never closed. Check the producer:
a `sourceVersion` was skipped, or a fact was refused and never resent.

### I resumed and lost or repeated facts

Resume from `result.resume`, not from `result.position` and not from a
`sourceVersion`. [MANY-SOURCES.md](MANY-SOURCES.md#one-source-replay-with-resume).

## The Console

| what you see | what it is |
|---|---|
| *This account was not invited.* | access is by invitation. Ask whoever operates your Retick |
| the issued secret is gone after a reload | it appears once and no route returns it. Issue another and revoke the old one |
| the Studio says *Nothing published yet* | no fact reached this project. Check the key's project with `contract().scope.project` |
| the key form refuses to issue | no operation is checked. A key that allows nothing is refused |

## Browser

### Exchanging the assertion (`POST /api/browser/v1/session`)

| status | `code` / `reason` | meaning |
|---|---|---|
| `403` | `origin_refused` | the page's origin is not registered for the project, or no `Origin` was sent |
| `403` | `assertion_refused` / `issuer_not_registered` | `retick.project` is not the tenant key, or the issuer is not registered for it |
| `401` | `assertion_refused` / `audience` | `aud` is not the audience registered with the issuer, exactly |
| `401` | `assertion_refused` / `signature`, `issuer` | the JWT was not signed by the key behind the registered JWKS, or `iss` differs |
| `401` | `assertion_refused` / `expired`, `lifetime_too_long` | the assertion is past `exp`, or lives more than 300 seconds |
| `401` | `assertion_refused` / `replayed` | this `jti` was already exchanged. Sign a new assertion per exchange |
| `400` | `exchange_refused` / `sources_required` | no `sources` and no `allSources` |
| `400` | `exchange_refused` / `ambiguous_scope` | both `sources` and `allSources` |
| `400` | `exchange_refused` / `source_outside_ceiling` | a source is outside the issuer's list; `sources` names it |
| `400` | `exchange_refused` / `all_sources_not_granted` | `allSources` from an issuer registered with an exact list |
| `400` | `exchange_refused` / `too_many_sources` | more than 32 sources |

How to register an issuer and choose sources: [BROWSER.md](BROWSER.md).

### Reading state

`createStateReader` reports problems through `freshness().reason` rather than by
throwing:

| `reason` | meaning | the reader |
|---|---|---|
| `forbidden` | `403`: the origin is not registered, or the credential lacks the `state:read` capability | stops |
| `session_closed` | a renewed credential was refused again | stops |
| `rate_limited` | `429`. The state routes limit requests per credential and per project | backs off for at least `retry-after` |
| `service_unavailable` | `5xx` | backs off with jitter |
| `network`, `connection_lost` | no contact; the last view is kept and `ageSeconds` grows | retries |
| `no_credential` | your `credentials()` threw, or returned an `rt_` key in a browser | shows `unauthorized`; `refresh()` or `snapshot()` asks `credentials()` again |

`StateReaderReason` in the package lists every value.

A refused origin shows up in the browser's console as a CORS error with no body,
because the browser hides a response that lacks the CORS header. The publish and
read routes send no CORS headers at all: they serve servers, and calling them
from a page fails on purpose.

## Still stuck

- the client's surface, option by option: [../README.md](../README.md)
- the journey with the reasons attached: [FIRST-USE.md](FIRST-USE.md)
- a bug in this package: https://github.com/neilor/retick-client/issues
- anything about a specific Retick (access, registered origins, whether a
  deployment is durable) is with whoever operates it.
