/**
 * A client for the Retick CONTROL PLANE, `/api/plano/v1`.
 *
 * This package already spoke the two data-plane ports: `createProducer` writes
 * facts to `/api/v1` and `createConsumer` reads them back from
 * `/api/leitura/v1`. This is the third one, and it is the only one that talks
 * about workspaces, projects, environments and keys rather than about facts.
 *
 * WHY IT LIVES HERE AND NOT IN THE CLI.
 *
 * The CLI and the MCP server are two different front ends for the same three
 * ports. A control-plane client written inside the CLI would be copied into the
 * MCP server within a week, and the copy that nobody remembers to update is
 * always the one the machine uses. `docs/IDENTIDADE-E-ACESSO.md` section 6
 * makes the same argument about the capability matrix; this is that argument
 * applied to the wire.
 *
 * WHAT IT REFUSES TO DO.
 *
 * It has no method that issues or rotates an API key, because the port has no
 * such route, and it has none that reads a secret back, because no route
 * returns one. The single response that ever carries a secret — issuing a data
 * credential — names it `secretShownOnce` so that a caller storing it in a
 * variable called `credential` has to read the name first.
 *
 * It does not log. Not a debug flag, not an opt-in: a client that can print a
 * request prints an `Authorization` header the day someone turns it on to
 * debug something else.
 */

import {
  RetickAuthError,
  RetickConfigError,
  RetickError,
  RetickHttpError,
  RetickNetworkError,
  RetickRequestError,
  RetickServerError,
  RetickTimeoutError,
} from './errors.ts'

/** Version of the control contract this client was written against. */
export const CONTROL_VERSION = 1

/**
 * The server speaks a version of the control contract this client does not.
 *
 * Its own class, and never retryable. A version mismatch does not get better
 * by trying again, and the instruction that fixes it — upgrade one of the two
 * sides — is nothing like the instruction for a `503`. Collapsing the two into
 * a generic HTTP error is how a CI ends up retrying an incompatible deploy
 * until the timeout.
 */
export class RetickContractError extends RetickError {
  readonly expected: number
  readonly found: number
  readonly url: string

  constructor(expected: number, found: number, url: string) {
    super(
      `contrato incompativel em ${url}: este cliente fala ${expected}, o servidor fala ${found}`,
      { retryable: false },
    )
    this.expected = expected
    this.found = found
    this.url = url
  }
}

/** Base path of the control plane. Independent of the other two ports. */
export const CONTROL_BASE = '/api/plano/v1'

export const CONTROL_ROUTES = {
  whoAmI: '/quem-sou',
  workspaces: '/workspaces',
  projects: '/projetos',
  keys: '/chaves',
  /**
   * The `rt_` family, under the project that owns it. Mirrors the Console,
   * whose own route for this family is `/projeto/<id>/chaves` — one path
   * shape, not two names for the same thing.
   */
  projectKeys: (projectId: string) => `/projetos/${encodeURIComponent(projectId)}/chaves`,
} as const

/**
 * The two families this port accepts, and why there are two.
 *
 * `rta_` is the control-plane key the port was built for. `rt_` is the single
 * credential the Console emits, and it reaches this port when its scope carries
 * the `project:admin` operation — `src/plano/api.ts` routes both through the
 * same `resolver`, choosing by FORMAT before conferring anything.
 *
 * Ordered longest-first so that a `startsWith` scan never reports `rta_` as
 * `rt_`. The two are disjoint anyway — `'rta_'.startsWith('rt_')` is false,
 * because the underscore does not match `a` — but the order removes the need to
 * know that to read the loop.
 */
export const CONTROL_KEY_PREFIXES = ['rta_', 'rt_'] as const
export type ControlKeyFamily = (typeof CONTROL_KEY_PREFIXES)[number]

/**
 * Prefix of the legacy control-plane key.
 *
 * Kept because it was exported before `rt_` existed and removing an export is
 * a breaking change for anyone who imported it. `CONTROL_KEY_PREFIXES` is what
 * new code should read: this constant names ONE of the two families and a check
 * written against it alone rejects the only key a Console user can emit.
 *
 * @deprecated prefer `CONTROL_KEY_PREFIXES` or `controlKeyFamily`.
 */
export const CONTROL_KEY_PREFIX = 'rta_'

/** Which family a token belongs to, by format, or `null` for neither. */
export function controlKeyFamily(token: string): ControlKeyFamily | null {
  for (const p of CONTROL_KEY_PREFIXES) if (token.startsWith(p)) return p
  return null
}

export type Capability = string

/** One of the four operations a `rt_` scope can carry. Closed list, server-side. */
export type Operation = 'facts:publish' | 'log:read' | 'state:read' | 'project:admin'

export type WhoAmI = {
  versao: number
  prefixo: string
  workspaceId: string
  projetoId: string | null
  ambienteChave: string | null
  capacidades: Capability[]
  /**
   * Which family answered. Optional because a server older than the `rt_`
   * family does not send it, and a client that demanded it would refuse a
   * deployment that works.
   */
  familia?: ControlKeyFamily
  /**
   * The operations of a `rt_` scope, or absent for `rta_`, which has no such
   * axis. This is the field a CI wants: for a `rt_`, `capacidades` carries the
   * MATERIALIZED `restricoes.recursos`, and a key that reached this port at all
   * already had `project:admin` — so the capability list alone never says
   * whether the same key can also publish or read the log.
   */
  operacoes?: Operation[]
}

export type Workspace = {
  id: string
  slug: string
  nome: string
  criadoEm: string
  criadoPor: string
}

export type Project = {
  id: string
  workspaceId: string
  slug: string
  nome: string
  chaveDeTenant: string
  criadoEm: string
  criadoPor: string
  arquivadoEm: string | null
}

export type Environment = {
  id: string
  projetoId: string
  nome: string
  chaveDeTenant: string
  padrao: boolean
  criadoEm: string
  criadoPor: string
}

export type Source = { id: string; projetoId: string; nome: string; descricao: string }

export type ApiKeyMetadata = {
  id: string
  workspaceId: string
  projetoId: string | null
  ambienteChave: string | null
  nome: string
  prefixo: string
  capacidades: Capability[]
  criadoEm: string
  criadoPor: string
  expiraEm: string | null
  revogadoEm: string | null
  revogadoPor: string | null
  ultimoUsoEm: string | null
  sucessoraDe: string | null
}

/**
 * Metadata of a `rt_` credential. A different shape from `ApiKeyMetadata`, and
 * the difference is the point.
 *
 * `operacoes` is the closed list of what it may do, and `restricoes` narrows it
 * within those. `null` in any axis of `restricoes` means NO restriction there
 * and not an empty one — the distinction is the whole reason this family
 * exists, and a client that collapsed the two into `[]` would report a key that
 * reads everything as a key that reads nothing.
 *
 * No hash, no secret, no verifier: the route returns metadata only.
 */
export type ProjectKeyMetadata = {
  id: string
  workspaceId: string
  projetoId: string
  /** The tenant key. It is what isolates, and it never comes from a request. */
  projetoChave: string
  nome: string
  prefixo: string
  operacoes: Operation[]
  restricoes: {
    fontes: string[] | null
    tipos: Record<string, string[]> | null
    projecoes: string[] | null
    recursos: Capability[] | null
  }
  criadoEm: string
  criadoPor: string
  expiraEm: string | null
  revogadoEm: string | null
  revogadoPor: string | null
  ultimoUsoEm: string | null
  sucessoraDe: string | null
}

export type ApiKeyEvent = {
  prefixo: string
  acao: 'emitida' | 'rotacionada' | 'revogada' | 'usada' | 'recusada'
  em: string
  ator: string | null
  recusa?: string
}

export type DataCredentialMetadata = {
  id: string
  projetoId: string
  nome: string
  prefixo: string
  tipo: string
  expiraEm: string | null
  revogadoEm: string | null
}

export type IssuedDataCredential = {
  credential: DataCredentialMetadata
  /**
   * The only secret this client ever receives. It is not stored, not cached
   * and not returned by any other call — the port has no route that reads it
   * back.
   */
  secretShownOnce: string
}

export type Usage = Record<string, unknown>

export type ControlPlaneOptions = {
  /** Origin of the service, e.g. `https://retick.example`. No trailing path. */
  url: string
  /** An `rta_` or `rt_` key. Never logged, never placed in a URL. */
  token: string
  /** Defaults to `/api/plano/v1`. */
  base?: string
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

export type ControlPlane = {
  whoAmI(): Promise<WhoAmI>
  workspaces(): Promise<Workspace[]>
  workspace(id: string): Promise<Workspace>
  projects(): Promise<Project[]>
  project(id: string): Promise<Project>
  environments(projectId: string): Promise<Environment[]>
  sources(projectId: string): Promise<Source[]>
  usage(projectId: string): Promise<Usage>
  keys(): Promise<ApiKeyMetadata[]>
  keyTrail(keyId: string): Promise<ApiKeyEvent[]>
  revokeKey(keyId: string): Promise<ApiKeyMetadata>
  /**
   * The `rt_` credentials of ONE project.
   *
   * Separate from `keys()` and not a filter over it. The two lists come from
   * different tables, are authorized against different targets with different
   * capabilities — `chave.listar` over the workspace against
   * `credencial.listar` over the project — and a single method would have to
   * pick one of the two, silently, for the caller.
   */
  projectKeys(projectId: string): Promise<ProjectKeyMetadata[]>
  projectKeyTrail(projectId: string, keyId: string): Promise<ApiKeyEvent[]>
  revokeProjectKey(projectId: string, keyId: string): Promise<ProjectKeyMetadata>
  dataCredentials(projectId: string): Promise<DataCredentialMetadata[]>
  issueDataCredential(
    projectId: string,
    spec: {
      type: 'produtor' | 'consumidor'
      name: string
      sources: string[]
      types?: Record<string, string[]>
      expiresAt?: string | null
    },
  ): Promise<IssuedDataCredential>
  revokeDataCredential(projectId: string, credentialId: string): Promise<DataCredentialMetadata>
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Turns a refusal into a typed error.
 *
 * The control plane answers a refusal with `{ erro: <closed list> }`, and the
 * list matters to whoever is on call: `expirada` means rotate, `revogada`
 * means someone cut it on purpose, and `sem_capacidade` means the key was
 * issued too narrow. Collapsing the three into "unauthorized" sends the person
 * looking in the wrong place.
 */
function refusalToError(
  status: number,
  body: unknown,
  url: string,
  tokenPrefix: string,
): RetickHttpError {
  const code =
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { erro?: unknown }).erro === 'string'
      ? (body as { erro: string }).erro
      : undefined

  const info = { status, url, body, tokenPrefix, ...(code ? { code } : {}) }
  const message = `${url}: ${code ?? String(status)}`

  if (status === 401 || status === 403) return new RetickAuthError(message, info)
  /**
   * `5xx` is retryable and `4xx` is not, and the split is the whole point of
   * having two classes: a CI that retries a `403` burns its own audit trail
   * with refusals, and one that gives up on a `503` fails a deploy over a
   * restart.
   */
  if (status >= 500) return new RetickServerError(message, { ...info, retryable: true })
  return new RetickRequestError(message, info)
}

/**
 * The non-secret head of a token, for error reporting.
 *
 * The family prefix plus 12 hex is what the vault stores in the clear and what
 * the audit trail already prints. Taking a fixed 16 characters of an arbitrary
 * string would take 16 characters of the SECRET if the token were malformed, so
 * the shape is matched instead of sliced.
 *
 * `rt[a-z]?` and not the enumerated list: it also covers the letterless `rt_`,
 * and a version of this that named the live families left the newest one being
 * reported as `rta_?` while its 12 hex — the only thing that says WHICH key
 * failed — were dropped.
 */
function safePrefix(token: string): string {
  const m = /^(rt[a-z]?_[0-9a-f]{12})/.exec(token)
  return m ? (m[1] as string) : 'rt?_?'
}

export function createControlPlane(options: ControlPlaneOptions): ControlPlane {
  const url = (options.url ?? '').trim().replace(/\/+$/, '')
  if (!url) throw new RetickConfigError('url e obrigatoria')

  const token = (options.token ?? '').trim()
  if (!token) throw new RetickConfigError('token e obrigatorio')
  /**
   * The format check happens here, not only at the server.
   *
   * A producer token pasted into a CI variable named `RETICK_API_KEY` would
   * otherwise travel over the wire before being refused, and a token that
   * travels is a token that can end up in somebody's proxy log. The vault on
   * the other side refuses it by format too; this one refuses it earlier.
   */
  const family = controlKeyFamily(token)
  if (!family) {
    throw new RetickConfigError(
      `chave de control plane comeca com ${CONTROL_KEY_PREFIXES.join(' ou ')}; a que veio nao comeca`,
    )
  }

  const base = (options.base ?? CONTROL_BASE).replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const doFetch = options.fetch ?? globalThis.fetch
  const tokenPrefix = safePrefix(token)

  async function call<T>(route: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const alvo = `${url}${base}${route}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await doFetch(alvo, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      })
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new RetickTimeoutError({ url: alvo, timeoutMs, cause })
      }
      /**
       * Server unreachable is its own error, and that is not pedantry: a CI
       * that cannot tell "the key is bad" from "the host is down" retries the
       * wrong one, and retrying a bad key is how a key gets locked out.
       */
      throw new RetickNetworkError(`servidor inalcancavel: ${alvo}`, { url: alvo, cause })
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text()
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text) as unknown
      } catch {
        throw new RetickHttpError(`${alvo}: resposta nao era JSON`, {
          status: response.status,
          url: alvo,
          body: null,
          tokenPrefix,
        })
      }
    }

    if (!response.ok) throw refusalToError(response.status, body, alvo, tokenPrefix)
    return body as T
  }

  return {
    async whoAmI() {
      const r = await call<WhoAmI>(CONTROL_ROUTES.whoAmI)
      /**
       * The contract version is checked here, once, on the call every client
       * makes first. A client that only discovers an incompatible server when
       * a field is missing three calls later reports the wrong failure.
       */
      if (typeof r.versao === 'number' && r.versao !== CONTROL_VERSION) {
        throw new RetickContractError(CONTROL_VERSION, r.versao, `${url}${base}`)
      }
      return r
    },
    async workspaces() {
      return (await call<{ workspaces: Workspace[] }>(CONTROL_ROUTES.workspaces)).workspaces
    },
    async workspace(id) {
      return call<Workspace>(`${CONTROL_ROUTES.workspaces}/${encodeURIComponent(id)}`)
    },
    async projects() {
      return (await call<{ projetos: Project[] }>(CONTROL_ROUTES.projects)).projetos
    },
    async project(id) {
      return call<Project>(`${CONTROL_ROUTES.projects}/${encodeURIComponent(id)}`)
    },
    async environments(projectId) {
      const r = await call<{ ambientes: Environment[] }>(
        `${CONTROL_ROUTES.projects}/${encodeURIComponent(projectId)}/ambientes`,
      )
      return r.ambientes
    },
    async sources(projectId) {
      const r = await call<{ fontes: Source[] }>(
        `${CONTROL_ROUTES.projects}/${encodeURIComponent(projectId)}/fontes`,
      )
      return r.fontes
    },
    async usage(projectId) {
      return call<Usage>(`${CONTROL_ROUTES.projects}/${encodeURIComponent(projectId)}/uso`)
    },
    async keys() {
      return (await call<{ chaves: ApiKeyMetadata[] }>(CONTROL_ROUTES.keys)).chaves
    },
    async keyTrail(keyId) {
      const r = await call<{ trilha: ApiKeyEvent[] }>(
        `${CONTROL_ROUTES.keys}/${encodeURIComponent(keyId)}/trilha`,
      )
      return r.trilha
    },
    async revokeKey(keyId) {
      const r = await call<{ chave: ApiKeyMetadata }>(
        `${CONTROL_ROUTES.keys}/${encodeURIComponent(keyId)}/revogar`,
        { method: 'POST', body: {} },
      )
      return r.chave
    },
    async projectKeys(projectId) {
      const r = await call<{ chaves: ProjectKeyMetadata[] }>(CONTROL_ROUTES.projectKeys(projectId))
      return r.chaves
    },
    async projectKeyTrail(projectId, keyId) {
      const r = await call<{ trilha: ApiKeyEvent[] }>(
        `${CONTROL_ROUTES.projectKeys(projectId)}/${encodeURIComponent(keyId)}/trilha`,
      )
      return r.trilha
    },
    async revokeProjectKey(projectId, keyId) {
      const r = await call<{ chave: ProjectKeyMetadata }>(
        `${CONTROL_ROUTES.projectKeys(projectId)}/${encodeURIComponent(keyId)}/revogar`,
        { method: 'POST', body: {} },
      )
      return r.chave
    },
    async dataCredentials(projectId) {
      const r = await call<{ credenciais: DataCredentialMetadata[] }>(
        `${CONTROL_ROUTES.projects}/${encodeURIComponent(projectId)}/credenciais`,
      )
      return r.credenciais
    },
    async issueDataCredential(projectId, spec) {
      const r = await call<{ credencial: DataCredentialMetadata; tokenMostradoUmaVez: string }>(
        `${CONTROL_ROUTES.projects}/${encodeURIComponent(projectId)}/credenciais`,
        {
          method: 'POST',
          body: {
            tipo: spec.type,
            nome: spec.name,
            fontes: spec.sources,
            ...(spec.types ? { tipos: spec.types } : {}),
            expiraEm: spec.expiresAt ?? null,
          },
        },
      )
      return { credential: r.credencial, secretShownOnce: r.tokenMostradoUmaVez }
    },
    async revokeDataCredential(projectId, credentialId) {
      const r = await call<{ credencial: DataCredentialMetadata }>(
        `${CONTROL_ROUTES.projects}/${encodeURIComponent(projectId)}/credenciais/${encodeURIComponent(credentialId)}/revogar`,
        { method: 'POST', body: {} },
      )
      return r.credencial
    },
  }
}
