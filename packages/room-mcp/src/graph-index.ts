/**
 * Keeps a SymbolGraph current for one room: base commit + everyone's overlays.
 * For each path the indexed text is: my overlay, else another person's overlay, else base.
 */
import { bareSymbol, observedContractChanges, SymbolGraph, type FileSymbols, type ObservedContractChange, type RoomDoc } from '@room/shared'
import type * as Y from 'yjs'
import { git, gitShow } from '@room/roomd/git'
import { parseFile, ensureLanguages } from './parse/engine.js'
import { specForPath } from './parse/index.js'
import { readBaseline, workerBaseline, type BaselineRead } from '@room/roomd/baseline'

const isSourcePath = (path: string): boolean => specForPath(path) !== undefined
const MAX_FILES = 3000
const MAX_BYTES = 256 * 1024
const MAX_REFRESH_CONCURRENCY = 8
/** Snapshot limits: every publish is appended to the room's persisted update log, so keep each one small and rare. */
const MAX_EDGES = 4000
const MAX_OBSERVED = 200
const MAX_SNAPSHOT_BYTES = 200 * 1024
const MIN_PUBLISH_MS = 20_000

/** Read references from live worker text, including calls in the definition's own file. */
export async function referencesSymbol(path: string, text: string, symbol: string): Promise<boolean> {
  if (!isSourcePath(path) || text.length > MAX_BYTES) return false
  await ensureLanguages([path])
  const parsed = parseFile(path, text)
  if (!parsed) return false
  const wanted = bareSymbol(symbol)
  return [...parsed.refs, ...parsed.ownRefs].some(ref => bareSymbol(ref) === wanted)
}

/**
 * Whether a consumer uses `symbol` as defined in `provider`: a call in the provider's own file,
 * or a reference the graph's import narrowing resolves to the provider rather than to another
 * definer that `known` (the caller's symbol graph) has indexed.
 */
export async function consumesSymbol(consumer: string, text: string, provider: string, symbol: string, known?: SymbolGraph): Promise<boolean> {
  if (!await referencesSymbol(consumer, text, symbol)) return false
  if (consumer === provider) return true
  const parsed = parseFile(consumer, text)!
  const name = symbol.split(/[.:]+/).filter(Boolean).at(-1) ?? symbol
  const files = new Map<string, FileSymbols>([[provider, { defs: [name], refs: [], imports: [] }]])
  for (const path of known?.definersOf(name) ?? []) if (path !== provider && path !== consumer) files.set(path, known!.symbolsOf(path)!)
  files.set(consumer, { defs: parsed.defs.map(definition => definition.name), refs: parsed.refs, imports: parsed.imports })
  const graph = new SymbolGraph(path => files.get(path))
  for (const path of files.keys()) graph.set(path, '')
  return graph.dependenciesOf(consumer).some(dep => dep.symbol === name && dep.definedIn.includes(provider))
}

export class GraphIndex {
  readonly graph: SymbolGraph
  private cache = new Map<string, FileSymbols | undefined>()
  private pending = new Map<string, { generation: number; promise: Promise<void>; resolve: () => void; idle: Promise<void>; resolveIdle: () => void }>()
  /** Owns the concurrency limit and per-path deduplication for initial and overlay refreshes. */
  private refreshQueue: string[] = []
  private activeRefreshes = 0
  private revisions = new Map<string, number>()
  private observedByPath = new Map<string, ObservedContractChange[]>()
  private degradedPaths = new Set<string>()
  private generation = 0
  private truncated = false
  private publishing?: ReturnType<typeof setTimeout>
  private lastPublished = { at: 0, key: '', status: '' }
  private phase: 'ready' | 'indexing' | 'error' = 'indexing'
  private base = ''
  private stopped = false
  private initialStarted = false
  private jitterTimer?: ReturnType<typeof setTimeout>
  private endJitter?: () => void
  private unobserve: (() => void)[] = []
  private currentBuild: Promise<void> = Promise.resolve()
  /** Resolves when the current build is done, even if a captured waiter is superseded. */
  get ready(): Promise<void> { return this.waitForCurrentBuild() }

  private async waitForCurrentBuild(): Promise<void> {
    while (true) {
      if (this.stopped) throw new Error('graph index is closed')
      const build = this.currentBuild
      try { await build }
      catch (error) { if (build === this.currentBuild) throw error }
      if (this.stopped) throw new Error('graph index is closed')
      if (build === this.currentBuild) return
    }
  }

  constructor(private room: RoomDoc, private me: string, private dir: string, private log: (s: string) => void = () => {}, private opts: { minPublishMs?: number; random?: () => number; read?: typeof gitShow } = {}) {
    this.graph = new SymbolGraph(path => this.cache.get(path))
  }

  start(): void {
    this.currentBuild = this.initialBuild()
    const observe = <T>(root: Y.Map<Y.Map<T>>) => {
      const known = new Map([...root].map(([person, map]) => [person, new Set(map.keys())]))
      return (events: Y.YEvent<any>[]) => {
        if (this.stopped) return
        const paths = touchedPaths(events, root, known)
        if (this.base) for (const path of paths) if (isSourcePath(path)) void this.refresh(path)
      }
    }
    const onOverlays = observe(this.room.overlays)
    const onDeleted = observe(this.room.deleted)
    this.room.overlays.observeDeep(onOverlays)
    this.room.deleted.observeDeep(onDeleted)
    this.unobserve.push(() => { this.room.overlays.unobserveDeep(onOverlays); this.room.deleted.unobserveDeep(onDeleted) })
    const onMeta = () => { if (!this.stopped && this.initialStarted && this.room.meta.base && this.room.meta.base !== this.base) this.currentBuild = this.rebuild() }
    this.room.metaMap.observe(onMeta)
    this.unobserve.push(() => this.room.metaMap.unobserve(onMeta))
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.jitterTimer); this.endJitter?.(); clearTimeout(this.publishing)
    for (const entry of this.pending.values()) { entry.resolve(); entry.resolveIdle() }
    this.pending.clear()
    this.refreshQueue.length = 0
    for (const u of this.unobserve) u()
    this.unobserve = []
  }

  private async initialBuild(): Promise<void> {
    await new Promise<void>(resolve => {
      this.endJitter = resolve
      this.jitterTimer = setTimeout(resolve, Math.floor((this.opts.random ?? Math.random)() * 4001))
    })
    this.initialStarted = true
    if (!this.stopped) await this.rebuild()
  }

  private async rebuild(): Promise<void> {
    const generation = ++this.generation
    for (const entry of this.pending.values()) entry.resolve() // release any superseded build
    this.phase = 'indexing'
    this.base = this.room.meta.base ?? ''
    this.observedByPath.clear()
    this.degradedPaths.clear()
    for (const p of this.cache.keys()) this.graph.remove(p)
    this.cache.clear()
    if (!this.base) return
    this.publish('indexing')
    let paths: string[] = []
    try { paths = (await git(this.dir, ['ls-tree', '-r', '--name-only', '-z', this.base])).split('\0').filter(isSourcePath) }
    catch (e) { if (generation === this.generation) { this.phase = 'error'; this.publish('error') }; this.log(`graph: ls-tree failed: ${e instanceof Error ? e.message : e}`); return }
    if (generation !== this.generation || this.stopped) return
    this.truncated = paths.length > MAX_FILES
    if (paths.length > MAX_FILES) { this.log(`graph: ${paths.length} source files, indexing first ${MAX_FILES}`); paths = paths.slice(0, MAX_FILES) }
    const all = new Set(paths)
    for (const person of this.room.overlays.keys()) for (const p of this.room.changedPaths(person)) if (isSourcePath(p)) all.add(p)
    for (const p of this.cache.keys()) if (!all.has(p)) { this.cache.delete(p); this.graph.remove(p) }
    const t0 = Date.now()
    const pathsToRefresh = Array.from(all)
    await ensureLanguages(pathsToRefresh)
    if (generation !== this.generation || this.stopped) return
    await Promise.all(pathsToRefresh.map(path => this.refresh(path)))
    if (generation !== this.generation || this.stopped) return
    this.phase = 'ready'
    this.publish('ready')
    this.log(`graph: indexed ${this.graph.size} files in ${Date.now() - t0}ms`)
  }

  /** Current text for a path as the index sees it. */
  private async textFor(path: string): Promise<string | undefined> {
    if (this.room.deleted.get(this.me)?.has(path)) return undefined
    const mine = this.room.text(path, this.me)
    if (mine !== undefined) return mine
    for (const person of this.room.overlays.keys()) { if (person === this.me) continue; const t = this.room.text(path, person); if (t !== undefined) return t }
    if (!this.base) return undefined
    return (this.opts.read ?? gitShow)(this.dir, this.base, path)
  }

  refresh(path: string): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.revisions.set(path, (this.revisions.get(path) ?? 0) + 1)
    const inflight = this.pending.get(path)
    if (inflight) {
      if (inflight.generation !== this.generation) {
        inflight.resolve() // release the superseded rebuild
        inflight.promise = new Promise<void>(resolve => { inflight.resolve = resolve })
        inflight.generation = this.generation
      }
      return inflight.promise
    }
    let resolve!: () => void
    const promise = new Promise<void>(r => { resolve = r })
    let resolveIdle!: () => void
    const idle = new Promise<void>(r => { resolveIdle = r })
    this.pending.set(path, { generation: this.generation, promise, resolve, idle, resolveIdle })
    this.refreshQueue.push(path)
    this.drainRefreshQueue()
    return promise
  }

  private drainRefreshQueue(): void {
    while (!this.stopped && this.activeRefreshes < MAX_REFRESH_CONCURRENCY && this.refreshQueue.length) {
      const path = this.refreshQueue.shift()!
      this.activeRefreshes++
      const generation = this.generation
      void this.runRefresh(path).catch(e => { this.log(`graph: ${path}: ${e instanceof Error ? e.message : e}`); return generation === this.generation }).then(done => {
        this.activeRefreshes--
        // The first completed read satisfies initial/rebuild readiness. A path
        // edited during that read still refreshes again in the background.
        const entry = this.pending.get(path)
        if (entry?.generation === generation) entry.resolve()
        if (!done && !this.stopped) this.refreshQueue.push(path)
        else { entry?.resolveIdle(); this.pending.delete(path) }
        if (!this.stopped && !this.pending.size) {
          clearTimeout(this.publishing)
          this.publishing = setTimeout(() => {
            try { this.publish(this.phase) } catch (e) { this.log(`graph: could not publish: ${e instanceof Error ? e.message : String(e)}`) }
          }, 100)
        }
        this.drainRefreshQueue()
      })
    }
  }

  private async runRefresh(path: string): Promise<boolean> {
    if (!this.stopped) {
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
      // A worker's own changes are measured from its baseline, so carried lead work is not credited to it.
      const own = workerBaseline(this.room.workerOf(this.me))
      const read = (sha: string, file: string) => (this.opts.read ?? gitShow)(this.dir, sha, file)
      const baseRead: BaselineRead | undefined = mine !== undefined || mineDeleted
        ? own ? await readBaseline(own, path, read) : await read(this.base, path).then(
          text => text === undefined ? { kind: 'absent' as const } : { kind: 'available' as const, text },
          error => ({ kind: 'unavailable' as const, error: error instanceof Error ? error : new Error(String(error)) }),
        ) : undefined
      if (this.stopped) return true
      if (generation !== this.generation) return false
      if (!symbols || text === undefined) { this.cache.delete(path); this.graph.remove(path) }
      else { this.cache.set(path, symbols); this.graph.set(path, text) }
      if (mine !== undefined || mineDeleted) {
        if (baseRead?.kind === 'unavailable') {
          this.degradedPaths.add(path)
          this.observedByPath.delete(path)
          this.log(`graph: baseline unavailable for ${path}; observed contract coverage degraded: ${baseRead.error.message}`)
          return revision === this.revisions.get(path)
        }
        this.degradedPaths.delete(path)
        const changes = observedContractChanges(baseRead?.kind === 'available' ? baseRead.text : '', mineDeleted ? '' : mine ?? '', path, parseFile).map(change => ({ path, ...change }))
        if (changes.length) this.observedByPath.set(path, changes)
        else this.observedByPath.delete(path)
      } else { this.observedByPath.delete(path); this.degradedPaths.delete(path) }
      return revision === this.revisions.get(path)
    }
    return true
  }

  /** Wait for overlay work already queued as well as base rebuilds. */
  async whenIdle(): Promise<void> {
    await this.ready
    while (this.pending.size) await Promise.all([...this.pending.values()].map(entry => entry.idle))
  }

  private publish(status: 'ready' | 'indexing' | 'error'): void {
    if (this.stopped) return
    if (this.degradedPaths.size) status = 'error'
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
    let edgeList = [...edges.values()]
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
      this.publishing = setTimeout(() => {
        try { this.publish(this.phase) } catch (e) { this.log(`graph: could not publish: ${e instanceof Error ? e.message : String(e)}`) }
      }, minMs - (now - this.lastPublished.at))
      return
    }
    this.lastPublished = { at: now, key, status }
    this.room.graphs.set(this.me, { version: 1, base: this.base, at: now, status, paths, edges: edgeList, observed, observedTruncated, truncated })
  }
}

/**
 * Paths named by observeDeep events on overlays or deleted (person -> path -> text): a text edit, a
 * path set or removed, or all old and new paths when a person's whole map changes.
 */
function touchedPaths<T>(events: Y.YEvent<any>[], root: Y.Map<Y.Map<T>>, known: Map<string, Set<string>>): Set<string> {
  const paths = new Set<string>()
  for (const event of events) {
    if (event.path.length >= 2) paths.add(String(event.path[1]))
    else if (event.path.length === 1) {
      for (const key of event.changes.keys.keys()) paths.add(key)
      const person = String(event.path[0])
      known.set(person, new Set(root.get(person)?.keys() ?? []))
    }
    else for (const [person, change] of event.changes.keys) {
      if (change.action !== 'add') for (const key of known.get(person) ?? []) paths.add(key)
      const current = root.get(person)
      for (const key of current?.keys() ?? []) paths.add(key)
      if (current) known.set(person, new Set(current.keys()))
      else known.delete(person)
    }
  }
  return paths
}

function hashOf(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
