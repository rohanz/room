import * as Y from 'yjs'
import { validMessageShape } from './messages.js'
import type { Msg } from './types.js'

/**
 * Yjs 13.6.32 (package-lock): YArrayEvent.delta/changes walks the whole linked list.
 * Use exported transaction/struct APIs in this module only, to inspect new/deleted clock ranges.
 * Keys are per-value (client:clock), so item splits and cleanup merges cannot invalidate them.
 */
export class BusIndex {
  readonly entries = new Map<string, Msg>()
  readonly ids = new Map<string, Map<string, Msg>>()
  readonly changed = new Set<string>()
  bytes = 0
  invalid = 0
  private touched = new Set<string>()
  /** Changed values inspected; instrumentation for deterministic scaling tests. */
  visits = 0
  private readonly sizes = new Map<string, number>()
  private readonly encoder = new TextEncoder()
  private readonly observe = (_event: Y.YArrayEvent<Msg>, tx: Y.Transaction) => {
    this.touched = new Set()
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
          // Nested Y types are ordinary content too; retain them as invalid until trim removes them.
          const values = struct.content.getContent()
          for (let offset = Math.max(0, start - struct.id.clock); offset < values.length; offset++) {
            this.add(`${client}:${struct.id.clock + offset}`, values[offset] as Msg)
          }
        }
      }
      this.onChange(this.touched)
    } catch {
      // A genuine range inconsistency must never corrupt delivery counts.
      this.rebuild()
      this.onChange(this.touched, true)
    }
  }

  constructor(readonly bus: Y.Array<Msg>, private readonly onChange: (ids: ReadonlySet<string>, rebuilt?: boolean) => void = () => {}) {
    this.rebuild()
    bus.observe(this.observe)
    bus.doc?.on('destroy', () => bus.unobserve(this.observe))
  }

  private add(key: string, m: Msg): void {
    this.visits++
    if (this.entries.has(key)) return
    this.entries.set(key, m)
    if (!validMessageShape(m)) this.invalid++
    const size = this.encoder.encode(JSON.stringify(m) ?? 'null').length
    this.sizes.set(key, size); this.bytes += size
    const id = (m as { id?: unknown } | null)?.id
    if (typeof id !== 'string') return
    let values = this.ids.get(id)
    if (!values) this.ids.set(id, values = new Map())
    values.set(key, m); this.changed.add(id); this.touched.add(id)
  }

  private remove(key: string): void {
    this.visits++
    if (!this.entries.has(key)) return
    const m = this.entries.get(key)
    this.entries.delete(key)
    if (!validMessageShape(m)) this.invalid--
    this.bytes -= this.sizes.get(key) ?? 0; this.sizes.delete(key)
    const id = (m as { id?: unknown } | null)?.id
    if (typeof id !== 'string') return
    const values = this.ids.get(id)
    values?.delete(key)
    if (!values?.size) { this.ids.delete(id); this.changed.delete(id) }
    else this.changed.add(id)
    this.touched.add(id)
  }

  rebuild(): void {
    this.changed.clear()
    this.entries.clear(); this.ids.clear(); this.sizes.clear(); this.bytes = 0
    this.invalid = 0
    // Rebuild is intentionally a full store pass, used only at startup/debug/recovery.
    for (const structs of this.bus.doc!.store.clients.values()) for (const struct of structs) {
      if (!(struct instanceof Y.Item) || struct.parent !== this.bus || struct.parentSub !== null || struct.deleted) continue
      const values = struct.content.getContent()
      values.forEach((m, i) => this.add(`${struct.id.client}:${struct.id.clock + i}`, m as Msg))
    }
  }

  count(id: string): number { return this.ids.get(id)?.size ?? 0 }
  first(id: string): Msg | undefined {
    const values = this.ids.get(id)
    // Order only matters for a duplicate id, an exceptional stale-replica path.
    return values?.size === 1 ? values.values().next().value : values?.size ? this.bus.toArray().find(m => m?.id === id) : undefined
  }
}
