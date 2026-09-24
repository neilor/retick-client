/**
 * HTTP, timeouts and retries. The only file that calls `fetch`.
 *
 * WHAT IT RETRIES, AND WHY THAT LIST IS SHORT.
 *
 * Retrying is safe here for one reason and it is not a general one: publishing
 * is idempotent on `(source, tenant, eventId)`, so the same batch sent twice
 * comes back the second time as `duplicate` and moves nothing. That makes an
 * unanswered request cheap to repeat and an ANSWERED refusal pointless to
 * repeat. The split follows exactly that line:
 *
 *   retried   network failure, timeout, `5xx`, `429`
 *   not       `400` `401` `403` `405` `413`, and `503` for a closed source
 *
 * `422` is not in either column because it is not a failure. It comes back to
 * the caller as a result, with the accepted part intact.
 *
 * `429` is retried and the service does not emit it: `docs/CONTRATO-V1.md`
 * section 4 says there is a size limit and no rate limit. It is handled because
 * a proxy in front of the service can emit it, and because handling a code that
 * never arrives costs nothing while meeting it unhandled costs a retry storm.
 *
 * `503` is the one that needs the body to classify. A service with no token
 * vault answers `503` and may outlive a retry. A source closed by a write
 * failure also answers `503`, carries `fonte`, and stays closed until the
 * process comes back up — retrying that is a loop that cannot end well, so it
 * throws immediately with the instruction the service sent.
 */

import {
  RetickAuthError,
  RetickError,
  RetickHttpError,
  RetickNetworkError,
  RetickRequestError,
  RetickServerError,
  RetickSourceClosedError,
  RetickTimeoutError,
} from './errors.ts'
import type { ErroWire } from './wire.ts'

export type HttpConfig = {
  /** Base URL of the service. Any path suffix is kept: `https://retick.example/retick` works. */
  url: string
  token: string
  fetch: typeof globalThis.fetch
  timeoutMs: number
  /** Extra attempts after the first. `0` means try once and give up. */
  retries: number
  retryBaseDelayMs: number
  retryMaxDelayMs: number
  sleep: (ms: number) => Promise<void>
  /** Injectable so a test can pin the jitter. */
  random: () => number
}

export type HttpResult<T> = { status: number; body: T }

/**
 * `rtk_<12 hex>` and nothing after it.
 *
 * The prefix is what the service stores in the clear and what identifies a
 * credential for revocation, so it is the useful half to put in an error. The
 * secret never leaves this process in a message, a log line or a stack trace.
 * A token that does not match the format is not echoed at all, because an
 * unrecognized string is exactly the case where the first 16 characters might
 * be the whole secret.
 */
export function tokenPrefix(token: string): string {
  return /^rtk_[0-9a-f]{12}_/.test(token) ? token.slice(0, 16) : '(unrecognized token format)'
}

/** `Retry-After` in seconds, when the service sends one we can read. */
function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get('retry-after')
  if (raw === null) return null
  const seconds = Number(raw.trim())
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 60_000) : null
}

/**
 * Exponential backoff with full jitter.
 *
 * Full jitter and not a fixed ramp because the failure this protects against is
 * a service coming back up, and every producer that was waiting retries at the
 * same instant if they all wait the same amount. The point of the random draw
 * is to not be the second outage.
 */
function backoffMs(attempt: number, cfg: HttpConfig): number {
  const ceiling = Math.min(cfg.retryMaxDelayMs, cfg.retryBaseDelayMs * 2 ** attempt)
  return Math.round(cfg.random() * ceiling)
}

type Attempt<T> =
  | { kind: 'ok'; result: HttpResult<T> }
  | { kind: 'fail'; error: RetickError; afterMs: number | null }

function classify(
  status: number,
  body: unknown,
  url: string,
  headers: Headers,
  prefix: string,
): Attempt<never> {
  const erro = (body ?? {}) as ErroWire
  const info = {
    status,
    url,
    body,
    tokenPrefix: prefix,
    ...(typeof erro.erro === 'string' ? { code: erro.erro } : {}),
    ...(typeof erro.motivo === 'string' ? { reason: erro.motivo } : {}),
  }
  const said = typeof erro.erro === 'string' ? erro.erro : `HTTP ${status}`
  const after = retryAfterMs(headers)

  if (status === 401 || status === 403) {
    return { kind: 'fail', error: new RetickAuthError(said, info), afterMs: after }
  }
  if (status === 400 || status === 405 || status === 413) {
    return { kind: 'fail', error: new RetickRequestError(said, info), afterMs: after }
  }
  if (status === 503 && typeof erro.fonte === 'string') {
    const error = new RetickSourceClosedError(`${said} (source '${erro.fonte}')`, {
      ...info,
      source: erro.fonte,
      whatToDo:
        erro.oQueFazer ??
        'do not advance the cursor; resend from the last confirmed fact when the service returns',
    })
    return { kind: 'fail', error, afterMs: after }
  }
  if (status === 429 || status >= 500) {
    return {
      kind: 'fail',
      error: new RetickServerError(said, { ...info, retryable: true }),
      afterMs: after,
    }
  }
  // Anything else is the service answering something the contract does not
  // describe — a proxy's 404, a redirect. Not retried, because guessing that a
  // response outside the contract is transient is how a client hides a
  // misconfigured URL behind a delay.
  return { kind: 'fail', error: new RetickHttpError(said, info), afterMs: after }
}

async function attempt<T>(
  cfg: HttpConfig,
  method: 'GET' | 'POST',
  path: string,
  payload: string | null,
): Promise<Attempt<T>> {
  const url = `${cfg.url.replace(/\/+$/, '')}${path}`
  const prefix = tokenPrefix(cfg.token)
  const controller = new AbortController()
  // Our own controller rather than `AbortSignal.timeout` so that an abort can
  // be told apart from a socket failure without reading a DOMException name.
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, cfg.timeoutMs)

  let response: Response
  try {
    response = await cfg.fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        accept: 'application/json',
        ...(payload !== null ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload !== null ? { body: payload } : {}),
      signal: controller.signal,
    })
  } catch (cause) {
    return {
      kind: 'fail',
      afterMs: null,
      error: timedOut
        ? new RetickTimeoutError({ url, timeoutMs: cfg.timeoutMs, cause })
        : new RetickNetworkError(`could not reach ${url}`, { url, cause }),
    }
  } finally {
    clearTimeout(timer)
  }

  // The body is read inside the same timeout window on purpose: a service that
  // answers headers fast and then stalls mid-body is the same unanswered
  // request as one that never answered, and the caller should not have to wait
  // forever for the half of it that is missing.
  let text: string
  try {
    text = await response.text()
  } catch (cause) {
    return {
      kind: 'fail',
      afterMs: null,
      error: timedOut
        ? new RetickTimeoutError({ url, timeoutMs: cfg.timeoutMs, cause })
        : new RetickNetworkError(`connection dropped while reading ${url}`, { url, cause }),
    }
  }

  let body: unknown = null
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      // Not JSON. Almost always a proxy or a load balancer answering instead of
      // the service. Kept as the raw string so the error shows what arrived.
      body = text
    }
  }

  if (response.status === 200 || response.status === 422) {
    return { kind: 'ok', result: { status: response.status, body: body as T } }
  }
  return classify(response.status, body, url, response.headers, prefix) as Attempt<T>
}

/** Runs one request, retrying the attempts the contract says are worth retrying. */
export async function request<T>(
  cfg: HttpConfig,
  method: 'GET' | 'POST',
  path: string,
  payload: string | null = null,
): Promise<HttpResult<T>> {
  let last: RetickError | null = null

  for (let tries = 0; tries <= cfg.retries; tries++) {
    const outcome = await attempt<T>(cfg, method, path, payload)
    if (outcome.kind === 'ok') return outcome.result

    last = outcome.error
    if (!outcome.error.retryable || tries === cfg.retries) break
    await cfg.sleep(outcome.afterMs ?? backoffMs(tries, cfg))
  }

  throw last as RetickError
}
