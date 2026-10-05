/**
 * Ordering that survives a resume: what `consumer.replay()` keeps between calls.
 *
 * A replay that ends with facts held behind a gap, or that resumes into a log
 * whose floor was lowered, needs more than a log position to carry on. 0.2.0
 * resumed from the position after the last fact read and rebuilt its order from
 * the first fact it read on the next call. Both lose facts:
 *
 *  - a fact held behind a gap sits BEFORE that position, so it is never read
 *    again, and once the gap closes nothing delivers it;
 *  - a version below the first one read is taken for a duplicate, so a version
 *    that lowered the source's floor is dropped.
 *
 * `ReplayCheckpoint` carries what a resume needs: where to read from (before
 * the earliest fact not yet released), how far the log was already read, the
 * service's floor the order was built on, and which `sourceVersion` values the
 * reader is done with.
 *
 * A version this credential cannot see (an `entityType` outside its map, or
 * above its sensitivity ceiling) never reaches the client, so it would look
 * like a hole forever. Once a call has read the log to its end, every version
 * up to the service's `contiguous` that was not read is one of those, and it is
 * settled without being delivered. The service's state is the authority on
 * what it applied; the client does not guess.
 * It is per source and per log. It is not an order between sources, and it is
 * not the browser state cursor, which is an opaque digest of a view.
 */

import { RetickConfigError } from './errors.ts'
import type { ReadFact, ReadRange } from './consumer.ts'

/**
 * Where a replay of one source stopped. Plain JSON: persist it as it comes and
 * hand it back as `ReplayOptions.resume`.
 */
export type ReplayCheckpoint = {
  /** The source this checkpoint belongs to. A checkpoint of another source is refused. */
  source: string
  /**
   * Log position to read from: before the earliest fact read and not yet
   * released. Equal to `readTo` when nothing is held.
   */
  position: number
  /**
   * Log position up to which facts were already read. Pages below it only
   * recover held facts and do not count against `maxPages`, so a small
   * `maxPages` still moves forward.
   */
  readTo: number
  /**
   * The service's floor for this source when the order was built: versions at
   * or below it are not part of the sequence. `null` until a page carried the
   * source's state.
   */
  floor: number | null
  /**
   * `sourceVersion` ranges the reader is done with, ascending and disjoint:
   * released to `onFacts`, or applied by the service and invisible to this
   * credential. One range in the usual case; more only while a lowered floor
   * is being filled in.
   */
  settled: ReadRange[]
}

/** The floor moved down while facts above it had already been released. */
export type FloorLowered = { from: number; to: number }

/** Sorts ranges and joins the ones that overlap or touch. */
function merge(ranges: ReadRange[]): ReadRange[] {
  const out: ReadRange[] = []
  for (const r of [...ranges].sort((a, b) => a.from - b.from)) {
    const last = out[out.length - 1]
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to)
    else out.push({ from: r.from, to: r.to })
  }
  return out
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

/** Refuses a checkpoint that was not produced by `replay()` for this source. */
export function checkCheckpoint(c: unknown, source: string): ReplayCheckpoint {
  const bad = (why: string): never => {
    throw new RetickConfigError(`resume is not a replay checkpoint: ${why}`)
  }
  if (typeof c !== 'object' || c === null) return bad('not an object')
  const cp = c as Partial<ReplayCheckpoint>
  if (cp.source !== source) bad(`it belongs to source ${JSON.stringify(cp.source)}, not ${JSON.stringify(source)}`)
  if (!isCount(cp.position)) bad('position must be a non-negative integer')
  if (!isCount(cp.readTo) || (cp.readTo as number) < (cp.position as number)) bad('readTo must be an integer at or after position')
  if (cp.floor !== null && !isCount(cp.floor)) bad('floor must be null or a non-negative integer')
  if (!Array.isArray(cp.settled)) return bad('settled must be an array')
  if (cp.floor === null && cp.settled.length > 0) bad('settled ranges without a floor')
  let previous = -1
  for (const r of cp.settled) {
    if (typeof r !== 'object' || r === null || !isCount(r.from) || !isCount(r.to) || r.from > r.to) {
      bad('each settled range needs integers from <= to')
    }
    if (r.from <= previous + 1) bad('settled ranges must be ascending, disjoint and not adjacent')
    if (typeof cp.floor === 'number' && r.from <= cp.floor) bad('a settled range starts at or below the floor')
    previous = r.to
  }
  return {
    source,
    position: cp.position as number,
    readTo: cp.readTo as number,
    floor: (cp.floor ?? null) as number | null,
    settled: cp.settled.map((r) => ({ from: r.from, to: r.to })),
  }
}

/**
 * Releases facts in `sourceVersion` order and remembers enough to resume.
 *
 * A version is released when the one before it was settled, or when it sits
 * right above the floor. When the floor moves down, the versions between the
 * new floor and the old one become releasable from the bottom up, after the
 * versions above the old floor that were already released: that order cannot
 * be undone once they were handed over, and it is reported as `floorLowered`.
 *
 * The first copy of a version in the log wins, as it does in the service. A
 * later copy of a held version is ignored, not swapped in.
 */
export class ResumableOrder {
  readonly #source: string
  #floor: number | null
  #settled: ReadRange[]
  readonly #held = new Map<number, ReadFact>()
  /** 0.2.0 rule: no state, no checkpoint, take the floor from the first fact read. */
  readonly #floorFromFirstFact: boolean
  #lowered: FloorLowered | null = null

  constructor(source: string, from: ReplayCheckpoint | null, options: { floorFromFirstFact?: boolean } = {}) {
    this.#source = source
    this.#floor = from?.floor ?? null
    this.#settled = from ? from.settled.map((r) => ({ ...r })) : []
    this.#floorFromFirstFact = options.floorFromFirstFact ?? false
  }

  get held(): number {
    return this.#held.size
  }

  get floorLowered(): FloorLowered | null {
    return this.#lowered
  }

  /** The service's current floor for this source, from a page's `state.floor`. */
  observeFloor(serviceFloor: number | null | undefined): void {
    if (this.#floorFromFirstFact || serviceFloor === null || serviceFloor === undefined) return
    if (this.#floor === null) {
      this.#floor = serviceFloor
      return
    }
    // The service only ever lowers a floor (a `floor` log entry); it never
    // raises one. A higher value here would mean another log, which the
    // position check in `replay()` reports instead.
    if (serviceFloor >= this.#floor) return
    if (this.#settled.length > 0) {
      this.#lowered = { from: this.#lowered?.from ?? this.#floor, to: serviceFloor }
    }
    this.#floor = serviceFloor
  }

  #isSettled(v: number): boolean {
    for (const r of this.#settled) {
      if (v < r.from) return false
      if (v <= r.to) return true
    }
    return false
  }

  #markSettled(v: number): void {
    const rs = this.#settled
    let i = 0
    while (i < rs.length && (rs[i] as ReadRange).to < v - 1) i++
    const at = rs[i]
    if (at && at.to === v - 1) {
      at.to = v
      const next = rs[i + 1]
      if (next && next.from === v + 1) {
        at.to = next.to
        rs.splice(i + 1, 1)
      }
    } else if (at && at.from === v + 1) {
      at.from = v
    } else {
      rs.splice(i, 0, { from: v, to: v })
    }
  }

  /** Feeds log-ordered facts; returns those ready to apply, in `sourceVersion` order. */
  offer(facts: ReadFact[]): ReadFact[] {
    for (const f of facts) {
      if (this.#floor === null) {
        // No page carried the source's state. Fall back to the 0.2.0 rule
        // rather than holding everything against a floor nobody stated.
        this.#floor = f.sourceVersion - 1
      }
      const v = f.sourceVersion
      if (v <= this.#floor) continue
      if (this.#isSettled(v)) continue
      if (!this.#held.has(v)) this.#held.set(v, f)
    }
    return this.#release()
  }

  /**
   * Called once the log was read to its end, with the `contiguous` of the same
   * response. Every version up to it that this reader neither settled nor
   * holds was applied by the service and withheld from this credential:
   * settle it, and release what it was blocking.
   */
  settleUnseen(serviceContiguous: number | null | undefined): ReadFact[] {
    const floor = this.#floor
    if (floor === null || serviceContiguous === null || serviceContiguous === undefined) return []
    // Whole ranges at a time: a source whose facts are all withheld can be
    // long, and walking it one version at a time would be wasted work.
    const add: ReadRange[] = []
    const held = [...this.#held.keys()].sort((a, b) => a - b)
    let from = floor + 1
    const close = (to: number) => {
      for (const h of held) {
        if (h < from || h > to) continue
        if (h > from) add.push({ from, to: h - 1 })
        from = h + 1
      }
      if (from <= to) add.push({ from, to })
    }
    for (const r of this.#settled) {
      if (r.from > serviceContiguous) break
      if (r.from > from) close(r.from - 1)
      from = Math.max(from, r.to + 1)
    }
    if (from <= serviceContiguous) close(serviceContiguous)
    if (add.length > 0) this.#settled = merge([...this.#settled, ...add])
    return this.#release()
  }

  #release(): ReadFact[] {
    const ready: ReadFact[] = []
    const floor = this.#floor
    if (floor === null) return ready
    for (const v of [...this.#held.keys()].sort((a, b) => a - b)) {
      if (v !== floor + 1 && !this.#isSettled(v - 1)) continue
      ready.push(this.#held.get(v) as ReadFact)
      this.#held.delete(v)
      this.#markSettled(v)
    }
    return ready
  }

  /** Where to resume, given the position after the last fact read. */
  checkpoint(readTo: number): ReplayCheckpoint {
    let position = readTo
    for (const f of this.#held.values()) position = Math.min(position, f.position - 1)
    return {
      source: this.#source,
      position,
      readTo,
      floor: this.#floor,
      settled: this.#settled.map((r) => ({ ...r })),
    }
  }
}
