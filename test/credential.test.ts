/**
 * One credential, and the rule that it never reaches a browser.
 *
 * What this file is really testing is a refusal. `apiKey` in a page is not a
 * warning and not a lint rule — both get ignored — it is a throw at
 * construction, before any request. The tests below take the browser away and
 * put it back, because the only honest way to prove a browser check is to be
 * in one.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProducer } from '../src/producer.ts'
import { createConsumer } from '../src/consumer.ts'
import { createAgoraReader } from '../src/agora.ts'
import { API_KEY_FORMAT, isBrowser, resolveCredential } from '../src/credential.ts'
import { RetickConfigError } from '../src/errors.ts'

const KEY = 'rt_0123456789ab_' + 'a'.repeat(43)
const URL_ = 'https://retick.example'

/** Pretends to be a page, and always puts the global back. */
function inBrowser<T>(body: () => T): T {
  const g = globalThis as { window?: unknown }
  const before = g.window
  const had = 'window' in g
  g.window = { document: {} }
  try {
    return body()
  } finally {
    if (had) g.window = before
    else delete g.window
  }
}

test('the api key format is the one the Console issues', () => {
  assert.ok(API_KEY_FORMAT.test(KEY))
  // The four older families must not match: each has a plane letter, and this
  // one deliberately has none.
  for (const p of ['rtk_', 'rtl_', 'rta_', 'rtv_']) {
    assert.ok(!API_KEY_FORMAT.test(`${p}0123456789ab_${'a'.repeat(43)}`), p)
  }
})

test('a node process is not a browser', () => {
  assert.equal(isBrowser(), false)
  assert.equal(inBrowser(() => isBrowser()), true)
})

test('createProducer takes a single apiKey', () => {
  const p = createProducer({ url: URL_, apiKey: KEY })
  assert.equal(typeof p.publish, 'function')
})

test('createConsumer takes the same apiKey', () => {
  const c = createConsumer({ url: URL_, apiKey: KEY })
  assert.equal(typeof c.pull, 'function')
})

test('createAgoraReader takes the same apiKey, with no session to mint', () => {
  const r = createAgoraReader({ url: URL_, apiKey: KEY })
  assert.equal(typeof r.snapshot, 'function')
  r.close()
})

test('revoke() with an apiKey says there is nothing to revoke, instead of calling a route', async () => {
  /**
   * The DELETE route ends a BROWSER SESSION. An `rt_` has no such row: it is
   * revoked in the Console, by a person. Calling the route would 404, and the
   * 404 would be reported as `unreachable` — which reads like a network
   * problem and would send somebody looking for one.
   *
   * `fetchImpl` throws so that a regression which DOES call the route fails
   * here instead of silently doing the wrong thing against a real service.
   */
  const r = createAgoraReader({
    url: URL_,
    apiKey: KEY,
    fetchImpl: () => {
      throw new Error('revoke() must not reach the network with an API key')
    },
  })
  assert.equal(await r.revoke(), 'nothing-to-revoke')
})

test('an apiKey in a browser throws, and the message names the alternative', () => {
  for (const build of [
    () => createProducer({ url: URL_, apiKey: KEY }),
    () => createConsumer({ url: URL_, apiKey: KEY }),
    () => createAgoraReader({ url: URL_, apiKey: KEY }),
  ]) {
    inBrowser(() => {
      assert.throws(build, (e: unknown) => {
        assert.ok(e instanceof RetickConfigError)
        assert.match(e.message, /browser/)
        return true
      })
    })
  }
})

test('an apiKey passed as token is still refused in a browser', () => {
  /**
   * The browser path exists for `rtv_`, and `token` is the field it uses. An
   * `rt_` smuggled through that field would walk straight past the check the
   * whole module exists for — so the check is on the VALUE, not on the field
   * name, even when the entry point allows browsers.
   */
  inBrowser(() => {
    assert.throws(
      () =>
        resolveCredential(
          { token: KEY },
          { factory: 'x', legacyPrefix: 'rtv_', allowBrowser: true },
        ),
      RetickConfigError,
    )
  })
  // And outside a browser the same call is fine: it is the right credential in
  // the wrong field, which is pedantry to refuse.
  assert.equal(
    resolveCredential({ token: KEY }, { factory: 'x', legacyPrefix: 'rtv_', allowBrowser: true }),
    KEY,
  )
})

test('a session credential still works in a browser', () => {
  // Nothing was taken away: `rtv_` is what a page is supposed to hold, and the
  // reader that holds it is still constructible in one.
  inBrowser(() => {
    const r = createAgoraReader({
      url: URL_,
      credentials: async () => ({ token: `rtv_0123456789ab_${'a'.repeat(43)}`, expiresAt: '2026-12-31T00:00:00.000Z' }),
    })
    assert.equal(typeof r.snapshot, 'function')
    r.close()
  })
})

test('apiKey and token together is a refusal, and not a silent precedence', () => {
  /**
   * Picking one would mean the credential in use is whichever the reader did
   * not expect, and the failure would surface as a scope rejection somewhere
   * else entirely.
   */
  assert.throws(
    () => createProducer({ url: URL_, apiKey: KEY, token: `rtk_0123456789ab_${'a'.repeat(43)}` }),
    (e: unknown) => {
      assert.ok(e instanceof RetickConfigError)
      assert.match(e.message, /not both/)
      return true
    },
  )
})

test('a malformed apiKey is caught here, not as a 401 from the service', () => {
  assert.throws(() => createProducer({ url: URL_, apiKey: 'rt_nope' }), (e: unknown) => {
    assert.ok(e instanceof RetickConfigError)
    // The message says where to get a good one. "malformed" alone sends people
    // looking for a typo when the problem is that they never issued a key.
    assert.match(e.message, /Console/)
    return true
  })
})

test('no credential at all says apiKey, which is what a first-time reader needs', () => {
  assert.throws(() => createProducer({ url: URL_ }), (e: unknown) => {
    assert.ok(e instanceof RetickConfigError)
    assert.match(e.message, /apiKey is required/)
    return true
  })
})

test('the older families keep working, unchanged', () => {
  // Compatibility is the promise in ADR-0019. A key issued before the change
  // needs no edit, and this is the line that would go red if that stopped
  // being true.
  const p = createProducer({ url: URL_, token: `rtk_0123456789ab_${'a'.repeat(43)}` })
  assert.equal(typeof p.publish, 'function')
  const c = createConsumer({ url: URL_, token: `rtl_0123456789ab_${'a'.repeat(43)}` })
  assert.equal(typeof c.pull, 'function')
})
