/**
 * One error class per row of the contract's response table, and no more.
 *
 * The point of separating them is not tidiness, it is that the producer's
 * reaction differs and the status code alone does not tell it apart. Two
 * examples that the contract calls out by name:
 *
 *  - `422` is not an error at all and has no class here. The body has the same
 *    shape as a `200`, and the part that passed passed. A producer that treated
 *    every `4xx` as "send the same thing again" would repeat forever a fact
 *    that will never be accepted. `publish()` returns it as a result.
 *  - `503` is two different situations behind one number. One is a service
 *    without a token vault, which a retry may outlive. The other is a source
 *    closed by a write failure, which stays closed until the process comes back
 *    up, and which carries an explicit instruction not to advance the cursor.
 *    They are {@link RetickServerError} and {@link RetickSourceClosedError}.
 *
 * The token never appears in an error. `RetickHttpError` carries the token
 * prefix, which is what the service logs and what identifies a credential for
 * revocation, and nothing else.
 */

/** Base of everything this client throws. Catch this to catch all of it. */
export class RetickError extends Error {
  /** `true` when sending the exact same request again could succeed. */
  readonly retryable: boolean

  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = new.target.name
    this.retryable = options.retryable ?? false
  }
}

export type HttpErrorInfo = {
  status: number
  url: string
  /** The `erro` field of the body, when the body was JSON. */
  code?: string
  /** The `motivo` field, when present. */
  reason?: string
  body: unknown
  /** First 16 characters of the token: `rtk_<12 hex>`. Never the secret. */
  tokenPrefix: string
  retryable?: boolean
}

/** The service answered, and the answer was a refusal. */
export class RetickHttpError extends RetickError {
  readonly status: number
  readonly url: string
  readonly code: string | undefined
  readonly reason: string | undefined
  readonly body: unknown
  readonly tokenPrefix: string

  constructor(message: string, info: HttpErrorInfo) {
    super(message, { retryable: info.retryable ?? false })
    this.status = info.status
    this.url = info.url
    this.code = info.code
    this.reason = info.reason
    this.body = info.body
    this.tokenPrefix = info.tokenPrefix
  }
}

/**
 * `401` credential absent, unknown or expired, and `403` token without the
 * `fatos.publicar` capability.
 *
 * Never retryable. The vault is read when the process starts, so a token that
 * was just revoked stays refused, and a token that was just issued stays
 * refused until the service comes back up.
 */
export class RetickAuthError extends RetickHttpError {}

/**
 * `400`, `405` and `413`: the request itself is wrong.
 *
 * Never retryable, because the same bytes produce the same answer. `413` on a
 * batch is the one worth reading: it means the body or the fact count went
 * over the limit and NOTHING was applied. See `limits` on the body.
 */
export class RetickRequestError extends RetickHttpError {}

/** `5xx` that a retry may outlive. Retryable, and safe to retry: publishing is idempotent. */
export class RetickServerError extends RetickHttpError {}

/**
 * `503` with a `fonte` field: that source stopped accepting.
 *
 * What the service applied in memory did not reach storage, so the whole batch
 * fell, including the part that had passed. Half-confirmed would be worse: the
 * producer would advance its cursor over a fact that exists nowhere.
 *
 * Not retryable, and this is the one place where that word means something
 * beyond backoff. The pair stays closed until the process comes back up. What
 * the producer must do is in `whatToDo`, and it is: do not advance the cursor,
 * resend from the last confirmed fact when the service returns.
 */
export class RetickSourceClosedError extends RetickHttpError {
  readonly source: string
  readonly whatToDo: string

  constructor(message: string, info: HttpErrorInfo & { source: string; whatToDo: string }) {
    super(message, { ...info, retryable: false })
    this.source = info.source
    this.whatToDo = info.whatToDo
  }
}

/** The request never got an answer: DNS, connection refused, socket reset, TLS. */
export class RetickNetworkError extends RetickError {
  readonly url: string

  constructor(message: string, info: { url: string; cause?: unknown }) {
    super(message, { retryable: true, cause: info.cause })
    this.url = info.url
  }
}

/**
 * The request was still open when `timeoutMs` ran out.
 *
 * Retryable for the same reason as any other unanswered request, and safe for a
 * specific one: a timeout does not say the fact did not arrive, only that the
 * answer did not. Resending it is exactly the case idempotency was built for —
 * it comes back as `duplicate` and nothing moves.
 */
export class RetickTimeoutError extends RetickError {
  readonly url: string
  readonly timeoutMs: number

  constructor(info: { url: string; timeoutMs: number; cause?: unknown }) {
    super(`no answer from ${info.url} within ${info.timeoutMs}ms`, {
      retryable: true,
      cause: info.cause,
    })
    this.url = info.url
    this.timeoutMs = info.timeoutMs
  }
}

/** Something the client was told to do that it cannot: no url, no token. */
export class RetickConfigError extends RetickError {}
