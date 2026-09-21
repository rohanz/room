/**
 * Keeps a SymbolGraph current for one room: base commit + everyone's overlays.
 * For each path the indexed text is: my overlay, else another person's overlay, else base.
 */
import { observedContractChanges, SymbolGraph, type FileSymbols, type GraphSnapshot, type ObservedContractChange, type RoomDoc } from '@room/shared'
import { git, gitShow } from '@room/roomd/git'
import { parseFile, ensureLanguages } from './parse/engine.js'
import { specForPath } from './parse/index.js'

const isSourcePath = (path: string): boolean => specForPath(path) !== undefined
const MAX_FILES = 3000
const MAX_BYTES = 256 * 1024
/** Snapshot limits: every publish is appended to the room's persisted update log, so keep each one small and rare. */
const MAX_EDGES = 4000
const MAX_OBSERVED = 200
const MAX_SNAPSHOT_BYTES = 200 * 1024
const MIN_PUBLISH_MS = 20_000

export class GraphIndex {
  readonly graph: SymbolGraph
  private cache = new Map<string, FileSymbols | undefined>()
  private pending = new Map<string, Promise<void>>()
  private revisions = new Map<string, number>()
  private previousChanged = new Set<string>()
  private observedByPath = new Map<string, ObservedContractChange[]>()
  private generation = 0
  private truncated = false
  private publishing?: ReturnType<typeof setTimeout>
  private lastPublished = { at: 0, key: '', status: '' }
  private phase: 'ready' | 'indexing' | 'error' = 'indexing'
  private base = ''
  private stopped = false
  private reused?: GraphSnapshot
  private initialStarted = false
  private jitterTimer?: ReturnType<typeof setTimeout>
  private endJitter?: () => void
  private unobserve: (() => void)[] = []
  /** Resolves when the initial build is done. */
  ready: Promise<void> = Promise.resolve()

  constructor(private room: RoomDoc, private me: string, private dir: string, private log: (s: string) => void = () => {}, private opts: { minPublishMs?: number; random?: () => number; present?: () => string[] } = {}) {
    this.graph = new SymbolGraph(path => this.cache.get(path))
  }

  start(): void {
    for (const person of new Set([...this.room.overlays.keys(), ...this.room.deleted.keys()])) {
      for (const p of this.room.changedPaths(person)) if (isSourcePath(p)) this.previousChanged.add(p)
    }
    this.ready = this.initialBuild()
    const onOverlays = () => { if (!this.stopped) this.refreshChanged() }
    this.room.overlays.observeDeep(onOverlays)
    this.room.deleted.observeDeep(onOverlays)
    this.unobserve.push(() => { this.room.overlays.unobserveDeep(onOverlays); this.room.deleted.unobserveDeep(onOverlays) })
    const onMeta = () => { if (!this.stopped && this.initialStarted && this.room.meta.base && this.room.meta.base !== this.base) this.ready = this.rebuild() }
    this.room.metaMap.observe(onMeta)
    this.unobserve.push(() => this.room.metaMap.unobserve(onMeta))
  }

  stop(): void { this.stopped = true; clearTimeout(this.jitterTimer); this.endJitter?.(); clearTimeout(this.publishing); for (const u of this.unobserve) u(); this.unobserve = [] }

  private async initialBuild(): Promise<void> {
    await new Promise<void>(resolve => {
      this.endJitter = resolve
      this.jitterTimer = setTimeout(resolve, Math.floor((this.opts.random ?? Math.random)() * 4001))
    })
    this.initialStarted = true
    if (!this.stopped) await this.rebuild()
  }

  private reusableSnapshot(): GraphSnapshot | undefined {
    const now = Date.now(), present = new Set(this.opts.present?.() ?? [])
    return [...this.room.graphs.entries()].filter(([person, snapshot]) => person !== this.me && present.has(person)
      && snapshot.status === 'ready' && snapshot.base === this.base && now >= snapshot.at && now - snapshot.at < 60_000)
      .sort((a, b) => b[1].at - a[1].at)[0]?.[1]
  }

  private reuse(snapshot: GraphSnapshot): void {
    this.cache.clear()
    for (const p of snapshot.paths) this.cache.set(p, { defs: [], refs: [], imports: [] })
    for (const edge of snapshot.edges) {
      if (!this.cache.has(edge.source)) this.cache.set(edge.source, { defs: [], refs: [], imports: [] })
      if (!this.cache.has(edge.target)) this.cache.set(edge.target, { defs: [], refs: [], imports: [] })
      this.cache.get(edge.source)!.defs.push(...edge.symbols)
      this.cache.get(edge.target)!.refs.push(...edge.symbols)
      this.cache.get(edge.target)!.imports!.push(edge.source)
    }
    for (const p of this.cache.keys()) this.graph.set(p, '')
    this.truncated = snapshot.truncated
    this.reused = snapshot
  }

  private async rebuild(): Promise<void> {
    const generation = ++this.generation
    this.phase = 'indexing'
    this.base = this.room.meta.base ?? ''
    this.observedByPath.clear()
    for (const p of this.cache.keys()) this.graph.remove(p)
    this.cache.clear()
    this.reused = undefined
    if (!this.base) return
    this.publish('indexing')
    const shared = this.reusableSnapshot()
    if (shared) {
      this.reuse(shared)
      await Promise.all(this.room.changedPaths(this.me).filter(isSourcePath).map(p => this.refresh(p)))
      if (generation !== this.generation || this.stopped) return
      this.phase = 'ready'
      this.publish('ready')
      this.log(`graph: reused ready snapshot (${shared.paths.length} files)`)
      return
    }
    let paths: string[] = []
    try { paths = (await git(this.dir, ['ls-tree', '-r', '--name-only', this.base])).split('\n').filter(isSourcePath) }
    catch (e) { if (generation === this.generation) { this.phase = 'error'; this.publish('error') }; this.log(`graph: ls-tree failed: ${e instanceof Error ? e.message : e}`); return }
    if (generation !== this.generation || this.stopped) return
    this.truncated = paths.length > MAX_FILES
    if (paths.length > MAX_FILES) { this.log(`graph: ${paths.length} source files, indexing first ${MAX_FILES}`); paths = paths.slice(0, MAX_FILES) }
    const all = new Set(paths)
    for (const person of this.room.overlays.keys()) for (const p of this.room.changedPaths(person)) if (isSourcePath(p)) all.add(p)
    for (const p of this.cache.keys()) if (!all.has(p)) { this.cache.delete(p); this.graph.remove(p) }
    const t0 = Date.now()
    const queue = Array.from(all)
    await ensureLanguages(queue)
    await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => {
      while (queue.length && generation === this.generation && !this.stopped) await this.refresh(queue.shift()!)
    }))
    if (generation !== this.generation || this.stopped) return
    this.phase = 'ready'
    this.publish('ready')
    this.log(`graph: indexed ${this.graph.size} files in ${Date.now() - t0}ms`)
  }

  private refreshChanged(): void {
    if (!this.base) return
    const changed = new Set<string>()
    for (const person of new Set([...this.room.overlays.keys(), ...this.room.deleted.keys()])) for (const p of this.room.changedPaths(person)) if (isSourcePath(p)) changed.add(p)
    for (const p of new Set([...changed, ...this.previousChanged])) void this.refresh(p)
    this.previousChanged = changed
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
    this.revisions.set(path, (this.revisions.get(path) ?? 0) + 1)
    const inflight = this.pending.get(path)
    if (inflight) return inflight
    const p = (async () => {
      while (!this.stopped) {
        const revision = this.revisions.get(path), generation = this.generation
        await ensureLanguages([path])
        const text = await this.textFor(path)
        const parsed = text === undefined || text.length > MAX_BYTES ? undefined : parseFile(path, text)
        const symbols: FileSymbols | undefined = parsed ? {
          defs: parsed.defs.map(definition => definition.name),
          refs: parsed.refs,
          imports: parsed.imports,
        } as FileSymbols & { imports?: string[] } : undefined
        const mine = this.room.text(path, this.me)
        const mineDeleted = this.room.deleted.get(this.me)?.has(path) ?? false
        const baseText = mine !== undefined || mineDeleted ? await gitShow(this.dir, this.base, path) : undefined
        if (this.stopped) return
        if (generation !== this.generation || revision !== this.revisions.get(path)) continue
        this.reused = undefined
        if (!symbols || text === undefined) { this.cache.delete(path); this.graph.remove(path) }
        else { this.cache.set(path, symbols); this.graph.set(path, text) }
        if (mine !== undefined || mineDeleted) {
          const changes = observedContractChanges(baseText ?? '', mineDeleted ? '' : mine ?? '', path, parseFile).map(change => ({ path, ...change }))
          if (changes.length) this.observedByPath.set(path, changes)
          else this.observedByPath.delete(path)
        } else this.observedByPath.delete(path)
        break
      }
    })().catch(e => this.log(`graph: ${path}: ${e instanceof Error ? e.message : e}`)).finally(() => {
      this.pending.delete(path)
      if (!this.stopped && !this.pending.size) {
        clearTimeout(this.publishing)
        this.publishing = setTimeout(() => this.publish(this.phase), 100)
      }
    })
    this.pending.set(path, p)
    return p
  }

  /** Wait for overlay work already queued as well as base rebuilds. */
  async whenIdle(): Promise<void> {
    await this.ready
    while (this.pending.size) await Promise.all(this.pending.values())
  }

  private publish(status: 'ready' | 'indexing' | 'error'): void {
    if (this.stopped) return
    const paths = Array.from(this.cache.keys()).sort()
    const edges = new Map<string, { source: string; target: string; symbols: string[] }>()
    let truncated = this.truncated
    for (const target of paths) for (const dep of this.graph.dependenciesOf(target)) for (const source of dep.definedIn) {
      const key = JSON.stringify([source, target])
      if (!edges.has(key)) {
        if (edges.size >= MAX_EDGES) { truncated = true; continue }
        edges.set(key, { source, target, symbols: [] })
      }
      edges.get(key)!.symbols.push(dep.symbol)
    }
    let edgeList = this.reused?.edges ?? [...edges.values()]
    const allObserved = [...this.observedByPath.values()].flat().sort((a, b) => a.path.localeCompare(b.path) || a.symbol.localeCompare(b.symbol))
    let observedTruncated = allObserved.length > MAX_OBSERVED
    const observed = allObserved.slice(0, MAX_OBSERVED)
    let body = JSON.stringify({ paths, edges: edgeList, observed })
    if (body.length > MAX_SNAPSHOT_BYTES) { edgeList = []; truncated = true; body = JSON.stringify({ paths, observed }) }
    while (body.length > MAX_SNAPSHOT_BYTES && observed.length) {
      observed.pop(); observedTruncated = true; body = JSON.stringify({ paths, observed })
    }
    // Same content as last time: nothing to write. Same status within the window: wait, then write once.
    const key = `${this.base}|${status}|${body.length}|${hashOf(body)}`
    const now = Date.now()
    if (key === this.lastPublished.key) return
    const minMs = this.opts.minPublishMs ?? MIN_PUBLISH_MS
    if (status === this.lastPublished.status && now - this.lastPublished.at < minMs) {
      clearTimeout(this.publishing)
      this.publishing = setTimeout(() => this.publish(this.phase), minMs - (now - this.lastPublished.at))
      return
    }
    this.lastPublished = { at: now, key, status }
    this.room.graphs.set(this.me, { version: 1, base: this.base, at: now, status, paths, edges: edgeList, observed, observedTruncated, truncated })
  }
}

function hashOf(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
