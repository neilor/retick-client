/**
 * One credential for every entry point, and the rule that it never reaches a
 * browser.
 *
 * WHY THIS MODULE EXISTS.
 *
 * Until now each factory took its own `token`, and which prefix it wanted was
 * something you found out from a rejection: `createProducer` wanted `rtk_`,
 * `createConsumer` wanted `rtl_`, `createAgora` wanted `rtv_`. Three names for
 * the same field, three vaults, and no single place that issued them — the
 * Console could not mint the one that actually worked.
 *
 * Retick now issues ONE credential, `rt_`, whose scope is chosen when you
 * create it. So the SDK takes one field, `apiKey`, and every factory accepts
 * it. `token` still works and is still documented, because keys issued before
 * this change are still valid and nothing should break for them.
 *
 * THE BROWSER RULE, AND WHY IT IS ENFORCED HERE AND NOT IN A DOC.
 *
 * An `rt_` is a server credential. Its scope can include publishing and
 * administering the project, it does not expire when a tab closes, and
 * revoking it is a deliberate act by a human in the Console. Shipping one to a
 * browser puts it in a bundle, in a source map, and in the memory of every
 * visitor — and no amount of documentation has ever stopped that from
 * happening to somebody.
 *
 * So it throws. Not a warning, which gets filtered; not a lint rule, which
 * gets disabled. `RetickConfigError` at construction time, before the first
 * request, with the alternative named in the message.
 *
 * The browser path is not being taken away: `createAgoraReader` still accepts an
 * `rtv_`, which is issued per browser session, dies at logout, and reads only
 * the compact projection. That is the credential a browser is supposed to
 * hold, and this check exists to keep it that way.
 */

import { RetickConfigError } from './errors.ts'

/** `rt_<12 hex>_<secret>`. The single configurable credential. */
export const API_KEY_FORMAT = /^rt_[0-9a-f]{12}_[A-Za-z0-9_-]{20,}$/

/**
 * Whether this code is running in something that can show a page.
 *
 * Both checks, and not just `window`: some server runtimes define a `window`
 * global for compatibility, and a `document` on top of it is what actually
 * distinguishes a page from a process. A false positive here would refuse a
 * legitimate server; a false negative would leak a key, so the shape of the
 * test matters more than its length.
 */
export function isBrowser(): boolean {
  return (
    typeof globalThis === 'object' &&
    typeof (globalThis as { window?: unknown }).window !== 'undefined' &&
    typeof (globalThis as { window?: { document?: unknown } }).window?.document !== 'undefined'
  )
}

export type CredentialOptions = {
  /**
   * The single Retick API key, `rt_...`. Server-side only.
   *
   * Issued in the Console, on the project page, with the scopes you pick.
   * Throws if constructed in a browser — see the note at the top of this file.
   */
  apiKey?: string
  /**
   * A credential from one of the older families: `rtk_`, `rtl_` or `rtv_`.
   *
   * Still accepted, still supported, and the only way to hold a credential in
   * a browser (`rtv_`, from {@link createStateReader}). Keys issued before the
   * single-credential change keep working with no edit.
   */
  token?: string
}

/**
 * Picks the credential to send, and refuses the combinations that are a bug.
 *
 * `allowBrowser` says whether THIS entry point may run in a page at all. It is
 * about the legacy `token`: `createAgoraReader` may (that is the `rtv_` path), and
 * the other two may not. `apiKey` is refused in a browser regardless of it —
 * there is no entry point for which shipping an `rt_` to a page is correct.
 */
export function resolveCredential(
  options: CredentialOptions,
  where: { factory: string; legacyPrefix: string; allowBrowser: boolean },
): string {
  const apiKey = (options.apiKey ?? '').trim()
  const token = (options.token ?? '').trim()

  if (apiKey !== '' && token !== '') {
    // Not a silent precedence. Picking one would mean the credential in use is
    // whichever the reader did not expect, and the failure would show up as a
    // scope rejection somewhere else entirely.
    throw new RetickConfigError(
      `${where.factory}: pass either apiKey or token, not both — they are different credentials`,
    )
  }

  if (apiKey !== '') {
    if (isBrowser()) {
      throw new RetickConfigError(
        'apiKey is a server credential and must not run in a browser. ' +
          'It can carry publish and admin scope, it does not expire with the tab, ' +
          'and a bundle keeps it forever. For a browser, issue a session credential ' +
          'and use createStateReader with credentials that ask your backend for a session (rtv_).',
      )
    }
    if (!API_KEY_FORMAT.test(apiKey)) {
      throw new RetickConfigError(
        `${where.factory}: apiKey must look like rt_<12 hex>_<secret>; ` +
          'issue one in the Console, on the project page',
      )
    }
    return apiKey
  }

  if (token === '') {
    throw new RetickConfigError(`${where.factory}: apiKey is required`)
  }

  if (API_KEY_FORMAT.test(token)) {
    /**
     * An `rt_` passed as `token` is accepted, and named.
     *
     * Refusing it would be pedantry — it is the right credential in the wrong
     * field — but accepting it in silence would leave the browser check
     * unreachable, because `token` is what the browser path allows. So: reject
     * in a page, accept elsewhere.
     */
    if (isBrowser()) {
      throw new RetickConfigError(
        'this is an rt_ API key, which must not run in a browser. ' +
          'For a browser, issue a session credential and pass it as token.',
      )
    }
    return token
  }

  if (!where.allowBrowser && isBrowser()) {
    throw new RetickConfigError(
      `${where.factory} holds a credential that writes or reads the raw log, ` +
        'and it must not run in a browser. Use createStateReader with a browser session instead.',
    )
  }

  return token
}
