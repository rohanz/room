/**
 * Keeps a SymbolGraph current for one room from local files and shared manifest versions.
 */
import { bareSymbol, containsPath, digestPath, holderFence, manifestKey, manifestPaths, observedContractChanges, participantRecord, snapshotPath, SymbolGraph, versionOf, type FileSymbols, type ObservedContractChange, type RoomDoc } from '@room/shared'
import type * as Y from 'yjs'
import fs from 'node:fs'
import path from 'node:path'
import { git, gitShow } from '@room/roomd/git'
import { DISK_READ_PATH, containedRepoPath, validRepoPath } from '@room/roomd'
import { parseFile, ensureLanguages } from './parse/engine.js'
import { ParseWorker } from './parse/client.js'
import { specForPath } from './parse/index.js'
import type { BaselineRead } from '@room/roomd/baseline'
import { carriedFrom } from './worker-registry.js'
import { snapshotStillCurrent } from '@room/shared'
import { HistoricalTextTooLarge, readBoundedCheckoutText, readBoundedHistoricalText } from './tools/disk-text.js'

const isSourcePath = (path: string): boolean => specForPath(path) !== undefined
const MAX_FILES = 3000
const MAX_BYTES = 256 * 1024
const MAX_REFRESH_CONCURRENCY = 8
/** Snapshot limits: every publish is appended to the room's persisted update log, so keep each one small and rare. */
const MAX_EDGES = 4000
const MAX_OBSERVED = 200
const MAX_SNAPSHOT_BYTES = 200 * 1024
const MIN_PUBLISH_MS = 20_000
const YIELD_EVERY = 100
const YIELD_AFTER_MS = 20
const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve))
type PublicationSource = { kind: 'base'; base: string } | { kind: 'entry'; person: string; fence: string; hash: string } |
  { kind: 'deletion'; person: string; fence: string; base: string; baseline: string }

/** Read references from live worker text, including calls in the definition's own file. */
async function referencesSymbol(path: string, text: string, symbol: string): Promise<boolean> {
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
  private readonly parser = new ParseWorker()
  private completedFiles = new Set<string>()
  private totalFiles = 0
  get indexingStatus(): string {
    if (this.isReady) return 'graph has no pending files'
    const unfinished = [...this.pending.keys()].filter(path => !this.completedFiles.has(path)).length
    const total = Math.max(this.totalFiles, this.completedFiles.size + unfinished, this.pending.size)
    const completed = [...this.completedFiles].filter(path => !this.pending.has(path)).length
    return `graph still indexing (${completed} of ${total} files)`
  }
  readonly graph: SymbolGraph
  private readonly publishedGraph: SymbolGraph
  private cache = new Map<string, FileSymbols | undefined>()
  private publishedCache = new Map<string, FileSymbols | undefined>()
  private publishedSource = new Map<string, PublicationSource>()
  private pending = new Map<string, { generation: number; promise: Promise<void>; resolve: () => void; idle: Promise<void>; resolveIdle: () => void }>()
  /** Owns the concurrency limit and per-path deduplication for initial and overlay refreshes. */
  private refreshQueue: string[] = []
  private activeRefreshes = 0
  private revisions = new Map<string, number>()
  private observedByPath = new Map<string, ObservedContractChange[]>()
  private degradedPaths = new Set<string>()
  private generation = 0
  private graphRevision = 0
  private localRevision = 0
  private readonly changeListeners = new Set<() => void>()
  /** Local symbol/import facts used by contract resolution, independent of snapshot publication. */
  get resolutionRevision(): number { return this.localRevision }
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }
  private changedResolution(): void {
    this.localRevision++
    for (const listener of this.changeListeners) listener()
  }
  private observedRevision = 0
  private indexedSinceYield = 0
  private lastIndexYield = Date.now()
  private truncated = false
  private publishing?: ReturnType<typeof setTimeout>
  private lastPublished = { at: 0, key: '', status: '' }
  private lastPublishedRevision = { graph: -1, observed: -1, base: '', provenance: '' }
  private publication: Promise<void> = Promise.resolve()
  private phase: 'ready' | 'indexing' | 'error' = 'indexing'
  private base = ''
  private ownPublicationKey: string | undefined = ''
  private stopped = false
  private initialStarted = false
  private jitterTimer?: ReturnType<typeof setTimeout>
  private endJitter?: () => void
  private unobserve: (() => void)[] = []
  private currentBuild: Promise<void> = Promise.resolve()
  /** Tools can use available facts whenever no file refresh is queued or in flight. */
  get isReady(): boolean { return this.pending.size === 0 }
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
    this.publishedGraph = new SymbolGraph(path => this.publishedCache.get(path))
  }

  private historicalText(base: string, pathname: string): Promise<string | undefined> {
    return this.opts.read ? this.opts.read(this.dir, base, pathname) : readBoundedHistoricalText(this.dir, base, pathname)
  }

  private async graphText(base: string, pathname: string): Promise<string | undefined> {
    try { return await this.historicalText(base, pathname) }
    catch (error) {
      if (!(error instanceof HistoricalTextTooLarge)) throw error
      this.log(`graph: historical text too large for ${pathname}; graph coverage degraded`)
      return undefined
    }
  }

  private publicationKey(): string | undefined {
    const head = this.room.manifestHead.get(this.me)
    if (!head) return undefined
    const holder = holderFence(participantRecord(this.room, this.me)?.holder)
    return JSON.stringify([head.fence, head.level, head.textPrefixes, head.coverage, head.complete,
      head.excluded, holder, this.room.roomSalt])
  }

  /** Grant changes can make a previously ignored peer path relevant again. */
  private grantPaths(): Set<string> {
    const paths = new Set([...this.cache.keys(), ...this.degradedPaths])
    for (const person of this.room.manifestHead.keys()) for (const path of manifestPaths(this.room, person)) paths.add(path)
    return paths
  }

  start(): void {
    this.currentBuild = this.initialBuild()
    const touchedInTransaction = new WeakMap<Y.Transaction, Set<string>>()
    const peerRefreshInTransaction = new WeakMap<Y.Transaction, Set<string>>()
    const peerPublicationKey = (person: string) => {
      const head = this.room.manifestHead.get(person)
      const record = participantRecord(this.room, person)
      return JSON.stringify([head?.fence, head?.level, head?.textPrefixes, head?.coverage, head?.complete,
        head?.excluded, head?.base, holderFence(record?.holder), record?.git?.base, record?.git?.fence])
    }
    const peerKeys = new Map([...this.room.manifestHead.keys()].filter(person => person !== this.me).map(person => [person, peerPublicationKey(person)]))
    const refreshPeerPublication = (person: string, transaction: Y.Transaction) => {
      const next = peerPublicationKey(person)
      if (next === peerKeys.get(person)) return
      peerKeys.set(person, next)
      const paths = peerRefreshInTransaction.get(transaction) ?? new Set<string>()
      for (const [path, source] of this.publishedSource) if (source.kind === 'entry' && source.person === person) paths.add(path)
      for (const path of manifestPaths(this.room, person)) paths.add(path)
      for (const path of this.degradedPaths) paths.add(path)
      peerRefreshInTransaction.set(transaction, paths)
      this.withdrawRestricted()
    }
    const afterTransaction = (transaction: Y.Transaction) => {
      const paths = peerRefreshInTransaction.get(transaction)
      if (!paths || !this.base || this.stopped) return
      const touched = touchedInTransaction.get(transaction)
      for (const path of paths) if (isSourcePath(path) && !touched?.has(path)) void this.refresh(path)
      if (![...paths].some(isSourcePath) && !touched?.size) void this.publish(this.phase)
    }
    this.room.doc.on('afterTransaction', afterTransaction)
    this.unobserve.push(() => this.room.doc.off('afterTransaction', afterTransaction))
    const observe = <T>(root: Y.Map<Y.Map<T>>) => {
      const known = new Map([...root].map(([person, map]) => [person, new Set(map.keys())]))
      return (events: Y.YEvent<any>[]) => {
        if (this.stopped) return
        this.withdrawRestricted()
        const paths = touchedPaths(events, root, known)
        for (const event of events) {
          const touched = touchedInTransaction.get(event.transaction) ?? new Set<string>()
          for (const path of paths) touched.add(path)
          touchedInTransaction.set(event.transaction, touched)
        }
        if (this.base) for (const path of paths) if (isSourcePath(path)) void this.refresh(path)
      }
    }
    const onManifest = observe(this.room.manifest)
    this.room.manifest.observeDeep(onManifest)
    this.unobserve.push(() => this.room.manifest.unobserveDeep(onManifest))
    this.ownPublicationKey = this.publicationKey()
    const onHead = (event: { keysChanged: Set<string>; transaction: Y.Transaction }) => {
      for (const person of event.keysChanged) if (person !== this.me) refreshPeerPublication(person, event.transaction)
      if (!event.keysChanged.has(this.me)) return
      const next = this.publicationKey()
      this.withdrawRestricted()
      if (next === this.ownPublicationKey) {
        // A revision can move without changing parsed symbols. Wait for all events in
        // this transaction and their refreshes before stamping the new provenance.
        setImmediate(() => { if (!this.stopped) void this.whenIdle().then(() => this.publish(this.phase)).catch(e => this.log(`graph: provenance refresh failed: ${String(e)}`)) })
        return
      }
      const firstHead = this.ownPublicationKey === undefined
      this.ownPublicationKey = next
      if (firstHead) return // the manifest map event names every newly published path
      const paths = this.grantPaths()
      for (const path of paths) if (isSourcePath(path)) void this.refresh(path)
      if (![...paths].some(isSourcePath)) void this.publish(this.phase)
    }
    this.room.manifestHead.observe(onHead)
    this.unobserve.push(() => this.room.manifestHead.unobserve(onHead))
    const onParticipant = (event: { keysChanged: Set<string>; transaction: Y.Transaction }) => {
      for (const key of event.keysChanged) {
        const divider = key.indexOf('\u0000')
        if (divider < 0) continue
        const person = key.slice(0, divider), field = key.slice(divider + 1)
        if (person !== this.me && (field === 'holder' || field === 'git')) refreshPeerPublication(person, event.transaction)
      }
      if (event.keysChanged.has(`${this.me}\u0000git`)) {
        const base = participantRecord(this.room, this.me)?.git?.base
        if (!this.stopped && this.initialStarted && base && base !== this.base) this.currentBuild = this.rebuild()
      }
      if (event.keysChanged.has(`${this.me}\u0000holder`)) {
        const next = this.publicationKey()
        this.withdrawRestricted()
        if (next === this.ownPublicationKey) return
        const firstHead = this.ownPublicationKey === undefined
        this.ownPublicationKey = next
        if (firstHead) return // the first manifest map event names every published path
        const paths = this.grantPaths()
        for (const path of paths) if (isSourcePath(path)) void this.refresh(path)
      }
    }
    this.room.participants.observe(onParticipant)
    this.unobserve.push(() => this.room.participants.unobserve(onParticipant))
    const onMeta = (event: { keysChanged: Set<string> }) => {
      if (!event.keysChanged.has('roomSalt')) return
      if (this.ownPublicationKey === undefined) return // first head/manifest publication already queues its paths
      const next = this.publicationKey()
      this.withdrawRestricted()
      if (next === this.ownPublicationKey) return
      this.ownPublicationKey = next
      for (const path of this.grantPaths()) if (isSourcePath(path)) void this.refresh(path)
    }
    this.room.metaMap.observe(onMeta)
    this.unobserve.push(() => this.room.metaMap.unobserve(onMeta))
  }

  stop(): void {
    this.stopped = true
    this.parser.stop()
    this.changeListeners.clear()
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
    this.completedFiles.clear()
    this.totalFiles = 0
    this.base = participantRecord(this.room, this.me)?.git?.base ?? ''
    this.observedByPath.clear()
    this.observedRevision++
    this.degradedPaths.clear()
    let removed = 0, lastRemovalYield = Date.now()
    for (const p of this.cache.keys()) {
      this.removeGraph(p)
      if (++removed % YIELD_EVERY === 0 || Date.now() - lastRemovalYield >= YIELD_AFTER_MS) {
        await yieldToEventLoop()
        if (generation !== this.generation || this.stopped) return
        lastRemovalYield = Date.now()
      }
    }
    this.cache.clear()
    for (const p of this.publishedCache.keys()) this.publishedGraph.remove(p)
    this.publishedCache.clear()
    this.publishedSource.clear()
    if (!this.base) return
    await this.publish('indexing')
    if (generation !== this.generation || this.stopped) return
    let paths: string[] = []
    try { paths = (await git(this.dir, ['ls-tree', '-r', '--name-only', '-z', this.base])).split('\0').filter(isSourcePath) }
    catch (e) { if (generation === this.generation) { this.phase = 'error'; this.publish('error') }; this.log(`graph: ls-tree failed: ${e instanceof Error ? e.message : e}`); return }
    if (generation !== this.generation || this.stopped) return
    this.truncated = paths.length > MAX_FILES
    if (paths.length > MAX_FILES) { this.log(`graph: ${paths.length} source files, indexing first ${MAX_FILES}`); paths = paths.slice(0, MAX_FILES) }
    const all = new Set(paths)
    for (const person of this.room.manifestHead.keys()) for (const p of manifestPaths(this.room, person)) if (isSourcePath(p)) all.add(p)
    const t0 = Date.now()
    const pathsToRefresh = Array.from(all)
    this.totalFiles = pathsToRefresh.length
    if (generation !== this.generation || this.stopped) return
    const refreshes: Promise<void>[] = []
    let lastYield = Date.now()
    for (let i = 0; i < pathsToRefresh.length; i++) {
      if (i > 0 && (i % YIELD_EVERY === 0 || Date.now() - lastYield >= YIELD_AFTER_MS)) {
        await yieldToEventLoop()
        if (generation !== this.generation || this.stopped) return
        lastYield = Date.now()
      }
      refreshes.push(this.refresh(pathsToRefresh[i]))
    }
    await Promise.all(refreshes)
    if (generation !== this.generation || this.stopped) return
    this.phase = 'ready'
    await this.publish('ready')
    this.log(`graph: indexed ${this.graph.size} files in ${Date.now() - t0}ms`)
  }

  private ownText(pathname: string): string | undefined {
    if (!validRepoPath(pathname, DISK_READ_PATH)) return undefined
    try {
      const root = fs.realpathSync(this.dir)
      const file = containedRepoPath(root, path.join(root, pathname), { leaf: 'read-contained-link' })
      if (!file.ok) return undefined
      const fd = fs.openSync(file.path, 'r')
      try {
        const stat = fs.fstatSync(fd)
        if (!stat.isFile() || stat.size > MAX_BYTES) return undefined
        const bytes = Buffer.allocUnsafe(MAX_BYTES + 1)
        let used = 0
        while (used < bytes.length) {
          const count = fs.readSync(fd, bytes, used, bytes.length - used, used)
          if (!count) break
          used += count
        }
        return used > MAX_BYTES ? undefined : bytes.toString('utf8', 0, used)
      } finally { fs.closeSync(fd) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  /** Only visible text or a certified base participates in the graph. */
  private async textFor(path: string): Promise<string | undefined> {
    const ownFence = this.room.manifestHead.get(this.me)?.fence
    const ownEntry = ownFence ? this.room.manifest.get(manifestKey(this.me, ownFence))?.get(path) : undefined
    if (ownEntry?.change === 'D') return undefined
    const mine = ownEntry ? this.ownText(path) : undefined
    if (mine !== undefined) return mine
    for (const person of this.room.manifestHead.keys()) {
      if (person === this.me) continue
      const participant = snapshotPath(this.room, person, [], path)
      const version = await versionOf(participant, path, { gitAt: (sha, relpath) => this.historicalText(sha, relpath) })
      if (!participant?.entries.has(path) && version.kind !== 'excluded') continue
      if (version.kind === 'text') return version.text
      return undefined
    }
    if (!this.base) return undefined
    return this.graphText(this.base, path)
  }

  /** Publication reads an accepted shared version or the certified base, never indexing disk text. */
  private async publicationTextFor(path: string): Promise<{ text: string; source: PublicationSource } | undefined> {
    const mine = snapshotPath(this.room, this.me, [], path)
    if (mine) {
      if (!this.ownTextAuthorized(path)) return undefined
      if (!mine.fenceValid || !mine.head.complete || mine.head.coverage.kind !== 'all') return undefined
      if (!mine.roomSalt || !/^[a-f0-9]{64}$/i.test(mine.roomSalt) || mine.head.excluded.includes(digestPath(mine.roomSalt, path))) return undefined
      // snapshot filters stale entry fences. Their raw presence is still a changed-path
      // warning, never proof that the path is unchanged at the certified base.
      const raw = this.room.manifest.get(manifestKey(this.me, mine.head.fence))?.get(path)
      if (raw && raw.fence !== mine.head.fence) return undefined
    }
    if (mine?.entries.has(path)) {
      if (!this.ownTextAuthorized(path)) return undefined
      const version = await versionOf(mine, path, { gitAt: (sha, relpath) => this.historicalText(sha, relpath) })
      return version.kind === 'text' && version.entry.hash
        ? { text: version.text, source: { kind: 'entry', person: this.me, fence: mine.head.fence, hash: version.entry.hash } } : undefined
    }
    for (const person of this.room.manifestHead.keys()) {
      if (person === this.me) continue
      const peer = snapshotPath(this.room, person, [], path)
      if (!peer) continue
      const raw = this.room.manifest.get(manifestKey(person, peer.head.fence))?.get(path)
      if (raw && raw.fence !== peer.head.fence) return undefined
      if (!peer.entries.has(path)) continue
      if (!this.entryAuthorized(person, path, raw)) return undefined
      const version = await versionOf(peer, path, { gitAt: (sha, relpath) => this.historicalText(sha, relpath) })
      return version.kind === 'text' && version.entry.hash
        ? { text: version.text, source: { kind: 'entry', person, fence: peer.head.fence, hash: version.entry.hash } } : undefined
    }
    if (!mine) {
      const text = await this.graphText(this.base, path)
      return text === undefined ? undefined : { text, source: { kind: 'base', base: this.base } }
    }
    const version = await versionOf(mine, path, { gitAt: (sha, relpath) => this.historicalText(sha, relpath) })
    return version.kind === 'base' && version.text !== undefined
      ? { text: version.text, source: { kind: 'base', base: mine.head.base } } : undefined
  }

  private ownTextAuthorized(path: string): boolean {
    const head = this.room.manifestHead.get(this.me)
    return !!head && (head.level === 'full' || head.level === 'declared' && (head.textPrefixes ?? []).some(prefix => containsPath(prefix, path)))
  }

  private peerTextAuthorized(person: string, path: string): boolean {
    const head = this.room.manifestHead.get(person)
    return !!head && (head.level === 'full' || head.level === 'declared' &&
      (head.textPrefixes ?? []).some(prefix => containsPath(prefix, path))) &&
      !!this.room.roomSalt && !head.excluded.includes(digestPath(this.room.roomSalt, path))
  }

  /** The baseline read for a deletion may include a worker's carried, untracked blob. */
  private deletionBaseline(path: string): string {
    const baseline = carriedFrom(this.dir, this.me)?.baseline
    return JSON.stringify([baseline?.sha ?? this.base, baseline?.untracked.get(path)?.sha, baseline?.carriedCommit ?? false])
  }

  private entryAuthorized(person: string, path: string, entry: { change: string; state: string; fence: string; hash?: string } | undefined): boolean {
    const head = this.room.manifestHead.get(person)
    const record = participantRecord(this.room, person)
    return !!head && !!entry && head.complete && head.coverage.kind === 'all' &&
      holderFence(record?.holder) === head.fence && record?.git?.base === head.base && record.git.fence === head.fence &&
      entry.fence === head.fence && entry.state === 'shared' && (entry.change === 'D' ? !entry.hash : !!entry.hash) &&
      (head.level === 'full' || head.level === 'declared' && (head.textPrefixes ?? []).some(prefix => containsPath(prefix, path))) &&
      !!this.room.roomSalt && /^[a-f0-9]{64}$/i.test(this.room.roomSalt) && !head.excluded.includes(digestPath(this.room.roomSalt, path))
  }

  private publicationAllowed(path: string, source = this.publishedSource.get(path)): boolean {
    if (!source) return false
    const head = this.room.manifestHead.get(this.me)
    if (!head) return source.kind === 'base' && source.base === this.base
    if (!this.ownTextAuthorized(path)) return false
    const record = participantRecord(this.room, this.me)
    if (!head.complete || head.coverage.kind !== 'all' || holderFence(record?.holder) !== head.fence ||
        record?.git?.base !== head.base || record.git.fence !== head.fence ||
        !this.room.roomSalt || !/^[a-f0-9]{64}$/i.test(this.room.roomSalt) ||
        head.excluded.includes(digestPath(this.room.roomSalt, path))) return false
    const ownEntry = this.room.manifest.get(manifestKey(this.me, head.fence))?.get(path)
    if (ownEntry) return this.entryAuthorized(this.me, path, ownEntry) && (ownEntry.change === 'D'
      ? source.kind === 'deletion' && source.person === this.me && source.fence === head.fence &&
        source.base === this.base && source.baseline === this.deletionBaseline(path)
      : source.kind === 'entry' && source.person === this.me && source.fence === head.fence && source.hash === ownEntry.hash)
    if (source.kind === 'base') return source.base === head.base && source.base === this.base
    if (source.person === this.me || source.kind === 'deletion') return false
    const peerEntry = this.room.manifest.get(manifestKey(source.person, source.fence))?.get(path)
    return source.fence === this.room.manifestHead.get(source.person)?.fence && source.hash === peerEntry?.hash &&
      this.entryAuthorized(source.person, path, peerEntry)
  }

  /** A new reader must never receive derived text after its grant is withdrawn. */
  private withdrawRestricted(): void {
    const graph = this.room.graphs.get(this.me)
    const head = this.room.manifestHead.get(this.me)
    if (!head && graph?.sourceFence === undefined) return // base-only index before the first manifest
    const allowed = (p: string) => (graph?.sourceFence === undefined || graph.sourceFence === head?.fence) && this.publicationAllowed(p)
    for (const path of this.publishedSource.keys()) if (!allowed(path)) {
      this.publishedCache.delete(path)
      this.publishedSource.delete(path)
      this.publishedGraph.remove(path)
      this.observedByPath.delete(path)
      this.graphRevision++
      this.observedRevision++
    }
    if (!graph) return
    const paths = graph.paths.filter(allowed)
    const edges = graph.edges.filter(e => allowed(e.source) && allowed(e.target))
    const observed = graph.observed?.filter(o => allowed(o.path))
    if (paths.length === graph.paths.length && edges.length === graph.edges.length && observed?.length === graph.observed?.length) return
    this.room.graphs.set(this.me, { ...graph, status: 'indexing', paths, edges, observed,
      sourceFence: head?.fence, sourceRev: head?.rev, at: Date.now() })
    this.lastPublished.key = ''
    this.lastPublishedRevision = { graph: -1, observed: -1, base: '', provenance: '' }
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

  private removeGraph(path: string): void {
    const existed = this.graph.has(path)
    this.graph.remove(path); this.publishedGraph.remove(path); this.graphRevision++
    if (existed) this.changedResolution()
  }
  private setGraph(path: string, text: string): void {
    const before = JSON.stringify(this.graph.symbolsOf(path))
    this.graph.set(path, text); this.graphRevision++
    if (JSON.stringify(this.graph.symbolsOf(path)) !== before) this.changedResolution()
  }

  private async yieldAfterIndex(): Promise<void> {
    if (++this.indexedSinceYield < YIELD_EVERY && Date.now() - this.lastIndexYield < YIELD_AFTER_MS) return
    this.indexedSinceYield = 0
    this.lastIndexYield = Date.now()
    await yieldToEventLoop()
  }

  private drainRefreshQueue(): void {
    while (!this.stopped && this.activeRefreshes < MAX_REFRESH_CONCURRENCY && this.refreshQueue.length) {
      const path = this.refreshQueue.shift()!
      this.activeRefreshes++
      const generation = this.generation
      void this.runRefresh(path).catch(e => {
        if (!this.stopped && generation === this.generation) {
          this.log(`graph: ${path}: ${e instanceof Error ? e.message : e}`)
          this.degradedPaths.add(path)
          this.cache.delete(path); this.publishedCache.delete(path); this.publishedSource.delete(path)
          this.observedByPath.delete(path); this.observedRevision++; this.removeGraph(path)
        }
        return generation === this.generation
      }).then(done => {
        this.activeRefreshes--
        // The first completed read satisfies initial/rebuild readiness. A path
        // edited during that read still refreshes again in the background.
        const entry = this.pending.get(path)
        if (entry?.generation === generation) entry.resolve()
        if (!done && !this.stopped) this.refreshQueue.push(path)
        else { entry?.resolveIdle(); this.pending.delete(path) }
        if (!this.stopped && !this.pending.size) {
          clearTimeout(this.publishing)
          this.publishing = setTimeout(() => { void this.publish(this.phase) }, 100)
        }
        this.drainRefreshQueue()
      })
    }
  }

  private async runRefresh(path: string): Promise<boolean> {
    if (!this.stopped) {
      const revision = this.revisions.get(path), generation = this.generation
      const text = await this.textFor(path)
      const publicationSource = snapshotPath(this.room, this.me, [], path)
      const publication = await this.publicationTextFor(path)
      const publicText = publication?.text
      const heldBy = text === undefined && this.ownTextAuthorized(path) ? [...this.room.manifestHead.keys()].filter(person => {
        if (person === this.me) return false
        const fence = this.room.manifestHead.get(person)?.fence
        if (!fence) return false
        const entry = this.room.manifest.get(manifestKey(person, fence))?.get(path)
        return entry?.state === 'held' && entry.fence === fence && this.peerTextAuthorized(person, path)
      }) : []
      const myFence = this.room.manifestHead.get(this.me)?.fence
      const myEntry = myFence ? this.room.manifest.get(manifestKey(this.me, myFence))?.get(path) : undefined
      const mine = myEntry && myEntry.change !== 'D' ? this.ownText(path) : undefined
      const mineDeleted = myEntry?.change === 'D'
      // A worker's own changes are measured from its baseline, so carried lead work is not credited to it.
      const own = carriedFrom(this.dir, this.me)?.baseline
      const read = (sha: string, file: string) => this.historicalText(sha, file)
      const baseRead: BaselineRead | undefined = mine !== undefined || mineDeleted
        ? await (own?.untracked.has(path)
          // A carried blob the registry names is a fact: if git cannot produce it, coverage is degraded, not absent.
          ? readBoundedCheckoutText(own.dir, own.untracked.get(path)!.sha, path).then(text => {
            if (text === undefined) throw new Error(`carried baseline blob ${own.untracked.get(path)!.sha} for ${path} is unavailable`)
            return text
          })
          : read(own?.sha ?? this.base, path)).then(
          text => text === undefined ? { kind: 'absent' as const } : { kind: 'available' as const, text },
          error => ({ kind: 'unavailable' as const, error: error instanceof Error ? error : new Error(String(error)) }),
        ) : undefined
      const baseText = baseRead?.kind === 'available' ? baseRead.text : ''
      const [parsed, publicParsed, baseParsed, emptyParsed] = await this.parser.parse(path,
        [text, publicText, baseText, ''].map(value => value !== undefined && value.length <= MAX_BYTES ? value : undefined))
      const symbols: FileSymbols | undefined = parsed ? {
        defs: parsed.defs.map(definition => definition.name), refs: parsed.refs, imports: parsed.imports,
      } : undefined
      // The base read can yield after a valid shared version was selected. A holder-only
      // epoch change leaves the manifest head unchanged, but revokes that version.
      if (publicationSource?.fenceValid && !snapshotStillCurrent(this.room, publicationSource, [])) {
        await this.yieldAfterIndex()
        return false
      }
      if (this.stopped) return true
      if (generation !== this.generation) return false
      if (!symbols || text === undefined) { this.cache.delete(path); this.removeGraph(path) }
      else { this.cache.set(path, symbols); this.setGraph(path, text) }
      if (publicText === undefined || publicText.length > MAX_BYTES) { this.publishedCache.delete(path); this.publishedSource.delete(path); this.publishedGraph.remove(path) }
      else {
        if (!publicParsed) { this.publishedCache.delete(path); this.publishedSource.delete(path); this.publishedGraph.remove(path) }
        else {
          this.publishedCache.set(path, { defs: publicParsed.defs.map(d => d.name), refs: publicParsed.refs, imports: publicParsed.imports })
          this.publishedSource.set(path, publication!.source)
          this.publishedGraph.set(path, publicText)
        }
      }
      this.graphRevision++
      if (myEntry?.state === 'shared' && this.ownTextAuthorized(path) && (publicText !== undefined || mineDeleted)) {
        if (baseRead?.kind === 'unavailable') {
          this.degradedPaths.add(path)
          this.observedByPath.delete(path)
          this.log(`graph: baseline unavailable for ${path}; observed contract coverage degraded: ${baseRead.error.message}`)
          this.observedRevision++
          await this.yieldAfterIndex()
          return revision === this.revisions.get(path)
        }
        this.degradedPaths.delete(path)
        const changes = observedContractChanges(baseText, mineDeleted ? '' : publicText ?? '', path, (_path, value) =>
          value === '' ? emptyParsed : value === baseText ? baseParsed : publicParsed).map(change => ({ path, ...change }))
        if (changes.length && mineDeleted && baseRead?.kind === 'available' &&
            this.entryAuthorized(this.me, path, myEntry) && publicationSource?.fenceValid &&
            snapshotStillCurrent(this.room, publicationSource, []))
          this.publishedSource.set(path, { kind: 'deletion', person: this.me, fence: myEntry.fence,
            base: this.base, baseline: JSON.stringify([own?.sha ?? this.base, own?.untracked.get(path)?.sha, own?.carriedCommit ?? false]) })
        if (changes.length) this.observedByPath.set(path, changes)
        else this.observedByPath.delete(path)
      } else {
        this.observedByPath.delete(path)
        if (heldBy.length) {
          this.degradedPaths.add(path)
          this.log(`graph: ${path} changed by ${heldBy.join(', ')}; contract not visible`)
        } else this.degradedPaths.delete(path)
      }
      this.observedRevision++
      this.completedFiles.add(path)
      await this.yieldAfterIndex()
      return revision === this.revisions.get(path)
    }
    return true
  }

  /** Wait for overlay work already queued as well as base rebuilds. */
  async whenIdle(): Promise<void> {
    await this.ready
    while (this.pending.size) await Promise.all([...this.pending.values()].map(entry => entry.idle))
  }

  private publish(status: 'ready' | 'indexing' | 'error'): Promise<void> {
    const generation = this.generation
    this.publication = this.publication.then(() => this.publishSnapshot(status, generation)).catch(e => {
      this.log(`graph: could not publish: ${e instanceof Error ? e.message : String(e)}`)
    })
    return this.publication
  }

  private async publishSnapshot(status: 'ready' | 'indexing' | 'error', generation: number): Promise<void> {
    if (this.stopped) return
    if (generation !== this.generation) return
    if (this.degradedPaths.size) status = 'error'
    const authorization = this.publicationKey()
    const sourceHead = this.room.manifestHead.get(this.me)
    const sourceFence = sourceHead?.fence, sourceRev = sourceHead?.rev
    const provenance = JSON.stringify([sourceFence, sourceRev])
    const graphRevision = this.graphRevision, observedRevision = this.observedRevision, base = this.base
    if (this.lastPublishedRevision.graph === graphRevision && this.lastPublishedRevision.observed === observedRevision &&
        this.lastPublishedRevision.base === base && this.lastPublishedRevision.provenance === provenance && this.lastPublished.status === status) return
    const paths = Array.from(this.publishedCache.keys()).filter(path => this.publicationAllowed(path)).sort()
    const allowedPaths = new Set(paths)
    const edges = new Map<string, { source: string; target: string; symbols: string[] }>()
    let truncated = this.truncated
    let lastYield = Date.now()
    for (let i = 0; i < paths.length; i++) {
      const target = paths[i]
      for (const dep of this.publishedGraph.dependenciesOf(target)) for (const source of dep.definedIn) {
        if (!allowedPaths.has(source)) continue
        const key = JSON.stringify([source, target])
        if (!edges.has(key)) {
          if (edges.size >= MAX_EDGES) { truncated = true; continue }
          edges.set(key, { source, target, symbols: [] })
        }
        edges.get(key)!.symbols.push(dep.symbol)
      }
      if ((i + 1) % YIELD_EVERY === 0 || Date.now() - lastYield >= YIELD_AFTER_MS) {
        await yieldToEventLoop()
        if (this.stopped || generation !== this.generation || graphRevision !== this.graphRevision || observedRevision !== this.observedRevision) return
        lastYield = Date.now()
      }
    }
    let edgeList = [...edges.values()]
    const allObserved = [...this.observedByPath.values()].flat().filter(change =>
      (allowedPaths.has(change.path) || this.publishedSource.get(change.path)?.kind === 'deletion') &&
      this.publicationAllowed(change.path)).sort((a, b) => a.path.localeCompare(b.path) || a.symbol.localeCompare(b.symbol))
    let observedTruncated = allObserved.length > MAX_OBSERVED
    const observed = allObserved.slice(0, MAX_OBSERVED)
    let body = JSON.stringify({ paths, edges: edgeList, observed })
    if (body.length > MAX_SNAPSHOT_BYTES) { edgeList = []; truncated = true; body = JSON.stringify({ paths, observed }) }
    while (body.length > MAX_SNAPSHOT_BYTES && observed.length) {
      observed.pop(); observedTruncated = true; body = JSON.stringify({ paths, observed })
    }
    // Same content as last time: nothing to write. Same status within the window: wait, then write once.
    const key = `${this.base}|${status}|${provenance}|${body.length}|${hashOf(body)}`
    const now = Date.now()
    const currentHead = this.room.manifestHead.get(this.me)
    if (this.stopped || generation !== this.generation || graphRevision !== this.graphRevision || observedRevision !== this.observedRevision ||
        authorization !== this.publicationKey() || currentHead?.fence !== sourceFence || currentHead?.rev !== sourceRev) return
    if (key === this.lastPublished.key) {
      this.lastPublishedRevision = { graph: graphRevision, observed: observedRevision, base, provenance }
      return
    }
    const minMs = this.opts.minPublishMs ?? MIN_PUBLISH_MS
    if (status === this.lastPublished.status && now - this.lastPublished.at < minMs) {
      clearTimeout(this.publishing)
      this.publishing = setTimeout(() => { void this.publish(this.phase) }, minMs - (now - this.lastPublished.at))
      return
    }
    if (paths.some(path => !this.publicationAllowed(path))) return
    this.lastPublished = { at: now, key, status }
    this.lastPublishedRevision = { graph: graphRevision, observed: observedRevision, base, provenance }
    this.room.graphs.set(this.me, { version: 1, base: this.base, sourceFence, sourceRev,
      at: now, status, paths, edges: edgeList, observed, observedTruncated, truncated })
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
