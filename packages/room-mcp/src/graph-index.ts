/**
 * Keeps a SymbolGraph current for one room from local files and shared manifest versions.
 */
import { bareSymbol, containsPath, digestPath, holderFence, manifestKey, manifestPaths, observedContractAnalysis, participantRecord, snapshotPath, SymbolGraph, versionOf, type FileSymbols, type ObservedContractChange, type RoomDoc } from '@room/shared'
import type * as Y from 'yjs'
import fs from 'node:fs'
import path from 'node:path'
import { git, gitShow } from '@room/roomd/git'
import { DISK_READ_PATH, containedRepoPath, validRepoPath } from '@room/roomd'
import { acquireParseWorker, parseInWorker, TransientParserError, type ParseWorker } from './parse/client.js'
import { specForPath } from './parse/index.js'
import type { BaselineRead } from '@room/roomd/baseline'
import { carriedFrom } from './worker-registry.js'
import { snapshotStillCurrent } from '@room/shared'
import { HistoricalTextTooLarge, readBoundedCheckoutText, readBoundedHistoricalText } from './tools/disk-text.js'

const isSourcePath = (path: string): boolean => specForPath(path) !== undefined
const MAX_FILES = 3000
const MAX_BYTES = 256 * 1024
const MAX_REFRESH_CONCURRENCY = 8
const MAX_RETAINED_SYMBOLS = 400_000
const MAX_RETAINED_BYTES = 64 * 1024 * 1024
const MAX_SYMBOLS_PER_FILE = 4000
const BUDGET_WARNING_PREFIX = 'retained graph budget: '
type RetainedCost = { symbols: number; bytes: number }
let processSymbols = 0, processBytes = 0
function symbolCost(path: string, symbols: FileSymbols | undefined): RetainedCost {
  if (!symbols) return { symbols: 0, bytes: 0 }
  let count = 0, bytes = 256 + path.length * 2
  for (const values of [symbols.defs, symbols.refs, symbols.imports ?? []]) for (const value of values) {
    count++; bytes += value.length * 2 + 96
  }
  return { symbols: count, bytes }
}
/** Snapshot limits: every publish is appended to the room's persisted update log, so keep each one small and rare. */
const MAX_EDGES = 4000
const MAX_OBSERVED = 200
const MAX_UNCOVERED_PATHS = 200
const MAX_SNAPSHOT_BYTES = 200 * 1024
const MIN_PUBLISH_MS = 20_000
const YIELD_EVERY = 100
const YIELD_AFTER_MS = 20
const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve))
type PublicationSource = { kind: 'base'; base: string } | { kind: 'entry'; person: string; fence: string; hash: string } |
  { kind: 'deletion'; person: string; fence: string; base: string; baseline: string }

/**
 * Whether a consumer uses `symbol` as defined in `provider`: a call in the provider's own file,
 * or a reference the graph's import narrowing resolves to the provider rather than to another
 * definer that `known` (the caller's symbol graph) has indexed.
 */
export async function consumesSymbol(consumer: string, text: string, provider: string, symbol: string, known?: SymbolGraph): Promise<boolean> {
  if (!isSourcePath(consumer) || text.length > MAX_BYTES) return false
  const [parsed] = await parseInWorker(consumer, [text])
  if (!parsed) return false
  const wanted = bareSymbol(symbol)
  if (![...parsed.refs, ...parsed.ownRefs].some(ref => bareSymbol(ref) === wanted)) return false
  if (consumer === provider) return true
  const name = symbol.split(/[.:]+/).filter(Boolean).at(-1) ?? symbol
  const files = new Map<string, FileSymbols>([[provider, { defs: [name], refs: [], imports: [] }]])
  for (const path of known?.definersOf(name) ?? []) if (path !== provider && path !== consumer) files.set(path, known!.symbolsOf(path)!)
  files.set(consumer, { defs: parsed.defs.map(definition => definition.name), refs: parsed.refs, imports: parsed.imports })
  const graph = new SymbolGraph(path => files.get(path))
  for (const path of files.keys()) graph.set(path, '')
  return graph.dependenciesOf(consumer).some(dep => dep.symbol === name && dep.definedIn.includes(provider))
}

/** Immutable base facts only; no room, leases, overlays or sharing grants cross a reconnect. */
export interface GraphSeed { dir: string; base: string; files: ReadonlyMap<string, FileSymbols> }
export interface GraphIndexOptions {
  minPublishMs?: number; random?: () => number; read?: typeof gitShow; seed?: GraphSeed
  maxPaths?: number; maxRetainedSymbols?: number; maxRetainedBytes?: number; maxSymbolsPerFile?: number
  /** Test-only isolated parser; production indexes use the process-shared parser. */
  parser?: Pick<ParseWorker, 'parse' | 'stop'>
}

export class GraphIndex {
  private readonly parser: Pick<ParseWorker, 'parse' | 'stop'>
  private admitted = new Set<string>()
  private activePaths = new Set<string>()
  private retainedCosts = new Map<string, RetainedCost>()
  private recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private budgetWarned = false
  private priorityCache = new Map<string, number>()
  private priorityClaimPaths?: string[]
  private budgetPublishing?: NodeJS.Immediate
  private withdrawalPending = false
  /** Test-only accounting includes both local and published graph facts. */
  get retainedBudgetForTest(): RetainedCost & { processSymbols: number; processBytes: number } {
    let symbols = 0, bytes = 0
    for (const cost of this.retainedCosts.values()) { symbols += cost.symbols; bytes += cost.bytes }
    return { symbols, bytes, processSymbols, processBytes }
  }
  private completedFiles = new Set<string>()
  private totalFiles = 0
  get indexingStatus(): string {
    if (this.phase === 'error') return 'graph unavailable (index discovery failed)'
    if (this.degradedPaths.size) return `graph coverage degraded (${this.degradedPaths.size} file(s) unavailable)`
    if (this.isReady && this.uncoveredPaths.size) return `graph: ${this.uncoveredPaths.size} file(s) outside the contract analysis budget or not analysable, not covered`
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
  private uncoveredPaths = new Set<string>()
  private uncoveredWarnings = new Map<string, string>()
  /** A completed index can still have declared gaps; negative tool replies must mention them. */
  get contractCoverageNote(): string {
    const paths = [...this.uncoveredPaths].filter(path => this.uncoveredAuthorized(path)).sort()
    if (!paths.length) return ''
    const more = paths.length > 3 ? `, +${paths.length - 3} more` : ''
    return `(${paths.length} file${paths.length === 1 ? '' : 's'} outside the contract analysis budget or not analysable, not covered: ${paths.slice(0, 3).join(', ')}${more})`
  }
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
  private discovering = false
  private jitterTimer?: ReturnType<typeof setTimeout>
  private endJitter?: () => void
  private unobserve: (() => void)[] = []
  private currentBuild: Promise<void> = Promise.resolve()
  /** Quiescence alone does not mean discovery or individual reads succeeded. */
  get isReady(): boolean { return this.phase !== 'error' && !this.degradedPaths.size && !this.discovering && this.pending.size === 0 }
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

  constructor(private room: RoomDoc, private me: string, private dir: string, private log: (s: string) => void = () => {}, private opts: GraphIndexOptions = {}) {
    this.parser = opts.parser ?? acquireParseWorker()
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
    const paths = new Set([...this.cache.keys(), ...this.degradedPaths, ...this.uncoveredPaths])
    for (const person of this.room.manifestHead.keys()) for (const path of manifestPaths(this.room, person)) paths.add(path)
    return paths
  }

  start(): void {
    this.discovering = true
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
      for (const path of this.uncoveredPaths) paths.add(path)
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
        this.invalidatePriorities()
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
    const onClaims = (event: { keysChanged: Set<string> }) => {
      this.invalidatePriorities()
      if (!this.base || this.stopped) return
      for (const claim of this.room.openClaims()) if (event.keysChanged.has(claim.id)) {
        const paths = claim.path.endsWith('/') ? [...this.grantPaths()].filter(path => containsPath(claim.path, path)) : [claim.path]
        for (const path of paths) if (!this.admitted.has(path)) void this.refresh(path)
      }
    }
    this.room.claims.observe(onClaims)
    this.unobserve.push(() => this.room.claims.unobserve(onClaims))
    this.ownPublicationKey = this.publicationKey()
    const onHead = (event: { keysChanged: Set<string>; transaction: Y.Transaction }) => {
      this.invalidatePriorities()
      for (const person of event.keysChanged) if (person !== this.me) refreshPeerPublication(person, event.transaction)
      if (!event.keysChanged.has(this.me)) return
      const next = this.publicationKey()
      this.withdrawRestricted()
      if (next === this.ownPublicationKey) {
        // A revision can move without changing parsed symbols. Wait for all events in
        // this transaction and their refreshes before stamping the new provenance.
        setImmediate(() => { if (!this.stopped) void this.whenIdle().then(() => this.publish(this.phase)).catch(e => { if (!this.stopped) this.log(`graph: provenance refresh failed: ${String(e)}`) }) })
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

  baseSeed(): GraphSeed {
    const files = new Map<string, FileSymbols>()
    for (const [path, source] of this.publishedSource) {
      const local = this.cache.get(path), published = this.publishedCache.get(path)
      if (source.kind === 'base' && source.base === this.base && local && published && !this.pending.has(path) &&
          JSON.stringify(local) === JSON.stringify(published)) files.set(path, local)
    }
    return { dir: this.dir, base: this.base, files }
  }

  /** Re-evaluate current authority even when the parsed immutable base is reusable. */
  private reuseBase(path: string): boolean {
    const seed = this.opts.seed
    if (!seed || seed.dir !== this.dir || seed.base !== this.base) return false
    const symbols = seed.files.get(path)
    if (!symbols) return false
    for (const [person, head] of this.room.manifestHead) {
      if (this.room.manifest.get(manifestKey(person, head.fence))?.has(path)) return false
      if (this.room.roomSalt && head.excluded.includes(digestPath(this.room.roomSalt, path))) return false
    }
    if (!this.admitPath(path)) return true
    const source: PublicationSource = { kind: 'base', base: this.base }
    const published = this.publicationAllowed(path, source) ? symbols : undefined
    if (!this.reserveSymbols(path, symbols, published)) return true
    this.cache.set(path, symbols); this.setGraph(path, '')
    if (published) {
      this.publishedCache.set(path, symbols); this.publishedSource.set(path, source)
      this.publishedGraph.set(path, '')
    }
    this.completedFiles.add(path)
    return true
  }

  stop(): void {
    this.stopped = true
    this.parser.stop()
    clearImmediate(this.budgetPublishing); this.budgetPublishing = undefined; this.withdrawalPending = false
    this.invalidatePriorities()
    for (const timer of this.recoveryTimers.values()) clearTimeout(timer)
    this.recoveryTimers.clear()
    for (const path of this.retainedCosts.keys()) this.setRetainedCost(path, { symbols: 0, bytes: 0 })
    this.admitted.clear()
    for (const path of this.cache.keys()) this.graph.remove(path)
    for (const path of this.publishedCache.keys()) this.publishedGraph.remove(path)
    this.cache.clear(); this.publishedCache.clear(); this.publishedSource.clear(); this.observedByPath.clear()
    this.changeListeners.clear()
    clearTimeout(this.jitterTimer); this.endJitter?.(); clearTimeout(this.publishing)
    for (const entry of this.pending.values()) { entry.resolve(); entry.resolveIdle() }
    this.pending.clear()
    this.activePaths.clear()
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
    this.invalidatePriorities()
    this.discovering = true
    try {
      for (const entry of this.pending.values()) entry.resolve() // release any superseded build
      this.phase = 'indexing'
      this.completedFiles.clear()
      this.totalFiles = 0
      this.base = participantRecord(this.room, this.me)?.git?.base ?? ''
      this.observedByPath.clear()
      for (const path of this.retainedCosts.keys()) this.syncRetainedCost(path)
      this.observedRevision++
      this.degradedPaths.clear()
      this.uncoveredPaths.clear()
      this.uncoveredWarnings.clear()
      for (const timer of this.recoveryTimers.values()) clearTimeout(timer)
      this.recoveryTimers.clear(); this.admitted.clear()
      let removed = 0, lastRemovalYield = Date.now()
      for (const p of this.cache.keys()) {
        this.cache.delete(p); this.publishedCache.delete(p); this.publishedSource.delete(p)
        this.removeGraph(p)
        if (++removed % YIELD_EVERY === 0 || Date.now() - lastRemovalYield >= YIELD_AFTER_MS) {
          await yieldToEventLoop()
          if (generation !== this.generation || this.stopped) return
          lastRemovalYield = Date.now()
        }
      }
      this.cache.clear()
      for (const p of this.publishedCache.keys()) {
        this.publishedCache.delete(p); this.publishedGraph.remove(p); this.syncRetainedCost(p)
      }
      this.publishedCache.clear()
      this.publishedSource.clear()
      if (!this.base) return
      await this.publish('indexing')
      if (generation !== this.generation || this.stopped) return
      let paths: string[] = []
      try { paths = (await git(this.dir, ['ls-tree', '-r', '--name-only', '-z', this.base])).split('\0').filter(isSourcePath) }
      catch (e) { if (generation === this.generation) { this.phase = 'error'; this.publish('error') }; this.log(`graph: ls-tree failed: ${e instanceof Error ? e.message : e}`); return }
      if (generation !== this.generation || this.stopped) return
      this.truncated = false
      const all = new Set(paths)
      for (const person of this.room.manifestHead.keys()) for (const p of manifestPaths(this.room, person)) if (isSourcePath(p)) all.add(p)
      const t0 = Date.now()
      const ordered = Array.from(all).sort((a, b) => this.comparePriority(a, b))
      const pathsToRefresh = ordered.slice(0, this.opts.maxPaths ?? MAX_FILES)
      for (const path of ordered.slice(pathsToRefresh.length)) this.omit(path, 'path admission limit')
      this.totalFiles = pathsToRefresh.length
      if (generation !== this.generation || this.stopped) return
      const refreshes: Promise<void>[] = []
      let reused = 0
      let lastYield = Date.now()
      for (let i = 0; i < pathsToRefresh.length; i++) {
        if (i > 0 && (i % YIELD_EVERY === 0 || Date.now() - lastYield >= YIELD_AFTER_MS)) {
          await yieldToEventLoop()
          if (generation !== this.generation || this.stopped) return
          lastYield = Date.now()
        }
        if (this.reuseBase(pathsToRefresh[i])) reused++
        else refreshes.push(this.refresh(pathsToRefresh[i]))
      }
      if (reused) this.log(`graph: reused ${reused} unchanged base files after reconnect`)
      await Promise.all(refreshes)
      if (generation !== this.generation || this.stopped) return
      this.phase = 'ready'
      await this.publish('ready')
      this.log(`graph: indexed ${this.graph.size} files in ${Date.now() - t0}ms`)
    } finally {
      if (generation === this.generation) {
        this.discovering = false
        this.changedResolution()
      }
    }
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
      if (['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined
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

  private uncoveredAuthorized(path: string): boolean {
    const fence = this.room.manifestHead.get(this.me)?.fence
    const entry = fence ? this.room.manifest.get(manifestKey(this.me, fence))?.get(path) : undefined
    return this.entryAuthorized(this.me, path, entry) || !entry &&
      !!this.uncoveredWarnings.get(path)?.startsWith(BUDGET_WARNING_PREFIX) &&
      this.publicationAllowed(path, { kind: 'base', base: this.base })
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
    const gapAllowed = (p: string) => (graph?.sourceFence === undefined || graph.sourceFence === head?.fence) && this.uncoveredAuthorized(p)
    for (const path of this.uncoveredPaths) if (!gapAllowed(path)) {
      this.uncoveredPaths.delete(path)
      this.uncoveredWarnings.delete(path)
      this.observedRevision++
    }
    for (const path of this.publishedSource.keys()) if (!allowed(path)) {
      this.publishedCache.delete(path)
      this.publishedSource.delete(path)
      this.publishedGraph.remove(path)
      this.observedByPath.delete(path)
      this.syncRetainedCost(path)
      this.graphRevision++
      this.observedRevision++
    }
    if (!graph) return
    const paths = graph.paths.filter(allowed)
    const edges = graph.edges.filter(e => allowed(e.source) && allowed(e.target))
    const observed = graph.observed?.filter(o => allowed(o.path))
    const uncoveredPaths = graph.uncoveredPaths?.filter(gapAllowed)
    if (paths.length === graph.paths.length && edges.length === graph.edges.length && observed?.length === graph.observed?.length &&
        uncoveredPaths?.length === graph.uncoveredPaths?.length) return
    this.room.graphs.set(this.me, { ...graph, status: 'indexing', paths, edges, observed, uncoveredPaths,
      sourceFence: head?.fence, sourceRev: head?.rev, at: Date.now() })
    this.lastPublished.key = ''
    this.lastPublishedRevision = { graph: -1, observed: -1, base: '', provenance: '' }
  }

  private setRetainedCost(path: string, cost: RetainedCost): void {
    const old = this.retainedCosts.get(path) ?? { symbols: 0, bytes: 0 }
    processSymbols += cost.symbols - old.symbols; processBytes += cost.bytes - old.bytes
    if (cost.bytes) this.retainedCosts.set(path, cost)
    else this.retainedCosts.delete(path)
  }

  private syncRetainedCost(path: string): void {
    const local = symbolCost(path, this.cache.get(path)), published = symbolCost(path, this.publishedCache.get(path))
    this.setRetainedCost(path, { symbols: local.symbols + published.symbols,
      bytes: local.bytes + published.bytes + this.observedBytes(this.observedByPath.get(path)) })
  }

  private observedBytes(changes: ObservedContractChange[] | undefined): number {
    let bytes = 0
    for (const change of changes ?? []) bytes += 128 + 2 * (change.path.length + change.symbol.length + change.detail.length)
    return bytes
  }

  private priority(path: string): number {
    const cached = this.priorityCache.get(path)
    if (cached !== undefined) return cached
    const head = this.room.manifestHead.get(this.me)
    const claims = this.priorityClaimPaths ??= this.room.openClaims().map(claim => claim.path)
    const rank = head && this.room.manifest.get(manifestKey(this.me, head.fence))?.has(path) ? 0
      : claims.some(prefix => containsPath(prefix, path)) ? 1 : 2
    this.priorityCache.set(path, rank)
    return rank
  }
  private invalidatePriorities(): void {
    this.priorityCache.clear(); this.priorityClaimPaths = undefined
  }
  private comparePriority(a: string, b: string): number {
    return this.priority(a) - this.priority(b) || (a < b ? -1 : a > b ? 1 : 0)
  }

  private omit(path: string, reason: string): void {
    this.admitted.delete(path)
    // Drop queued work on eviction. Keep active requests until their existing settlement path runs.
    if (!this.activePaths.has(path)) {
      const pending = this.pending.get(path)
      pending?.resolve(); pending?.resolveIdle(); this.pending.delete(path)
      const queued = this.refreshQueue.indexOf(path)
      if (queued >= 0) this.refreshQueue.splice(queued, 1)
      this.revisions.delete(path); this.completedFiles.delete(path)
    }
    this.cache.delete(path); this.publishedCache.delete(path); this.publishedSource.delete(path)
    this.observedByPath.delete(path); this.observedRevision++
    this.removeGraph(path)
    this.degradedPaths.delete(path); this.uncoveredPaths.add(path)
    this.uncoveredWarnings.set(path, BUDGET_WARNING_PREFIX + reason); this.truncated = true
    this.lastPublished.key = ''
    clearTimeout(this.recoveryTimers.get(path)); this.recoveryTimers.delete(path)
    if (!this.budgetWarned) { this.budgetWarned = true; this.log(`graph: retained graph budget: ${reason}; omitted paths are not covered`) }
    this.priorityCache.delete(path)
    // One guarded snapshot withdraws a whole admission pass, even inside the publish window.
    const current = this.room.graphs.get(this.me)
    this.queueBudgetPublish(!!(current?.paths.includes(path) || current?.observed?.some(change => change.path === path)))
  }

  private admitPath(path: string): boolean {
    if (!isSourcePath(path)) return false
    if (this.admitted.has(path)) return true
    if (this.admitted.size >= (this.opts.maxPaths ?? MAX_FILES)) {
      let worst: string | undefined
      for (const candidate of this.admitted) if (!worst || this.comparePriority(candidate, worst) > 0) worst = candidate
      if (!worst || this.comparePriority(path, worst) >= 0) { this.omit(path, 'path admission limit'); return false }
      this.omit(worst, 'path admission limit')
    }
    this.admitted.add(path)
    return true
  }

  private reserveSymbols(path: string, local: FileSymbols | undefined, published: FileSymbols | undefined, observed?: ObservedContractChange[]): boolean {
    const a = symbolCost(path, local), b = symbolCost(path, published)
    if (Math.max(a.symbols, b.symbols) > (this.opts.maxSymbolsPerFile ?? MAX_SYMBOLS_PER_FILE)) {
      this.omit(path, 'per-file symbol limit'); return false
    }
    const cost = { symbols: a.symbols + b.symbols, bytes: a.bytes + b.bytes + this.observedBytes(observed) }
    const old = this.retainedCosts.get(path) ?? { symbols: 0, bytes: 0 }
    const fits = () => processSymbols - old.symbols + cost.symbols <= (this.opts.maxRetainedSymbols ?? MAX_RETAINED_SYMBOLS) &&
      processBytes - old.bytes + cost.bytes <= (this.opts.maxRetainedBytes ?? MAX_RETAINED_BYTES)
    if (fits()) { this.setRetainedCost(path, cost); return true }
    const victims = [...this.retainedCosts.keys()].filter(other => other !== path && this.comparePriority(other, path) > 0)
      .sort((a, b) => this.comparePriority(b, a))
    const refundable = victims.reduce((sum, other) => {
      const cost = this.retainedCosts.get(other)!
      return { symbols: sum.symbols + cost.symbols, bytes: sum.bytes + cost.bytes }
    }, { symbols: 0, bytes: 0 })
    if (processSymbols - old.symbols + cost.symbols - refundable.symbols > (this.opts.maxRetainedSymbols ?? MAX_RETAINED_SYMBOLS) ||
        processBytes - old.bytes + cost.bytes - refundable.bytes > (this.opts.maxRetainedBytes ?? MAX_RETAINED_BYTES)) {
      this.omit(path, 'retained symbol/byte limit'); return false
    }
    while (!fits() && victims.length) this.omit(victims.shift()!, 'retained symbol/byte limit')
    if (!fits()) { this.omit(path, 'retained symbol/byte limit'); return false }
    this.setRetainedCost(path, cost)
    return true
  }

  refresh(path: string): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (!this.admitPath(path)) return Promise.resolve()
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
    const idle = new Promise<void>(r => { resolveIdle = () => { this.activePaths.delete(path); r() } })
    this.pending.set(path, { generation: this.generation, promise, resolve, idle, resolveIdle })
    this.refreshQueue.push(path)
    this.drainRefreshQueue()
    return promise
  }

  private removeGraph(path: string): void {
    const existed = this.graph.has(path)
    this.graph.remove(path); this.publishedGraph.remove(path); this.graphRevision++
    this.syncRetainedCost(path)
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
        else {
          entry?.resolveIdle(); this.pending.delete(path)
          // A path's revision only matters while its refresh is in flight; without this, every
          // path ever refreshed would be remembered for the session's lifetime.
          this.revisions.delete(path)
        }
        if (!this.stopped && !this.pending.size) {
          clearTimeout(this.publishing)
          this.publishing = setTimeout(() => { void this.publish(this.phase) }, 100)
        }
        this.drainRefreshQueue()
      })
    }
  }

  private async runRefresh(path: string): Promise<boolean> {
    if (!this.admitted.has(path)) return true
    this.activePaths.add(path)
    const generation = this.generation
    try {
      const done = await this.runRefreshOnce(path)
      if (done) { clearTimeout(this.recoveryTimers.get(path)); this.recoveryTimers.delete(path) }
      if (done && !this.cache.has(path) && !this.publishedCache.has(path)) this.admitted.delete(path)
      return done
    } catch (error) {
      if (error instanceof TransientParserError && !this.stopped && generation === this.generation &&
          this.admitted.has(path) && !this.recoveryTimers.has(path)) {
        const timer = setTimeout(() => {
          this.recoveryTimers.delete(path)
          if (!this.stopped) void this.refresh(path)
        }, Math.max(1, error.retryAt - Date.now()))
        timer.unref()
        this.recoveryTimers.set(path, timer)
      } else if (!(error instanceof TransientParserError)) {
        clearTimeout(this.recoveryTimers.get(path)); this.recoveryTimers.delete(path)
      }
      throw error
    }
  }

  private async runRefreshOnce(path: string): Promise<boolean> {
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
      const ownFileUnavailable = myEntry?.state === 'shared' && !mineDeleted && mine === undefined
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
      const baseText = ownFileUnavailable ? undefined : baseRead?.kind === 'available' ? baseRead.text : ''
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
      if (!this.admitted.has(path)) return true
      const publishedSymbols = publicParsed && publicText !== undefined && publicText.length <= MAX_BYTES ? {
        defs: publicParsed.defs.map(d => d.name), refs: publicParsed.refs, imports: publicParsed.imports,
      } : undefined
      if (!this.reserveSymbols(path, symbols, publishedSymbols)) {
        await this.yieldAfterIndex()
        return revision === this.revisions.get(path)
      }
      this.uncoveredPaths.delete(path)
      if (!symbols || text === undefined) { this.cache.delete(path); this.removeGraph(path) }
      else { this.cache.set(path, symbols); this.setGraph(path, text) }
      if (publicText === undefined || publicText.length > MAX_BYTES) { this.publishedCache.delete(path); this.publishedSource.delete(path); this.publishedGraph.remove(path) }
      else {
        if (!publicParsed) { this.publishedCache.delete(path); this.publishedSource.delete(path); this.publishedGraph.remove(path) }
        else {
          this.publishedCache.set(path, publishedSymbols!)
          this.publishedSource.set(path, publication!.source)
          this.publishedGraph.set(path, publicText)
        }
      }
      this.graphRevision++
      if (myEntry?.state === 'shared' && this.ownTextAuthorized(path) && (publicText !== undefined || mineDeleted || ownFileUnavailable)) {
        if (baseRead?.kind === 'unavailable') {
          this.degradedPaths.add(path)
          this.observedByPath.delete(path)
          this.syncRetainedCost(path)
          this.log(`graph: baseline unavailable for ${path}; observed contract coverage degraded: ${baseRead.error.message}`)
          this.observedRevision++
          await this.yieldAfterIndex()
          return revision === this.revisions.get(path)
        }
        this.degradedPaths.delete(path)
        const afterText = mineDeleted ? '' : publicText ?? ''
        const chars = Math.max(baseText?.length ?? 0, afterText.length)
        const bytes = Buffer.byteLength(afterText)
        const analysis = ownFileUnavailable || chars > MAX_BYTES ? undefined : observedContractAnalysis(baseText!, afterText, path, (_path, value) =>
          value === '' ? emptyParsed : value === baseText ? baseParsed : publicParsed)
        if (!analysis || analysis.status === 'unavailable') {
          const warning = !analysis
            ? (ownFileUnavailable ? 'local-text-unavailable: ' : '') + (ownFileUnavailable && bytes <= MAX_BYTES
              ? 'local text cannot be read; observed contract coverage degraded'
              : `${Math.ceil(Math.max(chars, bytes) / 1024)} KB is over the 256 KB contract analysis cap; observed contract coverage degraded`)
            : `${analysis.reason}: ${analysis.detail}; observed contract coverage degraded`
          this.uncoveredPaths.add(path)
          this.observedByPath.delete(path)
          this.syncRetainedCost(path)
          if (this.uncoveredWarnings.get(path) !== warning) {
            this.uncoveredWarnings.set(path, warning)
            this.log(`graph: ${path}: ${warning}`)
          }
          this.observedRevision++
          await this.yieldAfterIndex()
          return revision === this.revisions.get(path)
        }
        this.uncoveredWarnings.delete(path)
        const changes = analysis.changes.map(change => ({ path, ...change }))
        if (!this.reserveSymbols(path, this.cache.get(path), this.publishedCache.get(path), changes)) {
          await this.yieldAfterIndex()
          return revision === this.revisions.get(path)
        }
        if (changes.length && mineDeleted && baseRead?.kind === 'available' &&
            this.entryAuthorized(this.me, path, myEntry) && publicationSource?.fenceValid &&
            snapshotStillCurrent(this.room, publicationSource, []))
          this.publishedSource.set(path, { kind: 'deletion', person: this.me, fence: myEntry.fence,
            base: this.base, baseline: JSON.stringify([own?.sha ?? this.base, own?.untracked.get(path)?.sha, own?.carriedCommit ?? false]) })
        if (changes.length) this.observedByPath.set(path, changes)
        else this.observedByPath.delete(path)
      } else {
        this.uncoveredWarnings.delete(path)
        this.observedByPath.delete(path)
        if (heldBy.length) {
          this.degradedPaths.add(path)
          this.log(`graph: ${path} changed by ${heldBy.join(', ')}; contract not visible`)
        } else this.degradedPaths.delete(path)
      }
      this.observedRevision++
      this.syncRetainedCost(path)
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

  private queueBudgetPublish(withdrawal: boolean): void {
    this.withdrawalPending ||= withdrawal
    if (this.budgetPublishing || this.stopped) return
    this.budgetPublishing = setImmediate(() => {
      this.budgetPublishing = undefined
      if (!this.stopped) void this.publish(this.phase)
    })
    this.budgetPublishing.unref()
  }

  private publish(status: 'ready' | 'indexing' | 'error'): Promise<void> {
    const generation = this.generation
    this.publication = this.publication.then(async () => {
      const withdrawal = this.withdrawalPending
      await this.publishSnapshot(status, generation, withdrawal)
      const current = this.room.graphs.get(this.me), head = this.room.manifestHead.get(this.me)
      if (withdrawal && this.lastPublishedRevision.graph === this.graphRevision && this.lastPublishedRevision.observed === this.observedRevision &&
          current?.at === this.lastPublished.at && current.base === this.base && current.sourceFence === head?.fence && current.sourceRev === head?.rev)
        this.withdrawalPending = false
    }).catch(e => {
      this.log(`graph: could not publish: ${e instanceof Error ? e.message : String(e)}`)
    })
    return this.publication
  }

  private async publishSnapshot(status: 'ready' | 'indexing' | 'error', generation: number, withdrawal = false): Promise<void> {
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
    const allObserved = [...this.observedByPath.values()].flat().filter(change =>
      (allowedPaths.has(change.path) || this.publishedSource.get(change.path)?.kind === 'deletion') &&
      this.publicationAllowed(change.path)).sort((a, b) => a.path.localeCompare(b.path) || a.symbol.localeCompare(b.symbol))
    let observedTruncated = allObserved.length > MAX_OBSERVED
    const observed = allObserved.slice(0, MAX_OBSERVED)
    const budget = MAX_SNAPSHOT_BYTES - 512 // room/base/fence/status metadata around this body
    const edges = new Map<string, { source: string; target: string; symbols: string[] }>()
    let truncated = this.truncated
    // Edges over the byte budget are dropped as a whole, so stop collecting them as soon as the
    // serialized body would exceed it instead of materializing every edge's symbol list first.
    let bodyBytes = Buffer.byteLength(JSON.stringify({ paths, edges: [], observed }))
    let overBudget = bodyBytes > budget
    let lastYield = Date.now()
    for (let i = 0; i < paths.length && !overBudget; i++) {
      const target = paths[i]
      for (const dep of this.publishedGraph.dependenciesOf(target)) {
        if (overBudget) break
        for (const source of dep.definedIn) {
          if (!allowedPaths.has(source)) continue
          const key = JSON.stringify([source, target])
          let edge = edges.get(key)
          if (!edge) {
            if (edges.size >= MAX_EDGES) { truncated = true; continue }
            edge = { source, target, symbols: [] }
            edges.set(key, edge)
            bodyBytes += Buffer.byteLength(JSON.stringify(edge)) + (edges.size > 1 ? 1 : 0)
          }
          bodyBytes += Buffer.byteLength(JSON.stringify(dep.symbol)) + (edge.symbols.length ? 1 : 0)
          edge.symbols.push(dep.symbol)
          if (bodyBytes > budget) { overBudget = true; break }
        }
      }
      if ((i + 1) % YIELD_EVERY === 0 || Date.now() - lastYield >= YIELD_AFTER_MS) {
        await yieldToEventLoop()
        if (this.stopped || generation !== this.generation || graphRevision !== this.graphRevision || observedRevision !== this.observedRevision) return
        lastYield = Date.now()
      }
    }
    let edgeList = overBudget ? [] : [...edges.values()]
    if (overBudget) truncated = true
    const allUncovered = [...this.uncoveredPaths].filter(path => this.uncoveredAuthorized(path)).sort()
    const uncoveredPaths = allUncovered.slice(0, MAX_UNCOVERED_PATHS)
    let uncoveredTruncated = allUncovered.length > uncoveredPaths.length
    // The running count mirrors this serialization exactly; the check stays as the single gate.
    if (Buffer.byteLength(JSON.stringify({ paths, edges: edgeList, observed })) > budget) { edgeList = []; truncated = true }
    const serialize = () => JSON.stringify({ paths, edges: edgeList, observed, uncoveredPaths, uncoveredTruncated })
    let body = serialize()
    while (Buffer.byteLength(body) > budget && uncoveredPaths.length) {
      uncoveredPaths.pop(); uncoveredTruncated = true; body = serialize()
    }
    while (Buffer.byteLength(body) > budget && observed.length) {
      observed.pop(); observedTruncated = true; body = serialize()
    }
    // Many long names can exceed the budget on their own. Edges that survived the first check
    // exactly at the limit go first, so trimming the sorted path list leaves no dangling edge.
    let bodyBytesLeft = Buffer.byteLength(body)
    if (bodyBytesLeft > budget && edgeList.length) { edgeList = []; truncated = true; body = serialize(); bodyBytesLeft = Buffer.byteLength(body) }
    if (bodyBytesLeft > budget) {
      while (bodyBytesLeft > budget && paths.length) { bodyBytesLeft -= Buffer.byteLength(JSON.stringify(paths.pop()!)) + 1; truncated = true }
      body = serialize()
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
    if (!withdrawal && status === this.lastPublished.status && now - this.lastPublished.at < minMs) {
      clearTimeout(this.publishing)
      this.publishing = setTimeout(() => { void this.publish(this.phase) }, minMs - (now - this.lastPublished.at))
      return
    }
    if (paths.some(path => !this.publicationAllowed(path))) return
    this.lastPublished = { at: now, key, status }
    this.lastPublishedRevision = { graph: graphRevision, observed: observedRevision, base, provenance }
    this.room.graphs.set(this.me, { version: 1, base: this.base, sourceFence, sourceRev,
      at: now, status, paths, edges: edgeList, observed, observedTruncated, uncoveredPaths, uncoveredTruncated, truncated })
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
