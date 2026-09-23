import { bareSymbol, claimsOverlap, displayName, observedContractChanges, type SymbolGraph } from '@room/shared'
/**
 * Conflicts the agents did not declare. Two watchers on the room doc:
 *  - overlap: my own edits landing inside someone else's open claim (I hold no claim there)
 *    raise one interrupt to me and one notify to the claim holder, once per (path, claim);
 *  - preview: when both of us have changed the same file, a three-way merge against the
 *    common base runs (debounced) and a notify tells me the moment it stops merging cleanly,
 *    with an fyi when it is clean again.
 * Both post as the room itself, so the inbox rules treat them as addressed messages.
 */
import { structuredPatch } from 'diff'
import { createHash } from 'node:crypto'
import type { Claim, ConflictMsg, MergeConflictMsg, ContractMsg, GraphSnapshot, Identity, NoteMsg, RoomDoc } from '@room/shared'
import { gitMergeFile } from './merge.js'
import { ensureLanguages, parseFile } from './parse/engine.js'
import { consumesSymbol } from './graph-index.js'
import { baselineText, carriedPaths, carriesWork, pairBaseline, workerBaseline, type Baseline } from '@room/roomd/baseline'

export const ROOM: Identity = { name: 'room', kind: 'agent' }

export interface ConflictDeps {
  room: RoomDoc
  me: Identity
  /** A person's live text for a path; undefined when the file exists nowhere; null when deleted. */
  liveText: (path: string, person: string) => Promise<string | undefined | null>
  /** Text of a path at a commit. */
  baseText: (sha: string, path: string) => Promise<string | undefined>
  /** The commit a person's overlay is a delta from. */
  baseFor: (person: string) => string
  /** merge-base of two commits; throws when one is not in this clone. */
  mergeBase: (a: string, b: string) => Promise<string>
  log?: (line: string) => void
  debounceMs?: number
  /** Global merge-preview budget. Defaults to four starts per ten seconds. */
  mergeBudget?: number
  mergeWindowMs?: number
  now?: () => number
  /** Whether this participant currently has a live awareness entry. */
  isPresent?: (person: string) => boolean
  /** Undefined means hooks have never supplied evidence for this session. */
  writeIntent?: (path: string) => boolean | undefined
  /** Participants watching the same physical directory share file changes. */
  coLocated?: (person: string) => boolean
  /** This session's symbol graph: other definers narrow a carried definition's consumers by import. */
  graph?: () => SymbolGraph | undefined
}

export interface Range { from: number; to: number }

/** Line ranges (1-based, in the live text) that differ from the base. */
export function changedRanges(base: string, live: string): Range[] {
  const out: Range[] = []
  for (const h of structuredPatch('a', 'b', base, live, '', '', { context: 0 }).hunks) {
    const from = h.newStart, to = h.newLines ? h.newStart + h.newLines - 1 : h.newStart
    out.push({ from, to })
  }
  return out
}

const covers = (c: Claim, p: string, r: Range) => claimsOverlap(c, { path: p, ...r }) &&
  (c.path.endsWith('/') || (c.from <= r.from && c.to >= r.to))

export interface MergeResult { status: 'clean' | 'one-side' | 'conflict' | 'unknown'; lines: number[] }

/** Would my live version of `path` and theirs merge? Line numbers are where conflicts start. */
export async function mergePath(d: ConflictDeps, person: string, path: string): Promise<MergeResult> {
  const myBase = d.baseFor(d.me.name), theirBase = d.baseFor(person)
  let ancestor = myBase
  if (theirBase !== myBase) {
    try { ancestor = await d.mergeBase(myBase, theirBase) } catch { return { status: 'unknown', lines: [] } }
  }
  let m: string | undefined | null, t: string | undefined | null
  try { m = await d.liveText(path, d.me.name); t = await d.liveText(path, person) } catch { return { status: 'unknown', lines: [] } }
  const descends = async (from: string, sha: string) => (await d.mergeBase(from, sha).catch(() => '')) === from
  const pair = await pairBaseline(d.room.workerOf(d.me.name), d.room.workerOf(person), ancestor, descends)
  let b: string
  try { b = (pair ? await baselineText(pair, path, d.baseText) : await d.baseText(ancestor, path)) ?? '' } catch { return { status: 'unknown', lines: [] } }
  const mineT = m === null ? '' : m ?? b, theirs = t === null ? '' : t ?? b
  if (mineT === b || theirs === b) return { status: 'one-side', lines: [] }
  const res = await gitMergeFile(b, mineT, theirs, { ours: d.me.name, base: 'base', theirs: person })
  const lines = res.conflicts.map(c => c.from)
  return { status: lines.length ? 'conflict' : 'clean', lines }
}

type ObservedChange = NonNullable<GraphSnapshot['observed']>[number]
const hashText = (text: string) => createHash('sha256').update(text).digest('hex')

export class ConflictWatcher {
  private stopFns: (() => void)[] = []
  private timers = new Map<string, NodeJS.Timeout>()
  /** "path|claimId" pairs already reported. */
  private reported = new Set<string>()
  /** "person|path" pairs currently known to conflict. */
  private conflicting = new Set<string>()
  private inflight = new Set<string>()
  private mergeQueue = new Map<string, { person: string; path: string }>()
  private mergeStarts: number[] = []
  private mergeTimer: NodeJS.Timeout | null = null
  private draining: Promise<void> | null = null
  private mergeHashes = new Map<string, string>()
  private observedReported = new Set<string>()
  private observedChecks = new Set<Promise<void>>()
  private observedTimers = new Map<string, NodeJS.Timeout>()
  /** Last input hash per lead, so an unchanged lead costs nothing. */
  private observedInputs = new Map<string, string>()
  /** Contract changes by (baseline, path, before and live text): a text is parsed once. */
  private observedCache = new Map<string, ObservedChange[]>()
  private integrated = new Map<string, Set<string>>()
  private integrationReported = new Set<string>()
  private integrationTimer: NodeJS.Timeout | null = null
  private externalReported = new Map<string, number>()
  constructor(private d: ConflictDeps) {}

  start(): void {
    const onOverlays = (events: { target: unknown; path: (string | number)[]; changes: { keys: Map<string, unknown> } }[]) => {
      const touched = new Set<string>()
      for (const ev of events) {
        if (ev.target === this.d.room.overlays) {
          for (const person of ev.changes.keys.keys()) for (const p of this.d.room.changedPaths(person)) touched.add(`${person}|${p}`)
        } else if (ev.path.length >= 2) {
          touched.add(`${String(ev.path[0])}|${String(ev.path[1])}`)
        } else if (ev.path.length === 1) {
          for (const p of ev.changes.keys.keys()) touched.add(`${String(ev.path[0])}|${p}`)
        }
      }
      for (const key of touched) {
        const [person, p] = key.split('|')
        this.schedule(person, p)
      }
      this.checkAllObserved()
    }
    this.d.room.overlays.observeDeep(onOverlays as never)
    this.stopFns.push(() => this.d.room.overlays.unobserveDeep(onOverlays as never))
    const onGraphs = (event: { keysChanged: Set<string> }) => {
      for (const person of event.keysChanged) if (person !== this.d.me.name) this.queueObserved(person)
    }
    this.d.room.graphs.observe(onGraphs)
    this.stopFns.push(() => this.d.room.graphs.unobserve(onGraphs))
    const onClaims = () => this.checkAllObserved()
    this.d.room.claims.observe(onClaims)
    this.stopFns.push(() => this.d.room.claims.unobserve(onClaims))
    this.checkAllObserved()
  }

  stop(): void {
    for (const f of this.stopFns) f()
    this.stopFns = []
    for (const t of [...this.timers.values(), ...this.observedTimers.values()]) clearTimeout(t)
    this.timers.clear()
    this.observedTimers.clear()
    if (this.mergeTimer) clearTimeout(this.mergeTimer)
    this.mergeTimer = null
    this.mergeQueue.clear()
    if (this.integrationTimer) clearTimeout(this.integrationTimer)
    this.integrationTimer = null
  }

  /** Debounced per (person, path): a burst of keystrokes becomes one check. */
  private schedule(person: string, p: string): void {
    const key = `${person}|${p}`
    const prev = this.timers.get(key)
    if (prev) clearTimeout(prev)
    const t = setTimeout(() => { this.timers.delete(key); void this.check(person, p) }, this.d.debounceMs ?? 2000)
    t.unref?.()
    this.timers.set(key, t)
  }

  /** Runs every check for a (person, path) pair now; tests call this instead of waiting. */
  async flush(): Promise<void> {
    const keys = Array.from(this.timers.keys())
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    for (const key of keys) { const [person, p] = key.split('|'); await this.check(person, p) }
    await this.drainMerges()
    for (const [person, t] of this.observedTimers) { clearTimeout(t); this.observedTimers.delete(person); this.runObserved(person) }
    while (this.observedChecks.size) await Promise.all(this.observedChecks)
    this.reportIntegrations()
  }

  private checkAllObserved(): void {
    for (const person of this.d.room.graphs.keys()) if (person !== this.d.me.name) this.queueObserved(person)
    const worker = this.workerRecord()
    if (worker?.lead && !this.d.room.graphs.has(worker.lead)) this.queueObserved(worker.lead)
  }

  private workerRecord() {
    return [...this.d.room.workers.values()].find(worker => worker.name === this.d.me.name &&
      (!process.env.ROOM_WORKER_ID || worker.id === process.env.ROOM_WORKER_ID))
  }

  /** My worker record when `person` is my lead and spawn carried their uncommitted work into my base. */
  private carriedWorkerFor(person: string) {
    const worker = this.workerRecord()
    const baseline = workerBaseline(worker)
    return worker?.lead === person && carriesWork(baseline) ? baseline : undefined
  }

  /** Debounced per person, like merge checks: a burst of overlay events becomes one check. */
  private queueObserved(person: string): void {
    clearTimeout(this.observedTimers.get(person))
    const t = setTimeout(() => { this.observedTimers.delete(person); this.runObserved(person) }, this.d.debounceMs ?? 2000)
    t.unref?.()
    this.observedTimers.set(person, t)
  }

  private runObserved(person: string): void {
    let work: Promise<void>
    work = Promise.resolve().then(() => this.checkObserved(person)).catch(error => {
      this.d.log?.(`contract check ${person}: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => this.observedChecks.delete(work))
    this.observedChecks.add(work)
  }

  /**
   * The lead's contract changes against my carried baseline, over carried paths and the lead's
   * changed paths, so a revert to HEAD or a commit still counts.
   */
  private async carriedChanges(baseline: Baseline, lives: Map<string, string | null | undefined>): Promise<ObservedChange[]> {
    const out: ObservedChange[] = []
    for (const [path, live] of lives) {
      const before = await baselineText(baseline, path, this.d.baseText).catch(() => undefined)
      if (before === undefined) continue
      const key = `${baseline.sha}\0${path}\0${hashText(before)}\0${live === null ? '' : hashText(live ?? '')}`
      let changes = this.observedCache.get(key)
      if (!changes) {
        await ensureLanguages([path])
        changes = observedContractChanges(before, live ?? '', path, parseFile).map(change => ({ path, ...change }))
        if (this.observedCache.size >= 1000) this.observedCache.delete(this.observedCache.keys().next().value!)
        this.observedCache.set(key, changes)
      }
      out.push(...changes)
    }
    return out
  }

  private async checkObserved(person: string): Promise<void> {
    const snapshot: GraphSnapshot | undefined = this.d.room.graphs.get(person)
    const carried = this.carriedWorkerFor(person)
    if (!snapshot && !carried) return
    const mine = new Set([
      ...this.d.room.changedPaths(this.d.me.name),
      ...this.d.room.openClaims().filter(claim => claim.by === this.d.me.name).map(claim => claim.path),
    ])
    if (!mine.size) return
    let changes = snapshot?.observed ?? []
    const mineTexts = new Map<string, string | null | undefined>()
    if (carried) {
      const paths = new Set([...await carriedPaths(carried), ...this.d.room.changedPaths(person)])
      const lives = new Map<string, string | null | undefined>()
      // A path the lead no longer has (reverted to a HEAD without it, or deleted) is compared as empty; an unreadable one is skipped.
      for (const path of [...paths].sort()) await this.d.liveText(path, person).then(live => lives.set(path, live), () => undefined)
      for (const path of [...mine].sort()) mineTexts.set(path, await this.d.liveText(path, this.d.me.name).catch(() => undefined))
      const input = hashText(JSON.stringify([carried.sha, [...lives], [...mineTexts]]))
      if (this.observedInputs.get(person) === input) return
      this.observedInputs.set(person, input)
      changes = await this.carriedChanges(carried, lives)
    }
    for (const change of changes) {
      if (change.kind === 'add') continue
      const uses = carried ? (await Promise.all([...mineTexts].map(async ([path, live]) =>
        live && await consumesSymbol(path, live, change.path, change.symbol, this.d.graph?.()) ? path : undefined
      ))).filter((path): path is string => !!path).sort() : snapshot!.edges.filter(edge => edge.source === change.path && mine.has(edge.target) &&
        edge.symbols.some(symbol => bareSymbol(symbol) === bareSymbol(change.symbol))).map(edge => edge.target).sort()
      if (!uses.length) continue
      const key = `${person}\0${change.path}\0${change.symbol}\0${change.detail}`
      if (this.observedReported.has(key)) continue
      this.observedReported.add(key)
      const action = change.kind === 'signature' ? `changed the signature of ${change.symbol}()` : `deleted ${change.symbol}()`
      const consumers = uses.length === 1 ? `${uses[0]} uses it` : `${uses.join(', ')} use it`
      const text = `${person} ${action} in ${change.path} (${change.detail}); ${consumers}`
      this.d.room.post<ContractMsg>(ROOM, { type: 'contract', to: this.d.me.name, priority: 'notify', path: change.path, symbol: change.symbol, text })
      this.d.log?.(`contract: ${text}`)
    }
  }

  private async check(person: string, p: string): Promise<void> {
    const key = `${person}|${p}`
    if (this.inflight.has(key)) { this.schedule(person, p); return }
    this.inflight.add(key)
    try {
      if (person === this.d.me.name) await this.checkOverlap(p)
      // A change by either side to a file both have changed re-runs the preview for every other person on it.
      const me = this.d.me.name
      const people = (person === me ? this.d.room.whoChanged(p).filter(x => x !== me) : [person]).filter(x => !this.d.coLocated?.(x) && (this.d.isPresent?.(x) ?? true))
      if (this.d.room.changedPaths(me).includes(p)) for (const other of people) this.mergeQueue.set(`${other}|${p}`, { person: other, path: p })
      await this.drainMerges()
    } catch (e) {
      this.d.log?.(`conflict check ${key}: ${e instanceof Error ? e.message : String(e)}`)
    } finally { this.inflight.delete(key) }
  }

  private async checkOverlap(p: string): Promise<void> {
    const me = this.d.me
    const live = this.d.room.text(p, me.name)
    if (live === undefined) return
    const base = (await this.d.baseText(this.d.baseFor(me.name), p)) ?? ''
    const ranges = changedRanges(base, live)
    if (!ranges.length) return
    const claims = this.d.room.openClaims().filter(c => ranges.some(r => claimsOverlap(c, { path: p, ...r })))
    const mine = claims.filter(c => c.by === me.name && c.byKind === me.kind)
    for (const c of claims) {
      if (c.by === me.name && c.byKind === me.kind) continue
      if (this.d.coLocated?.(c.by)) continue
      const hit = ranges.find(r => claimsOverlap(c, { path: p, ...r }) && !mine.some(m => covers(m, p, r)))
      if (!hit) continue
      // An overlay is authoritative; the resolver also handles local workers whose
      // current file has not been published (including ignored artifacts).
      const theirs = this.d.room.text(p, c.by) ?? await this.d.liveText(p, c.by).catch(() => undefined)
      if (live === theirs) {
        if (!this.integrationReported.has(c.by)) {
          const paths = this.integrated.get(c.by) ?? new Set<string>()
          paths.add(p); this.integrated.set(c.by, paths)
          if (!this.integrationTimer) {
            this.integrationTimer = setTimeout(() => this.reportIntegrations(), this.d.debounceMs ?? 2000)
            this.integrationTimer.unref?.()
          }
        }
        continue
      }
      if (this.d.writeIntent?.(p) === false) {
        const now = (this.d.now ?? Date.now)()
        for (const [path, at] of this.externalReported) if (now - at >= 600_000) this.externalReported.delete(path)
        if (!this.externalReported.has(p)) {
          this.externalReported.set(p, now)
          this.d.room.post<NoteMsg>(ROOM, { type: 'note', to: me.name, priority: 'fyi', text: `${p} changed in your folder without a write from your session` })
        }
        continue
      }
      const k = `${p}|${c.id}`
      if (this.reported.has(k)) continue
      this.reported.add(k)
      const who = displayName({ name: c.by, kind: c.byKind })
      this.d.room.post<ConflictMsg>(ROOM, { type: 'conflict', claimId: c.id, otherClaimId: '', path: p, to: me.name, priority: 'interrupt',
        text: `you edited ${p}:${hit.from}-${hit.to} inside ${who}'s claim ${c.id} (${c.intent}); claim it or room_wait(${c.id})` })
      this.d.room.post<ConflictMsg>(ROOM, { type: 'conflict', claimId: c.id, otherClaimId: '', path: p, to: c.by, priority: 'notify',
        text: `${me.name}'s agent edited ${p}:${hit.from}-${hit.to} inside your claim ${c.id} (${c.intent}) without claiming` })
      this.d.log?.(`overlap: my edit ${p}:${hit.from}-${hit.to} inside ${c.by}'s claim ${c.id}`)
    }
  }

  private reportIntegrations(): void {
    if (this.integrationTimer) clearTimeout(this.integrationTimer)
    this.integrationTimer = null
    for (const [holder, paths] of this.integrated) {
      this.integrationReported.add(holder)
      this.d.room.post<NoteMsg>(ROOM, { type: 'note', to: this.d.me.name, priority: 'fyi',
        text: `${this.d.me.name} integrated ${paths.size} file${paths.size === 1 ? '' : 's'} of ${holder}` })
    }
    this.integrated.clear()
  }

  private async checkMerge(person: string, p: string): Promise<void> {
    if (this.d.coLocated?.(person)) return
    if (this.d.isPresent && !this.d.isPresent(person)) return
    if (!this.d.room.changedPaths(person).includes(p)) return
    const key = `${person}|${p}`
    const mine = await this.d.liveText(p, this.d.me.name).catch(() => undefined)
    const theirs = await this.d.liveText(p, person).catch(() => undefined)
    const hash = createHash('sha256').update(`${this.d.baseFor(this.d.me.name)}\0${this.d.baseFor(person)}\0${mine ?? ''}\0${theirs ?? ''}`).digest('hex')
    if (this.mergeHashes.get(key) === hash) return
    const res = await mergePath(this.d, person, p)
    if (res.status === 'unknown') return
    this.mergeHashes.set(key, hash)
    const was = this.conflicting.has(key)
    if (res.status === 'conflict' && !was) {
      this.conflicting.add(key)
      this.d.room.post<MergeConflictMsg>(ROOM, { type: 'merge-conflict', path: p, to: this.d.me.name,
        text: `your ${p} and ${person}'s now conflict around line${res.lines.length === 1 ? '' : 's'} ${res.lines.join(', ')}; room_preview_merge(${person}) for detail` })
      this.d.log?.(`preview: ${p} conflicts with ${person}'s at ${res.lines.join(', ')}`)
    } else if (res.status !== 'conflict' && was) {
      this.conflicting.delete(key)
      this.d.room.post<NoteMsg>(ROOM, { type: 'note', to: this.d.me.name, priority: 'fyi', text: `your ${p} and ${person}'s merge cleanly again` })
    }
  }

  /** Drain coalesced pairs while respecting one global rolling-window budget. */
  private async drainMerges(): Promise<void> {
    if (this.draining) return this.draining
    this.draining = (async () => {
      const now = this.d.now ?? Date.now
      const windowMs = this.d.mergeWindowMs ?? 10_000
      const budget = this.d.mergeBudget ?? 4
      while (this.mergeQueue.size) {
        const at = now()
        this.mergeStarts = this.mergeStarts.filter(t => at - t < windowMs)
        if (this.mergeStarts.length >= budget) {
          if (!this.mergeTimer) {
            const delay = Math.max(1, this.mergeStarts[0] + windowMs - at)
            this.mergeTimer = setTimeout(() => { this.mergeTimer = null; void this.drainMerges() }, delay)
            this.mergeTimer.unref?.()
          }
          break
        }
        const first = this.mergeQueue.entries().next().value as [string, { person: string; path: string }] | undefined
        if (!first) break
        this.mergeQueue.delete(first[0])
        this.mergeStarts.push(at)
        await this.checkMerge(first[1].person, first[1].path)
      }
    })().finally(() => { this.draining = null })
    return this.draining
  }
}
