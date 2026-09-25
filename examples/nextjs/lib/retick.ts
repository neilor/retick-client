/**
 * The only file in this app that holds a Retick credential.
 *
 * `rtk_` and `rtl_` are long-lived and scoped to a whole source. Putting either
 * one somewhere a browser can read it hands a visitor write or read access to
 * the project, so both stay here, behind server code. Nothing in this file is
 * prefixed `NEXT_PUBLIC_`, and nothing in it is imported from a client
 * component.
 *
 * Browsers that need live state get an `rtv_` instead: minted per session by
 * your own backend, minutes long, and revocable. See docs/FIRST-USE.md §8 —
 * including the registration that surface needs before it works at all.
 */

import { createConsumer, createProducer, type Fact, type ReadFact } from '@retick/client'

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
const source = () => process.env.RETICK_SOURCE ?? 'orders'

export type Order = {
  /** Your id for this event. It is the deduplication key, so keep it stable. */
  eventId: string
  /**
   * Your numbering, monotonic per source.
   *
   * It comes from the caller because it belongs to your system of record — a
   * database sequence, an outbox row id — and never to this client. A client
   * that generated it would be a second authority over order, and the two would
   * disagree the first time a process restarted.
   */
  sourceVersion: number
  code: string
  title: string
  state: string
}

export async function publishOrder(order: Order) {
  const producer = createProducer({ url: url(), token: required('RETICK_TOKEN') })

  const fact: Fact = {
    eventId: order.eventId,
    source: source(),
    sourceVersion: order.sourceVersion,
    type: 'order.placed',
    // `dispatch` is one of the vocabularies the Agora projection reduces, which
    // is what makes this show up on the Console. An entityType of your own is
    // published, ordered and counted just the same, and rendered nowhere.
    entityType: 'dispatch',
    entityId: order.code,
    occurredAt: new Date().toISOString(),
    payload: { code: order.code, title: order.title, state: order.state },
  }

  const result = await producer.publish([fact])
  return {
    project: result.project,
    status: result.outcomes[0]?.status ?? 'unknown',
    projected: result.outcomes[0]?.projected ?? false,
  }
}

/** The cursor of this app's source. Cursor, never fact content. */
export async function cursor() {
  const producer = createProducer({ url: url(), token: required('RETICK_TOKEN') })
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
 * Reads the project's log back, in `sourceVersion` order.
 *
 * Needs a consumer credential whose type map names the keys you want to see. One
 * issued from the Console has an empty map today and reads nothing — that is
 * docs/FIRST-USE.md §7, and it is why this function returns an empty array
 * instead of throwing when the map is empty.
 */
export async function readOrders(from = 0): Promise<{ facts: ReadFact[]; position: number }> {
  const consumer = createConsumer({ url: url(), token: required('RETICK_READ_TOKEN') })

  const facts: ReadFact[] = []
  const result = await consumer.replay({
    source: source(),
    position: from,
    onFacts: (batch) => {
      facts.push(...batch)
    },
  })

  return { facts, position: result.position }
}
