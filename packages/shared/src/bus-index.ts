import * as Y from 'yjs'
import { validMessageShape } from './messages.js'
import type { Msg } from './types.js'

interface BusState {
  entries: Map<string, Msg>
  ids: Map<string, Map<string, Msg>>
  changed: Set<string>
  sizes: Map<string, number>
  bad: Set<string>
  bytes: number
  invalid: number
  addressedCount: number
  addressedBytes: number
}
const empty = (): BusState => ({ entries: new Map(), ids: new Map(), changed: new Set(), sizes: new Map(), bad: new Set(), bytes: 0, invalid: 0, addressedCount: 0, addressedBytes: 0 })

/**
 * Yjs 13.6.32 (package-lock): YArrayEvent.delta/changes walks the whole linked list.
 * Use exported transaction/struct APIs in this module only, to inspect new/deleted clock ranges.
 * Keys are per-value (client:clock), so item splits and cleanup merges cannot invalidate them.
 */
export class BusIndex {
  private state = empty()
  get entries(): Map<string, Msg> { return this.state.entries }
  get ids(): Map<string, Map<string, Msg>> { return this.state.ids }
  get changed(): Set<string> { return this.state.changed }
  get bytes(): number { return this.state.bytes }
  get invalid(): number { return this.state.invalid }
  // Upper bound on bus values trim might move to mail; broadcasts can never move.
  get addressedCount(): number { return this.state.addressedCount }
  get addressedBytes(): number { return this.state.addressedBytes }
  stale = true
  private touched = new Set<string>()
  /** Changed values inspected; instrumentation for deterministic scaling tests. */
  visits = 0
  private readonly encoder = new TextEncoder()
  private readonly observe = (_event: Y.YArrayEvent<Msg>, tx: Y.Transaction) => {
    this.touched = new Set()
    if (this.stale) { this.rebuild(); this.onChange(this.touched, true); return }
    try {
      Y.iterateDeletedStructs(tx, tx.deleteSet, struct => {
        // GC/Skip cannot contain a live indexed value: deletion observers see its Item before GC.
        if (!(struct instanceof Y.Item) || struct.parent !== this.bus || struct.parentSub !== null) return
        for (let i = 0; i < struct.length; i++) this.remove(`${struct.id.client}:${struct.id.clock + i}`)
      })
      for (const [client, end] of tx.afterState) {
        const start = tx.beforeState.get(client) ?? 0
        if (start === end) continue
        const structs = tx.doc.store.clients.get(client)
        if (!structs) throw new Error('missing client range')
        for (let i = Y.findIndexSS(structs, start); i < structs.length; i++) {
          const struct = structs[i]
          if (struct.id.clock >= end) break
          if (!(struct instanceof Y.Item) || struct.parent !== this.bus || struct.parentSub !== null || struct.deleted) continue
          const values = struct.content.getContent()
          for (let offset = Math.max(0, start - struct.id.clock); offset < values.length; offset++)
            this.add(`${client}:${struct.id.clock + offset}`, values[offset] as Msg)
        }
      }
      this.onChange(this.touched)
    } catch {
      // Failed recovery must remain visibly stale, even after malformed values disappear.
      this.rebuild()
      this.onChange(this.touched, true)
    }
  }

  constructor(readonly bus: Y.Array<Msg>, private readonly onChange: (ids: ReadonlySet<string>, rebuilt?: boolean) => void = () => {}) {
    this.rebuild()
    bus.observe(this.observe)
    bus.doc?.on('destroy', () => bus.unobserve(this.observe))
  }

  private add(key: string, m: Msg, state = this.state): void {
    this.visits++
    if (state.entries.has(key)) return
    let size: number, bad = !validMessageShape(m)
    try { size = this.encoder.encode(JSON.stringify(m) ?? 'null').length }
    catch { size = 2 ** 32; bad = true }
    state.entries.set(key, m)
    if (bad) { state.bad.add(key); state.invalid++ }
    state.sizes.set(key, size); state.bytes += size
    if (validMessageShape(m) && m.to) { state.addressedCount++; state.addressedBytes += size }
    const id = (m as { id?: unknown } | null)?.id
    if (typeof id !== 'string') return
    let values = state.ids.get(id)
    if (!values) state.ids.set(id, values = new Map())
    values.set(key, m); state.changed.add(id); this.touched.add(id)
  }

  private remove(key: string): void {
    this.visits++
    if (!this.entries.has(key)) return
    const m = this.entries.get(key)
    this.entries.delete(key)
    if (this.state.bad.delete(key)) this.state.invalid--
    const size = this.state.sizes.get(key) ?? 0
    this.state.bytes -= size; this.state.sizes.delete(key)
    if (validMessageShape(m) && m.to) { this.state.addressedCount--; this.state.addressedBytes -= size }
    const id = (m as { id?: unknown } | null)?.id
    if (typeof id !== 'string') return
    const values = this.ids.get(id)
    values?.delete(key)
    if (!values?.size) { this.ids.delete(id); this.changed.delete(id) }
    else this.changed.add(id)
    this.touched.add(id)
  }

  private recompute(): BusState {
    const next = empty()
    for (const structs of this.bus.doc!.store.clients.values()) for (const struct of structs) {
      if (!(struct instanceof Y.Item) || struct.parent !== this.bus || struct.parentSub !== null || struct.deleted) continue
      const values = struct.content.getContent()
      values.forEach((m, i) => this.add(`${struct.id.client}:${struct.id.clock + i}`, m as Msg, next))
    }
    return next
  }

  rebuild(): void {
    this.stale = true
    try {
      // Build independently: failure cannot publish a healthy-looking partial index.
      this.state = this.recompute()
      this.stale = false
    } catch { /* Keep the previous snapshot, and use legacy admission until recovery succeeds. */ }
  }

  /** Independent full recompute, only for minute maintenance/debug. */
  drift(): string | undefined {
    if (this.stale) return 'bus.stale'
    const next = this.recompute()
    if (next.bytes !== this.bytes) return 'bus.bytes'
    if (next.invalid !== this.invalid || next.bad.size !== this.state.bad.size || [...next.bad].some(key => !this.state.bad.has(key))) return 'bus.invalid'
    if (next.addressedCount !== this.addressedCount || next.addressedBytes !== this.addressedBytes) return 'bus.addressed'
    if (next.entries.size !== this.entries.size || [...next.entries].some(([key, m]) => this.entries.get(key) !== m)) return 'bus.entries'
    if (next.ids.size !== this.ids.size || [...next.ids].some(([id, values]) => {
      const old = this.ids.get(id)
      return old?.size !== values.size || [...values].some(([key, m]) => old.get(key) !== m)
    })) return 'bus.ids'
    if (next.sizes.size !== this.state.sizes.size || [...next.sizes].some(([key, size]) => this.state.sizes.get(key) !== size)) return 'bus.sizes'
    return undefined
  }

  count(id: string): number { return this.ids.get(id)?.size ?? 0 }
  first(id: string): Msg | undefined {
    if (this.stale) return this.bus.toArray().find(m => m?.id === id)
    const values = this.ids.get(id)
    // Order only matters for a duplicate id, an exceptional stale-replica path.
    return values?.size === 1 ? values.values().next().value : values?.size ? this.bus.toArray().find(m => m?.id === id) : undefined
  }
}
