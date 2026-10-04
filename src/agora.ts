/**
 * `AgoraReader`: the browser-side reader for the compact projection.
 *
 * WHY THIS IS NOT `createConsumer`.
 *
 * `consumer.ts` pulls raw facts by cursor, holds them in an `OrderedBuffer` and
 * hands them to whoever declared the collections. It is a SERVER-side client: it
 * needs a long-lived credential, it reads the log, and it assumes the process it
 * runs in is trusted. None of those hold in a browser tab.
 *
 * This reader never pulls facts. It asks for a projection that the service
 * already materialized, and the only thing it keeps is the latest one. There is
 * no `pull` here, and adding one would be the first step towards this reader
 * serving history — which is the one thing the capability split exists to stop.
 *
 * THE RULES THIS FILE CARRIES, from ADR-0017 §7.
 *
 * - It NEVER persists. Token and snapshot live in memory. Reloading the page
 *   redoes the whole path. `localStorage` would put another tenant's compact
 *   state on someone's disk, and a disk outlives the session that justified it.
 * - It NEVER puts the token in a URL. If a transport can't carry a header, the
 *   transport is wrong — which is why this uses `fetch` streaming and not
 *   `EventSource`.
 * - `401` asks for a fresh credential ONCE, and only once. Two in a row become
 *   `unauthorized` and stop. Retrying against a dead session is how a
 *   well-meaning client turns into a brute-force attack on its own server.
 * - `403` stops the reader. No backoff, no retry: the answer will not change.
 * - `429` and `5xx` back off with jitter.
 * - `offline` keeps the last snapshot with `ageSeconds` growing. Without that
 *   mark, the consumer cannot tell stale data from current data.
 *
 * TEARDOWN IS TWO DIFFERENT ACTS, AND THIS FILE REFUSES TO GUESS WHICH.
 *
 * `close()` forgets the credential here. `revoke()` asks the service to end it
 * there, and then forgets it. They are separate methods because the host is the
 * only one who knows which happened: a route change, a re-render and a
 * discarded tab all unmount a reader, and none of them means the person left.
 * A reader that revoked on every unmount would kill the session of someone who
 * clicked a link, and the next screen would have to mint a new one — churn that
 * looks like a bug in the service and is a bug in the client.
 *
 * So the default is the cheap one. The session carries its own `expiraEm` and
 * dies on its own; `revoke()` exists for the one case where waiting for that is
 * wrong, which is someone saying, out loud, that they are logging out.
 */

import type { ReadFact } from './consumer.ts'
import { resolveCredential } from './credential.ts'
import { RetickConfigError } from './errors.ts'

/** Version of the browser-facing contract this reader speaks. */
export const AGORA_ROUTES = {
  session: '/api/navegador/v1/sessao',
  snapshot: '/api/navegador/v1/agora',
  stream: '/api/navegador/v1/agora/stream',
} as const

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

export type Freshness = {
  status: ReaderStatus
  /** Age of the served data, in seconds, as this reader computed it. */
  ageSeconds: number | null
  /** When the reader last spoke to the service. */
  lastContactAt: string | null
  /** Why it is not `live`. Never the body of an error. */
  reason: string | null
}

/** The compact projection, opaque to this reader on purpose. */
/**
 * What `revoke()` observed. Never an error, and never a reason to stop logging
 * out: every branch here ends with the credential forgotten locally.
 *
 * The distinction that matters to an operator is `revoked` versus
 * `unreachable`. The first means the row in `plano_sessao_navegador` carries an
 * `encerrada_em` and any other tab holding that token is already getting 401.
 * The second means nobody knows, and the session will end on its own clock.
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

export type AgoraSnapshot = {
  navegador: number
  versao: string
  cursor: number
  emitidaEm: string
  reinicio: boolean
  escopo: { projeto: string; fontes: string[] }
  agora: Record<string, unknown>
}

export type AgoraReaderOptions = {
  /** Base URL of the Retick service. No trailing slash needed. */
  url: string
  /**
   * Supplied by the host. The reader never learns where it comes from, and
   * never stores it.
   *
   * In the Exo's Mesa this hits a same-origin route that reads the HttpOnly
   * session cookie. The reader does not know that, and must not: a reader that
   * knew how to mint its own credential would be a reader that could mint one
   * after logout.
   */
  credentials?: () => Promise<Credentials>
  /**
   * The single Retick API key, `rt_...`, scoped to include `state:read`.
   *
   * SERVER-SIDE ONLY, and it throws in a browser — see `credential.ts`. It is
   * the alternative to `credentials` for a process that has no session to mint:
   * a job, a dashboard backend, a script. Pass one or the other, not both.
   *
   * With an API key there is nothing to renew and nothing to revoke from here:
   * the key has its own expiry, set when it was issued, and it is revoked in
   * the Console. `revoke()` says so instead of calling a route that would 404.
   */
  apiKey?: string
  /**
   * Freshness floor. Protects the service's single instance from a tab in a
   * loop — including a tab in a loop caused by a bug in this file.
   */
  minIntervalMs?: number
  /** Ceiling for reconnection backoff. */
  maxBackoffMs?: number
  /**
   * How long `revoke()` may hold its caller.
   *
   * Short on purpose. This budget is spent inside someone's logout, and a
   * logout that hangs because Retick is slow is a worse failure than a session
   * that outlives the click and expires on its own a few minutes later.
   */
  revokeTimeoutMs?: number
  now?: () => Date
  /** Injected for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}

export type AgoraReader = {
  snapshot(): Promise<AgoraSnapshot>
  subscribe(fn: (s: AgoraSnapshot, f: Freshness) => void): () => void
  freshness(): Freshness
  refresh(): Promise<void>
  /**
   * Forgets the credential HERE. Does not tell the service anything.
   *
   * This is what unmounting should call. See the note at the top of the file
   * for why revoking on unmount would be wrong.
   */
  close(): void
  /**
   * Ends the session AT THE SERVICE, then forgets it here.
   *
   * Call this only for a deliberate exit — a logout, or a host tearing the
   * reader down for good. It never throws and never rejects: the outcome comes
   * back as a value so that a caller inside a logout has nothing to catch.
   *
   * At most one `DELETE` leaves a reader, ever. A second call returns the first
   * call's outcome without touching the network, which is what makes it safe to
   * wire into both a logout handler and an unmount path that may race it.
   */
  revoke(): Promise<RevocationOutcome>
}

const DEFAULT_MIN_INTERVAL_MS = 1_000
const DEFAULT_MAX_BACKOFF_MS = 30_000
const DEFAULT_REVOKE_TIMEOUT_MS = 2_000

/** Status values from which the reader does not recover on its own. */
const TERMINAIS: ReaderStatus[] = ['unauthorized', 'forbidden']

export function createAgoraReader(op: AgoraReaderOptions): AgoraReader {
  const base = op.url.replace(/\/+$/, '')

  /**
   * One source of credential, chosen at construction.
   *
   * `apiKey` is validated and browser-checked by `resolveCredential`; the
   * session path is untouched and is still the only one a page may take.
   */
  if (op.apiKey !== undefined && op.credentials !== undefined) {
    throw new RetickConfigError(
      'createAgoraReader: pass either apiKey or credentials, not both — ' +
        'an API key is a server credential and a session is a browser one',
    )
  }
  if (op.apiKey === undefined && op.credentials === undefined) {
    throw new RetickConfigError('createAgoraReader: apiKey or credentials is required')
  }
  const chaveDeApi =
    op.apiKey === undefined
      ? null
      : resolveCredential({ apiKey: op.apiKey }, {
          factory: 'createAgoraReader',
          legacyPrefix: 'rtv_',
          allowBrowser: false,
        })
  /**
   * An API key does not expire from the reader's point of view.
   *
   * It DOES expire — the Console sets a date — but the reader has no way to
   * learn when, and inventing a date here would make it renew a credential
   * that has no renewal route. When the key stops working the service says
   * `401`, and the reader already knows what to do with that.
   */
  const obterCredencial: () => Promise<Credentials> =
    chaveDeApi === null
      ? (op.credentials as () => Promise<Credentials>)
      : async () => ({ token: chaveDeApi, expiresAt: '9999-12-31T23:59:59.999Z' })
  const agora = op.now ?? (() => new Date())
  const buscar = op.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const minIntervalo = op.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  const maxRecuo = op.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
  const tetoDaRevogacao = op.revokeTimeoutMs ?? DEFAULT_REVOKE_TIMEOUT_MS

  let credencial: Credentials | null = null
  let ultimo: AgoraSnapshot | null = null
  let estado: ReaderStatus = 'idle'
  let razao: string | null = null
  let ultimoContato: Date | null = null
  let cursor = 0
  let fechado = false
  let tentativas = 0
  let abortar: AbortController | null = null
  let laco: Promise<void> | null = null
  let ultimaBusca = 0
  /*
   * The whole idempotency mechanism, and it is one variable on purpose.
   *
   * Holding the PROMISE — not a boolean — makes the concurrent case fall out
   * for free: two callers racing get the same in-flight request and the same
   * answer, and the second one does not have to know it lost. It is never
   * cleared, so "at most one DELETE per reader" holds for the life of the
   * reader and not just while the first one is in flight.
   */
  let revogacao: Promise<RevocationOutcome> | null = null

  const assinantes = new Set<(s: AgoraSnapshot, f: Freshness) => void>()

  function frescor(): Freshness {
    const idade = ultimo
      ? Math.max(0, Math.round((agora().getTime() - Date.parse(ultimo.emitidaEm)) / 1000))
      : null
    return {
      status: estado,
      ageSeconds: idade,
      lastContactAt: ultimoContato ? ultimoContato.toISOString() : null,
      reason: razao,
    }
  }

  function anunciar(): void {
    if (!ultimo) return
    const f = frescor()
    for (const fn of assinantes) {
      // A broken subscriber must not take the reader down with it.
      try {
        fn(ultimo, f)
      } catch {
        /* subscriber's problem, and it dies there */
      }
    }
  }

  function aplicar(s: AgoraSnapshot): void {
    /*
     * ORDER IS ENFORCED HERE TOO, and not only on the server.
     *
     * The service emits a strictly increasing cursor, but a reader that trusted
     * that blindly would apply out-of-order frames if anything between the two
     * ever reordered them. Dropping a frame we already passed is cheap; showing
     * a counter that went backwards is not, because nothing about it looks wrong.
     */
    if (fechado) return
    if (!s.reinicio && s.cursor <= cursor) return
    ultimo = s
    cursor = s.cursor
    ultimoContato = agora()
    anunciar()
  }

  /*
   * The renewal in flight, shared by every path that needs one (D-20261003-017).
   *
   * The snapshot and the stream can learn the credential is dead at the same
   * moment. Each used to call the host on its own, so one revocation cost two
   * `credentials()` calls, and a 401 arriving late for a token the other path
   * had already replaced cost a third. Cleared when it settles: a later
   * revocation is a new event and gets its own renewal.
   */
  let pendingRenewal: Promise<Credentials | null> | null = null

  /**
   * Fetches a credential, renewing at most once per failed attempt.
   *
   * `forcar` is what makes "renew once" enforceable: the 401 path asks for a
   * fresh one, and if the fresh one also gets 401, the caller gives up instead
   * of asking again.
   *
   * `refused` is the credential the 401 was about. If it is no longer the
   * current one, another path already renewed, and that answer is reused
   * instead of minting again.
   */
  async function credenciais(forcar = false, refused?: Credentials): Promise<Credentials | null> {
    const current = credencial
    const valid = current !== null && Date.parse(current.expiresAt) > agora().getTime()
    if (valid && (!forcar || (refused !== undefined && current.token !== refused.token))) {
      return current
    }
    pendingRenewal ??= (async () => {
      try {
        const fresh = await obterCredencial()
        // `close()` may have landed while the host was minting. Keeping the
        // answer would put a credential back into a reader that forgot it.
        if (fechado) return null
        credencial = fresh
        return fresh
      } catch (e) {
        estado = 'unauthorized'
        razao = 'sem credencial'
        credencial = null
        void e
        return null
      } finally {
        pendingRenewal = null
      }
    })()
    return pendingRenewal
  }

  function cabecalhos(c: Credentials): Record<string, string> {
    // The token goes in a header. There is no code path in this file that puts
    // it anywhere else, and the server refuses it in the query string anyway.
    return { authorization: `Bearer ${c.token}` }
  }

  async function pedir(caminho: string, c: Credentials, sinal?: AbortSignal): Promise<Response> {
    return buscar(`${base}${caminho}`, {
      headers: cabecalhos(c),
      signal: sinal,
      // No cookies. This door authenticates by header, and sending credentials
      // cross-origin would ask the service for a permission it must not grant.
      credentials: 'omit',
    })
  }

  /** Backoff with jitter. Ten tabs recovering together must not sync up. */
  function recuo(): number {
    const base = Math.min(maxRecuo, 500 * 2 ** Math.min(tentativas, 6))
    return Math.round(base / 2 + Math.random() * (base / 2))
  }

  const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /**
   * Maps an HTTP answer to what the reader should do next.
   *
   * This is the whole "401 once, 403 never" rule, in one place, so that it can
   * be read and tested as a rule instead of as scattered branches.
   */
  type Decisao = 'ok' | 'renovar' | 'parar' | 'recuar'
  function decidir(codigo: number, jaRenovou: boolean): Decisao {
    if (codigo >= 200 && codigo < 300) return 'ok'
    if (codigo === 401) return jaRenovou ? 'parar' : 'renovar'
    if (codigo === 403) return 'parar'
    return 'recuar'
  }

  async function buscarSnapshot(jaRenovou = false, refused?: Credentials): Promise<AgoraSnapshot | null> {
    if (fechado) return null
    /*
     * The floor is stamped HERE, and not only in `refresh`. `snapshot()` is a
     * request like any other: if it did not count, the first `refresh` right
     * after it would always slip through, and a tab calling both on mount would
     * make two requests where the floor promised one.
     */
    ultimaBusca = agora().getTime()
    const c = await credenciais(jaRenovou, refused)
    if (!c) return null

    let r: Response
    try {
      r = await pedir(AGORA_ROUTES.snapshot, c)
    } catch {
      estado = 'offline'
      razao = 'rede'
      anunciar()
      return null
    }

    if (fechado) return null

    const d = decidir(r.status, jaRenovou)
    if (d === 'renovar') return buscarSnapshot(true, c)
    if (d === 'parar') {
      estado = r.status === 403 ? 'forbidden' : 'unauthorized'
      razao = r.status === 403 ? 'sem permissao' : 'sessao encerrada'
      anunciar()
      return null
    }
    if (d === 'recuar') {
      estado = 'stale'
      // `504` from the Agora means the reduction blew its ceiling. It is a
      // reason, not a retry: hammering it makes the ceiling harder to hit.
      razao = r.status === 429 ? 'limite de taxa' : `servico ${r.status}`
      anunciar()
      return null
    }

    const s = (await r.json()) as AgoraSnapshot
    aplicar(s)
    return s
  }

  /**
   * The live stream: NDJSON over `fetch`, one projection per line.
   *
   * Reconnection resumes from `desde=<cursor>`. If the service still has that
   * cursor it sends only what was missed; if not, it sends a full snapshot
   * marked `reinicio`, and `aplicar` replaces instead of merging.
   */
  async function abrirStream(jaRenovou = false, refused?: Credentials): Promise<void> {
    if (fechado) return
    const c = await credenciais(jaRenovou, refused)
    if (!c) return

    abortar = new AbortController()
    const caminho = cursor > 0 ? `${AGORA_ROUTES.stream}?desde=${cursor}` : AGORA_ROUTES.stream

    let r: Response
    try {
      r = await pedir(caminho, c, abortar.signal)
    } catch {
      if (fechado) return
      estado = 'offline'
      razao = 'rede'
      anunciar()
      return
    }

    /*
     * `fechado` is re-checked after EVERY await in this function.
     *
     * `close()` can land while a request is in flight, and the answer arrives
     * afterwards. Without this guard the late answer writes `live` over the
     * `idle` that `close` just set, and a reader the host believes it shut down
     * reports itself as connected.
     */
    if (fechado) return

    const d = decidir(r.status, jaRenovou)
    if (d === 'renovar') return abrirStream(true, c)
    if (d === 'parar') {
      estado = r.status === 403 ? 'forbidden' : 'unauthorized'
      razao = r.status === 403 ? 'sem permissao' : 'sessao encerrada'
      anunciar()
      return
    }
    if (d === 'recuar' || !r.body) {
      estado = 'stale'
      razao = r.status === 429 ? 'limite de taxa' : `servico ${r.status}`
      anunciar()
      return
    }

    estado = 'live'
    razao = null
    tentativas = 0

    const leitor = r.body.getReader()
    const dec = new TextDecoder()
    let resto = ''
    try {
      for (;;) {
        const { value, done } = await leitor.read()
        if (done) break
        resto += dec.decode(value, { stream: true })
        const partes = resto.split('\n')
        resto = partes.pop() ?? ''
        for (const linha of partes) {
          if (!linha.trim()) continue
          let o: Record<string, unknown>
          try {
            o = JSON.parse(linha) as Record<string, unknown>
          } catch {
            // A malformed line is not a reason to drop a healthy connection.
            continue
          }
          if (o.tipo === 'batimento') {
            ultimoContato = agora()
            continue
          }
          if (o.tipo === 'fim') {
            // The service says this session is over. Renewing is the right
            // move exactly once; `abrirStream` enforces the "once".
            razao = typeof o.motivo === 'string' ? o.motivo : 'encerrada'
            return
          }
          aplicar(o as unknown as AgoraSnapshot)
        }
      }
    } catch {
      if (!fechado) {
        estado = 'offline'
        razao = 'conexao caiu'
        anunciar()
      }
    } finally {
      void leitor.cancel().catch(() => {})
    }
  }

  /** The supervisor: keeps the stream up, and stops for good on terminal status. */
  /** Local teardown. Everything `close()` does, and the first half of `revoke()`. */
  function esquecer(): void {
    fechado = true
    abortar?.abort()
    assinantes.clear()
    credencial = null
    estado = 'idle'
  }

  /**
   * The explicit end: `DELETE /api/navegador/v1/sessao`, then forget.
   *
   * THE ORDER IS THE POINT. The token is the only thing that can authenticate
   * its own revocation, so forgetting first would leave a live session on the
   * service with nobody left who can end it. Everything after the request runs
   * in `finally`, so the credential is forgotten whether the service answered,
   * refused, or never heard us.
   *
   * IT NEVER MINTS. `credenciais()` is not called here, and that is deliberate:
   * a teardown path that could ask the host for a credential would be a path
   * that creates a session in the middle of someone logging out. If there is
   * nothing in memory, there is nothing to revoke, and that is an outcome and
   * not a failure.
   *
   * THE TIMEOUT IS ENFORCED TWICE. The signal asks the transport to give up;
   * the race stops waiting regardless. A `fetchImpl` that ignores its signal —
   * a polyfill, a test double, an interceptor someone installed — would
   * otherwise hold a logout open for as long as it liked.
   */
  async function revogar(): Promise<RevocationOutcome> {
    const c = credencial
    // Stop the supervisor before the request. Reopening the stream with a token
    // we are about to kill would spend a reconnect to earn a 401.
    fechado = true
    abortar?.abort()

    if (!c) {
      esquecer()
      return 'nothing-to-revoke'
    }

    /**
     * An API key is not revoked from here, and pretending otherwise would be
     * worse than saying so.
     *
     * The DELETE route ends a BROWSER SESSION — a row in
     * `plano_sessao_navegador`. An `rt_` has no such row: it is revoked in the
     * Console, by a person, and that revocation is immediate for every process
     * holding it. Calling the route with an API key would 404, and the `404`
     * would be reported as `unreachable` — which reads like a network problem
     * and would send somebody looking for one.
     *
     * The local forgetting still happens: this reader stops using the key.
     */
    if (chaveDeApi !== null) {
      esquecer()
      return 'nothing-to-revoke'
    }

    const parar = new AbortController()
    let despertador: ReturnType<typeof setTimeout> | undefined
    const expirar = new Promise<'unreachable'>((resolver) => {
      despertador = setTimeout(() => {
        parar.abort()
        resolver('unreachable')
      }, tetoDaRevogacao)
    })

    try {
      const r = await Promise.race([
        buscar(`${base}${AGORA_ROUTES.session}`, {
          method: 'DELETE',
          headers: cabecalhos(c),
          signal: parar.signal,
          credentials: 'omit',
        }),
        expirar,
      ])
      if (r === 'unreachable') return 'unreachable'
      if (r.status >= 200 && r.status < 300) return 'revoked'
      // A `401` here is the goal reached by another road: some other tab
      // revoked it, or it expired. Reporting it as a failure would send a host
      // looking for a problem that is already solved.
      if (r.status === 401) return 'already-closed'
      return 'refused'
    } catch {
      // Network, DNS, CORS, abort. No branch of this catches a token, and none
      // of them reads the body: an error path is exactly where a token ends up
      // in a log by accident.
      return 'unreachable'
    } finally {
      clearTimeout(despertador)
      esquecer()
    }
  }

  async function supervisionar(): Promise<void> {
    while (!fechado) {
      await abrirStream()
      if (fechado || TERMINAIS.includes(estado)) return
      tentativas += 1
      if (estado === 'live') estado = 'offline'
      anunciar()
      await dormir(recuo())
    }
  }

  return {
    async snapshot(): Promise<AgoraSnapshot> {
      const s = await buscarSnapshot()
      if (s) {
        // Starting the supervisor only after a successful first read keeps a
        // forbidden reader from opening a stream it will never be allowed onto.
        if (!laco && !fechado) laco = supervisionar()
        return s
      }
      if (ultimo) return ultimo
      throw new Error(razao ?? 'sem leitura')
    },

    subscribe(fn): () => void {
      assinantes.add(fn)
      if (ultimo) {
        try {
          fn(ultimo, frescor())
        } catch {
          /* subscriber's problem */
        }
      }
      return () => assinantes.delete(fn)
    },

    freshness: frescor,

    async refresh(): Promise<void> {
      /*
       * The floor is enforced HERE and not only on the server. A tab calling
       * `refresh` in a loop should be stopped by its own client before it costs
       * the service a 429 — the 429 protects the instance, this protects the
       * user from seeing their own tab get throttled.
       */
      if (agora().getTime() - ultimaBusca < minIntervalo) return
      await buscarSnapshot()
    },

    close(): void {
      esquecer()
    },

    revoke(): Promise<RevocationOutcome> {
      revogacao ??= revogar()
      return revogacao
    },
  }
}
