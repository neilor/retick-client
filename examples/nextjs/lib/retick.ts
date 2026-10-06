/**
 * The only file in this app that holds a Retick credential.
 *
 * An `rt_` key is long-lived and reaches the whole project (or the sources it
 * was restricted to). Putting it somewhere a browser can read it hands a visitor
 * whatever the key can do, so it stays here, behind server code. Nothing in this
 * file is prefixed `NEXT_PUBLIC_`, and nothing in it is imported from a client
 * component. The client also refuses `apiKey` when it runs in a browser.
 *
 * Browsers that need live state read it with `createStateReader`, through a
 * short credential your backend obtains per session. See docs/BROWSER.md,
 * including the registration that path needs before it works at all.
 */

import { createConsumer, createProducer, type Fact, type ReadFact, type ReplayCheckpoint } from '@retick/client'

// A guard, not a belt: if a bundler ever pulls this into a client chunk, the
// failure should be loud here rather than quiet in someone's devtools.
if (typeof window !== 'undefined') {
  throw new Error('lib/retick.ts is server-only and was loaded in a browser')
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

const url = () => required('RETICK_URL') // base URL, no /api/... suffix
const apiKey = () => required('RETICK_API_KEY') // rt_…, server only
const source = () => process.env.RETICK_SOURCE ?? 'orders'

export type Order = {
  /** Your id for this event. It is the deduplication key, so keep it stable. */
  eventId: string
  /**
   * Your numbering, one sequence per source.
   *
   * It comes from the caller because it belongs to your system of record (a
   * database sequence, an outbox row id) and never to this client. A client
   * that generated it would be a second authority over order, and the two would
   * disagree the first time a process restarted. docs/PRODUCERS.md has the
   * rules when several instances publish to one source.
   */
  sourceVersion: number
  code: string
  title: string
  state: string
}

export async function publishOrder(order: Order) {
  const producer = createProducer({ url: url(), apiKey: apiKey() })

  const fact: Fact = {
    eventId: order.eventId,
    source: source(),
    sourceVersion: order.sourceVersion,
    type: 'order.placed',
    // Any entityType of your own. The Console's Studio draws every type.
    entityType: 'order',
    entityId: order.code,
    occurredAt: new Date().toISOString(),
    payload: { code: order.code, title: order.title, state: order.state },
  }

  const result = await producer.publish([fact])
  return {
    project: result.project,
    status: result.outcomes[0]?.status ?? 'unknown',
  }
}

/** The cursor of this app's source. Cursor, never fact content. */
export async function cursor() {
  const producer = createProducer({ url: url(), apiKey: apiKey() })
  const contract = await producer.contract()
  const state = contract.sources.find((s) => s.source === source())
  return {
    project: contract.scope.project,
    source: source(),
    contiguous: state?.contiguous ?? 0,
    facts: state?.facts ?? 0,
    gaps: state?.gaps ?? [],
    durable: contract.durability.durable,
  }
}

/**
 * Reads the source back, in `sourceVersion` order.
 *
 * Needs the key to carry `log:read`. Pass the `resume` this returned last time
 * to read only what is new; store it with whatever you built from the facts.
 * Do not resume from a position: that loses facts held behind a gap.
 */
export async function readOrders(
  resume?: ReplayCheckpoint,
): Promise<{ facts: ReadFact[]; resume: ReplayCheckpoint }> {
  const consumer = createConsumer({ url: url(), apiKey: apiKey() })

  const facts: ReadFact[] = []
  const result = await consumer.replay({
    source: source(),
    resume,
    onFacts: (batch) => {
      facts.push(...batch)
    },
  })

  return { facts, resume: result.resume }
}
