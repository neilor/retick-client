/**
 * A server component reading the cursor.
 *
 * The credential is read on the server, the rendered page carries numbers and
 * no token, and nothing here becomes a client chunk. That is the whole shape of
 * using `rtk_`/`rtl_` from a Next app: the credential stops at the server
 * boundary, and what crosses it is already data.
 */

import { cursor } from '../lib/retick'

// No caching: a cursor cached for a minute is a cursor that lies for a minute.
export const dynamic = 'force-dynamic'

export default async function Page() {
  let state: Awaited<ReturnType<typeof cursor>> | null = null
  let failure: string | null = null

  try {
    state = await cursor()
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e)
  }

  return (
    <main>
      <h1>Retick · first use</h1>

      {failure ? (
        <p>
          could not read the contract: <code>{failure}</code>
          <br />
          set <code>RETICK_URL</code> and <code>RETICK_TOKEN</code>, then reload. The full list of
          refusals is in <code>docs/TROUBLESHOOTING.md</code>.
        </p>
      ) : (
        <dl>
          <dt>project (tenant key)</dt>
          <dd>
            <code>{state!.project}</code> — an identifier, not a credential
          </dd>
          <dt>source</dt>
          <dd>
            <code>{state!.source}</code>
          </dd>
          <dt>facts</dt>
          <dd>{state!.facts}</dd>
          <dt>contiguous</dt>
          <dd>{state!.contiguous}</dd>
          <dt>gaps</dt>
          <dd>{state!.gaps.length === 0 ? 'none' : state!.gaps.map((g) => `${g.from}–${g.to}`).join(', ')}</dd>
          <dt>durable</dt>
          <dd>{String(state!.durable)}</dd>
        </dl>
      )}

      <h2>publish one</h2>
      <pre>
        {`curl -sS localhost:3000/api/orders \\
  -H 'content-type: application/json' \\
  -d '{"code":"ORD-1","sourceVersion":1,"title":"First order"}'`}
      </pre>
      <p>
        Run it twice. The second run answers <code>duplicate</code>, because the deduplication key
        is <code>(source, tenant, eventId)</code>.
      </p>
    </main>
  )
}
