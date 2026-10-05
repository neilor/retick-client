/**
 * Types shared by the browser readers: what the host hands over, the status a
 * reader reports, and what logging out observed.
 *
 * They live apart from both readers so that `createStateReader` (root export)
 * does not depend on the Agora reader, which can then leave the root alone.
 */

export type Credentials = {
  token: string
  expiresAt: string
}

export type ReaderStatus =
  | 'idle'
  | 'live'
  | 'polling'
  | 'stale'
  | 'unauthorized'
  | 'forbidden'
  | 'offline'

/**
 * What `revoke()` observed. Never an error, and never a reason to stop logging
 * out: every branch here ends with the credential forgotten locally.
 *
 * The distinction that matters to an operator is `revoked` versus
 * `unreachable`. The first means the service recorded the end of the session,
 * and any other tab holding that token is already getting 401. The second
 * means nobody knows, and the session will end on its own clock.
 */
export type RevocationOutcome =
  /** `204`. The service ended it, and the end is persisted. */
  | 'revoked'
  /** `401`. The service already refuses this credential; the goal was met before we asked. */
  | 'already-closed'
  /** There was no credential in memory. Nothing was sent, and nothing had to be. */
  | 'nothing-to-revoke'
  /** The service answered, but not with an end: `403`, `5xx`, anything else. */
  | 'refused'
  /** Network failure, timeout or abort. The service may or may not have heard us. */
  | 'unreachable'

