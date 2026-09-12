/**
 * Keeps a SymbolGraph current for one room: base commit + everyone's overlays.
 * For each path the indexed text is: my overlay, else another person's overlay, else base.
 */
import { SymbolGraph, type FileSymbols, type RoomDoc } from '@room/shared'
import { git, gitShow } from '@room/roomd/git'
import { extractSymbols } from './pyextract.js'

const SOURCE_EXT = /\.(py|js|jsx|ts|tsx|mjs|mts|cjs)$/
const MAX_FILES = 3000
const MAX_BYTES = 256 * 1024

export class GraphIndex {
  readonly graph: SymbolGraph
  private cache = new Map<string, FileSymbols | undefined>()
  private pending = new Map<string, Promise<void>>()
  private base = ''
  private stopped = false
  private unobserve: (() => void)[] = []
  /** Resolves when the initial build is done. */
  ready: Promise<void> = Promise.resolve()

  constructor(private room: RoomDoc, private me: string, private dir: string, private log: (s: string) => void = () => {}) {
    this.graph = new SymbolGraph(path => this.cache.get(path))
  }

  start(): void {
    this.ready = this.rebuild()
    const onOverlays = () => { if (!this.stopped) this.refreshChanged() }
    this.room.overlays.observeDeep(onOverlays)
    this.room.deleted.observeDeep(onOverlays)
    this.unobserve.push(() => { this.room.overlays.unobserveDeep(onOverlays); this.room.deleted.unobserveDeep(onOverlays) })
    const onMeta = () => { if (!this.stopped && this.room.meta.base && this.room.meta.base !== this.base) this.ready = this.rebuild() }
    this.room.metaMap.observe(onMeta)
    this.unobserve.push(() => this.room.metaMap.unobserve(onMeta))
  }

  stop(): void { this.stopped = true; for (const u of this.unobserve) u(); this.unobserve = [] }

  private async rebuild(): Promise<void> {
    this.base = this.room.meta.base ?? ''
    if (!this.base) return
    let paths: string[] = []
    try { paths = (await git(this.dir, ['ls-tree', '-r', '--name-only', this.base])).split('\n').filter(p => SOURCE_EXT.test(p)) }
    catch (e) { this.log(`graph: ls-tree failed: ${e instanceof Error ? e.message : e}`); return }
    if (paths.length > MAX_FILES) { this.log(`graph: ${paths.length} source files, indexing first ${MAX_FILES}`); paths = paths.slice(0, MAX_FILES) }
    const all = new Set(paths)
    for (const person of this.room.overlays.keys()) for (const p of this.room.changedPaths(person)) if (SOURCE_EXT.test(p)) all.add(p)
    const t0 = Date.now()
    await Promise.all(Array.from(all).map(p => this.refresh(p)))
    this.log(`graph: indexed ${this.graph.size} files in ${Date.now() - t0}ms`)
  }

  private refreshChanged(): void {
    const changed = new Set<string>()
    for (const person of this.room.overlays.keys()) for (const p of this.room.changedPaths(person)) if (SOURCE_EXT.test(p)) changed.add(p)
    for (const p of changed) void this.refresh(p)
  }

  /** Current text for a path as the index sees it. */
  private async textFor(path: string): Promise<string | undefined> {
    if (this.room.deleted.get(this.me)?.has(path)) return undefined
    const mine = this.room.text(path, this.me)
    if (mine !== undefined) return mine
    for (const person of this.room.overlays.keys()) { if (person === this.me) continue; const t = this.room.text(path, person); if (t !== undefined) return t }
    if (!this.base) return undefined
    return gitShow(this.dir, this.base, path)
  }

  refresh(path: string): Promise<void> {
    const inflight = this.pending.get(path)
    if (inflight) return inflight
    const p = (async () => {
      const text = await this.textFor(path)
      if (text === undefined || text.length > MAX_BYTES) { this.cache.delete(path); this.graph.remove(path); return }
      this.cache.set(path, await extractSymbols(path, text))
      this.graph.set(path, text)
    })().catch(e => this.log(`graph: ${path}: ${e instanceof Error ? e.message : e}`)).finally(() => this.pending.delete(path))
    this.pending.set(path, p)
    return p
  }
}
