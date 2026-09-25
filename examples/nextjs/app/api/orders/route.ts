/**
 * POST /api/orders — publishes one fact and answers with what Retick said.
 *
 * A route handler and not a server action, because the caller here is a machine:
 * your own backend, a webhook, a job. Retick's publication route is idempotent
 * on `(source, tenant, eventId)`, so a caller that retries this endpoint after a
 * timeout is safe — which is the property that lets you make it safe at all.
 */

import { RetickAuthError, RetickError } from '@retick/client'
import { publishOrder } from '../../../lib/retick'

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'body must be JSON' }, { status: 400 })
  }

  const o = body as Record<string, unknown>
  if (typeof o.code !== 'string' || typeof o.sourceVersion !== 'number') {
    return Response.json({ error: 'code (string) and sourceVersion (number) are required' }, { status: 400 })
  }

  try {
    const result = await publishOrder({
      eventId: `order-${o.code}`,
      sourceVersion: o.sourceVersion,
      code: o.code,
      title: typeof o.title === 'string' ? o.title : o.code,
      state: typeof o.state === 'string' ? o.state : 'QUEUED',
    })
    // `duplicate` is a success: it means the fact is already in and nothing
    // changed. Answering 409 here would teach every caller to treat a safe
    // retry as a problem.
    return Response.json(result, { status: 200 })
  } catch (e) {
    // The error is safe to log in full: only the non-secret prefix of a
    // credential ever appears in one.
    console.error(e)

    if (e instanceof RetickAuthError) {
      return Response.json({ error: 'retick refused this credential' }, { status: 500 })
    }
    if (e instanceof RetickError) {
      return Response.json({ error: e.name, retryable: e.retryable }, { status: e.retryable ? 503 : 502 })
    }
    return Response.json({ error: 'unexpected' }, { status: 500 })
  }
}
