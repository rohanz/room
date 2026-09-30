import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { containsPath, normalizeCoordinationPath, repoRoomOf } from '@room/shared'
import { commonGitDirFromDotGit, gitCommonDir, worktreeGitDirFromDotGit, type ShareLevel } from '@room/roomd'
import { policyFromLevel, type SharingPolicy } from '@room/roomd/policy'
import { writeAtomic } from './leases.js'
import { choiceFile, removeSharingChoice } from './choice.js'

interface Grant { active: string[]; ending: string[]; retained: string[] }
interface SharingRecord {
  v: 1
  room: string
  participant: string
  worktree: string
  requested: ShareLevel
  declared: Grant
  disclosed: { level: ShareLevel; version: number }
  updatedAt: number
}

const emptyGrant = (): Grant => ({ active: [], ending: [], retained: [] })
const sorted = (items: Iterable<string>) => [...new Set(items)].sort()
const clean = (items: readonly string[]) => sorted(items.map(p => {
  const normal = normalizeCoordinationPath(p)
  return p.endsWith('/') && normal !== '.' ? `${normal}/` : normal
}).filter(p => p !== '' && p !== '..'))

export async function sharingFile(dir: string, room: string, participant: string): Promise<string> {
  const hash = createHash('sha256').update(room).update('\0').update(participant).digest('hex')
  return path.join(await gitCommonDir(dir), 'room', 'sharing', `${hash}.json`)
}

export class PolicyStore {
  private queue: Promise<unknown> = Promise.resolve()
  private ceiling: ShareLevel = 'full'
  private publisher = true
  private publisherName?: string
  private onChange?: (policy: SharingPolicy) => void
  private currentPolicy!: SharingPolicy
  private constructor(private readonly file: string, private record: SharingRecord) {}

  static async open({ dir, room, participant, server, requested = 'full', ceiling = 'full', publisher = true, onChange }: {
    dir: string; room: string; participant: string; server?: string; requested?: ShareLevel; ceiling?: ShareLevel; publisher?: boolean; onChange?: (policy: SharingPolicy) => void
  }): Promise<PolicyStore> {
    const worktree = fs.realpathSync(dir)
    const file = await sharingFile(dir, room, participant)
    let record: SharingRecord | undefined
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')) as SharingRecord }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (record && (record.v !== 1 || record.room !== room || record.participant !== participant)) throw new Error(`invalid sharing record ${file}`)
    if (!record) {
      let legacy: { share?: unknown; warned?: unknown; warnedLevels?: Record<string, ShareLevel> } = {}
      let unreadable = false
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(await choiceFile(dir), 'utf8'))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) unreadable = true
        else legacy = parsed as typeof legacy
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadable = true }
      const priorLevel = legacy.share === 'full' || legacy.share === 'declared' || legacy.share === 'intent' ? legacy.share : undefined
      const uncertain = unreadable || legacy.share !== undefined && !priorLevel || legacy.warned !== undefined && legacy.share === undefined || legacy.warnedLevels !== undefined && legacy.share === undefined
      if (uncertain) console.warn('[room] legacy sharing choice is unreadable or ambiguous; using intent-only sharing')
      const previousDisclosure = legacy.warnedLevels?.[`${worktree}#${server ?? ''}`]
      record = { v: 1, room, participant, worktree, requested: priorLevel ?? (uncertain ? 'intent' : requested), declared: emptyGrant(),
        disclosed: { level: previousDisclosure === 'intent' || previousDisclosure === 'declared' || previousDisclosure === 'full' ? previousDisclosure : 'intent', version: previousDisclosure ? 1 : 0 }, updatedAt: Date.now() }
      // The old file is a migration input only. The new record is durable before it is removed.
      writeAtomic(file, record)
      if (legacy.share !== undefined || legacy.warned !== undefined || legacy.warnedLevels !== undefined) await removeSharingChoice(dir)
    } else if (record.worktree !== worktree) {
      record = { ...record, worktree, declared: emptyGrant(), updatedAt: Date.now() }
      writeAtomic(file, record)
    }
    // Idempotent local migration: a crash after the new record write can replay the old path set.
    const privateGit = worktreeGitDirFromDotGit(dir)
    for (const name of fs.readdirSync(privateGit).filter(n => n === 'room-retained-declared.json' || /^room-retained-declared-[a-f0-9]{64}\.json$/.test(n))) {
      const oldFile = path.join(privateGit, name)
      let legacy: { room?: string; participant?: string; server?: string; paths?: unknown }
      try { legacy = JSON.parse(fs.readFileSync(oldFile, 'utf8')) as typeof legacy } catch { continue }
      const sameRoom = legacy.room === room || repoRoomOf(legacy.room ?? '', candidate => candidate === room) === room
      if (!sameRoom || legacy.participant !== participant || (server && legacy.server !== server) || !Array.isArray(legacy.paths)) continue
      const retained = clean([...record.declared.retained, ...legacy.paths.filter((p): p is string => typeof p === 'string')])
      record = { ...record, declared: { ...record.declared, retained }, updatedAt: Date.now() }
      writeAtomic(file, record)
      fs.rmSync(oldFile, { force: true })
    }
    const store = new PolicyStore(file, record)
    store.ceiling = ceiling
    store.publisher = publisher
    store.onChange = onChange
    store.rebuild()
    return store
  }

  private rebuild(): SharingPolicy {
    const { requested, declared } = this.record
    this.currentPolicy = Object.freeze({ ...policyFromLevel(requested, sorted([...declared.active, ...declared.ending, ...declared.retained]), this.ceiling, this.publisher), ending: Object.freeze([...declared.ending]), ...(this.publisherName ? { publisherName: this.publisherName } : {}) })
    this.onChange?.(this.currentPolicy)
    return this.currentPolicy
  }
  get policy(): SharingPolicy { return this.currentPolicy }

  get requested(): ShareLevel { return this.record.requested }
  get disclosed(): Readonly<SharingRecord['disclosed']> { return this.record.disclosed }
  get retained(): readonly string[] { return this.record.declared.retained }

  private update(fn: (current: SharingRecord) => SharingRecord, rebuild = true): Promise<SharingPolicy> {
    const operation = this.queue.then(() => {
      const next = fn(this.record)
      if (next === this.record) return this.policy
      writeAtomic(this.file, next)
      this.record = next
      return rebuild ? this.rebuild() : this.policy
    })
    this.queue = operation.catch(() => {})
    return operation
  }

  setRequested(requested: ShareLevel): Promise<SharingPolicy> {
    return this.update(old => old.requested === requested ? old : { ...old, requested,
      declared: requested === 'declared' ? old.declared : { ...old.declared, ending: [], retained: [] }, updatedAt: Date.now() })
  }

  declare(paths: readonly string[]): Promise<SharingPolicy> {
    const active = clean(paths)
    return this.update(old => {
      const ending = sorted([...old.declared.ending, ...old.declared.active.filter(p => !active.includes(p))]).filter(p => !active.includes(p))
      return { ...old, declared: { ...old.declared, active, ending }, updatedAt: Date.now() }
    })
  }

  /** Runs only after an unthrottled full scan planned under this exact policy object. */
  settle(input: SharingPolicy, entries: ReadonlyMap<string, { state: string; change: string }>, unsettled: readonly string[]): Promise<SharingPolicy> {
    return this.update(old => {
      if (this.policy !== input) return old
      const ending = old.declared.ending.filter(prefix => !input.ending.includes(prefix) || unsettled.some(p => containsPath(prefix, p)))
      const retained = new Set(old.declared.retained.filter(p => entries.has(p) || unsettled.includes(p)))
      for (const prefix of old.declared.ending) {
        if (!input.ending.includes(prefix) || ending.includes(prefix)) continue
        for (const [p, entry] of entries) if (containsPath(prefix, p) && (entry.state === 'shared' || entry.change === 'D')) retained.add(p)
      }
      if (ending.length === old.declared.ending.length && retained.size === old.declared.retained.length && [...retained].every(p => old.declared.retained.includes(p))) return old
      return { ...old, declared: { ...old.declared, ending, retained: sorted(retained) }, updatedAt: Date.now() }
    })
  }

  setCeiling(ceiling: ShareLevel): SharingPolicy {
    if (ceiling !== this.ceiling) { this.ceiling = ceiling; this.rebuild() }
    return this.policy
  }

  setPublisher(publisher: boolean, publisherName?: string): SharingPolicy {
    if (publisher !== this.publisher || publisherName !== this.publisherName) {
      this.publisher = publisher; this.publisherName = publisherName; this.rebuild()
    }
    return this.policy
  }

  markDisclosed(level: ShareLevel, version: number): Promise<SharingPolicy> {
    return this.update(old => ({ ...old, disclosed: { level, version }, updatedAt: Date.now() }), false)
  }

  static retire(dir: string, room: string, participant: string, server?: string): void {
    const hash = createHash('sha256').update(room).update('\0').update(participant).digest('hex')
    const file = path.join(commonGitDirFromDotGit(dir), 'room', 'sharing', `${hash}.json`)
    fs.rmSync(file, { force: true })
    const privateGit = worktreeGitDirFromDotGit(dir)
    for (const name of fs.readdirSync(privateGit).filter(n => n === 'room-retained-declared.json' || /^room-retained-declared-[a-f0-9]{64}\.json$/.test(n))) {
      const legacyFile = path.join(privateGit, name)
      let legacy: { room?: string; participant?: string; server?: string }
      try { legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8')) as typeof legacy } catch { continue }
      const sameRoom = legacy.room === room || repoRoomOf(legacy.room ?? '', candidate => candidate === room) === room
      if (sameRoom && legacy.participant === participant && (!server || legacy.server === server)) fs.rmSync(legacyFile, { force: true })
    }
  }
}

/** One server ceiling source; each subscribed PolicyStore receives a new immutable policy. */
export class CeilingSource {
  private readonly stores = new Set<PolicyStore>()
  private current: ShareLevel
  constructor(readonly server: string, initial: ShareLevel = 'full') { this.current = initial }
  get level(): ShareLevel { return this.current }
  subscribe(store: PolicyStore): () => void {
    this.stores.add(store)
    store.setCeiling(this.current)
    return () => { this.stores.delete(store) }
  }
  set(level: ShareLevel): void {
    this.current = level
    for (const store of this.stores) store.setCeiling(level)
  }
  async refresh(fetcher: typeof fetch = fetch): Promise<ShareLevel> {
    const http = this.server.replace(/^ws/, 'http')
    const response = await fetcher(`${http}/auth/config`)
    if (!response.ok) throw new Error(`sharing ceiling: HTTP ${response.status}`)
    const data = await response.json() as { shareMax?: ShareLevel }
    this.set(data.shareMax === 'intent' || data.shareMax === 'declared' || data.shareMax === 'full' ? data.shareMax : 'intent')
    return this.current
  }
}
