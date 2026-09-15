import { displayName } from '@room/shared'
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
import type { Claim, ConflictMsg, Identity, NoteMsg, RoomDoc } from '@room/shared'
import { gitMergeFile } from './merge.js'

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

const overlaps = (a: Range, b: Range) => a.from <= b.to && b.from <= a.to
const covers = (c: Claim, r: Range) => c.from <= r.from && c.to >= r.to

export interface MergeResult { status: 'clean' | 'one-side' | 'conflict' | 'unknown'; lines: number[] }

/** Would my live version of `path` and theirs merge? Line numbers are where conflicts start. */
export async function mergePath(d: ConflictDeps, person: string, path: string): Promise<MergeResult> {
  const myBase = d.baseFor(d.me.name), theirBase = d.baseFor(person)
  let ancestor = myBase
  if (theirBase !== myBase) {
    try { ancestor = await d.mergeBase(myBase, theirBase) } catch { return { status: 'unknown', lines: [] } }
  }
  const b = (await d.baseText(ancestor, path)) ?? ''
  let m: string | undefined | null, t: string | undefined | null
  try { m = await d.liveText(path, d.me.name); t = await d.liveText(path, person) } catch { return { status: 'unknown', lines: [] } }
  const mineT = m === null ? '' : m ?? b, theirs = t === null ? '' : t ?? b
  if (mineT === b || theirs === b) return { status: 'one-side', lines: [] }
  const res = await gitMergeFile(b, mineT, theirs, { ours: d.me.name, base: 'base', theirs: person })
  const lines = res.conflicts.map(c => c.from)
  return { status: lines.length ? 'conflict' : 'clean', lines }
}

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
    }
    this.d.room.overlays.observeDeep(onOverlays as never)
    this.stopFns.push(() => this.d.room.overlays.unobserveDeep(onOverlays as never))
  }

  stop(): void {
    for (const f of this.stopFns) f()
    this.stopFns = []
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    if (this.mergeTimer) clearTimeout(this.mergeTimer)
    this.mergeTimer = null
    this.mergeQueue.clear()
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
  }

  private async check(person: string, p: string): Promise<void> {
    const key = `${person}|${p}`
    if (this.inflight.has(key)) { this.schedule(person, p); return }
    this.inflight.add(key)
    try {
      if (person === this.d.me.name) await this.checkOverlap(p)
      // A change by either side to a file both have changed re-runs the preview for every other person on it.
      const me = this.d.me.name
      const people = (person === me ? this.d.room.whoChanged(p).filter(x => x !== me) : [person]).filter(x => this.d.isPresent?.(x) ?? true)
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
    const claims = this.d.room.openClaims().filter(c => c.path === p)
    const mine = claims.filter(c => c.by === me.name && c.byKind === me.kind)
    for (const c of claims) {
      if (c.by === me.name && c.byKind === me.kind) continue
      const hit = ranges.find(r => overlaps(r, { from: c.from, to: c.to }) && !mine.some(m => covers(m, r)))
      if (!hit) continue
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

  private async checkMerge(person: string, p: string): Promise<void> {
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
      this.d.room.post<NoteMsg>(ROOM, { type: 'note', to: this.d.me.name, priority: 'notify',
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
