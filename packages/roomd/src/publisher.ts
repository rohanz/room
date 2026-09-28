import fs from 'node:fs'
import { manifestKey, participantRecord, type RoomDoc } from '@room/shared'
import { gitHead, gitShowMany } from './git.js'
import { checkoutText, type Baseline } from './baseline.js'
import { readDisk } from './disk-scan.js'
import { publishManifest, type ManifestFact } from './manifest-publish.js'
import { authorizesText, plan, type PublicationInputs, type PublicationPlan, type PlannedEntry, type SharingPolicy } from './policy.js'
import type { DiskBatch } from './disk-batch.js'

interface Host {
  readonly dir: string
  readonly name: string
  readonly fence: string
  readonly roomDoc: RoomDoc
  readonly batch: DiskBatch
  readonly skips: { size: Set<string>; budget: Set<string>; ignore: Set<string> }
  readonly stopped: boolean
  readonly phase: string
  readonly inputs: PublicationInputs
  readonly shared: string
  readonly base: string
  readonly beforeBaseRead?: (p: string) => Promise<void>
  readonly beforePublishWrite?: (p: string) => Promise<void>
  readonly onSeedProgress?: () => void
  readonly onFullScan?: (policy: SharingPolicy, entries: ReadonlyMap<string, PlannedEntry>, unsettled: readonly string[]) => Promise<void>
  log(line: string): void
  abs(p: string): string
  isSafeRoomPath(p: string): boolean
  bumpLastActive(): void
  noteSkip(p: string, reason: string): void
  reconcileGitChanges(): Promise<void>
  carried(): Baseline | undefined
}

export interface PreparedPublication {
  readonly inputs: PublicationInputs
  readonly desired: PublicationPlan
  readonly baseTexts: ReadonlyMap<string, string | undefined>
  readonly facts: readonly ManifestFact[]
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** One publisher path: capture inputs, read disk/Git, pure plan, synchronous guarded apply. */
export class Publisher {
  private readonly excludedPaths = new Set<string>()
  private readonly errors = new Set<string>()
  private readonly oversizedCache = new Map<string, { size: number; mtimeMs: number; base: string; hash: string }>()
  private dirtyTimer?: ReturnType<typeof setTimeout>
  constructor(private readonly host: Host) {}

  pathsToReconcile(extra: Iterable<string> = []): Set<string> {
    const current = this.host.roomDoc.manifest.get(manifestKey(this.host.name, this.host.fence))
    return new Set([...current?.keys() ?? [], ...this.excludedPaths, ...extra])
  }

  stop(): void { if (this.dirtyTimer) clearTimeout(this.dirtyTimer) }

  /** Synchronous narrowing from the currently published snapshot; widening waits for readDisk. */
  applyInputs(next: PublicationInputs): void {
    const { host } = this
    const current = host.roomDoc.manifest.get(manifestKey(host.name, host.fence))
    const facts: ManifestFact[] = []
    let budget = 0
    if (next.policy.level !== 'intent' && next.policy.publisher) {
      for (const [path, entry] of [...current?.entries() ?? []].sort(([a], [b]) => a.localeCompare(b))) {
        if (next.rules.roomIgnore.ignores(path) || (entry.size !== undefined && entry.size > next.rules.sizeCap)) {
          facts.push({ path, change: entry.change, excluded: true })
          this.excludedPaths.add(path)
          continue
        }
        const permit = authorizesText(next.policy, path)
        const text = permit && entry.change !== 'D' && entry.state === 'shared' ? host.roomDoc.overlayText(host.name, path)?.toString() : undefined
        if (text !== undefined && budget + Buffer.byteLength(text) > next.rules.budget) {
          facts.push({ path, change: entry.change, excluded: true })
          this.excludedPaths.add(path)
          continue
        }
        if (text !== undefined) budget += Buffer.byteLength(text)
        facts.push({ path, change: entry.change, ...(permit ? { hash: entry.hash, size: entry.size, baseHash: entry.baseHash } : {}),
          ...(text !== undefined ? { text } : {}), binary: entry.held === 'binary', at: entry.at })
      }
      for (const path of this.excludedPaths) if (!facts.some(f => f.path === path)) facts.push({ path, change: 'M', excluded: true })
    }
    host.roomDoc.doc.transact(() => {
      publishManifest({ room: host.roomDoc, name: host.name, fence: host.fence, base: next.head, level: next.policy.level,
        prefixes: next.policy.textPrefixes, complete: host.roomDoc.manifestHead.get(host.name)?.complete ?? false,
        ...(next.policy.publisher ? {} : { publisher: next.policy.publisherName ?? 'another session' }) }, facts)
      for (const path of host.roomDoc.changedPaths(host.name)) {
        if (facts.some(f => f.path === path && f.text !== undefined || f.path === path && f.change === 'D' && !f.excluded)) continue
        host.roomDoc.clearOverlay(host.name, path, host)
        host.roomDoc.unmarkDeleted(host.name, path, host)
      }
      host.roomDoc.reconcileBaseTexts(host.name, host)
    }, host)
    this.markDirty()
  }

  reconcileFailed(error: unknown): void {
    const text = message(error)
    if (!this.errors.has(text)) { this.errors.add(text); this.host.log(`warn: ${text}`) }
    this.markDirty()
  }

  markDirty(): void {
    if (this.host.stopped || this.dirtyTimer) return
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = undefined
      if (!this.host.stopped) void this.host.reconcileGitChanges()
    }, 5000)
    this.dirtyTimer.unref?.()
  }

  /** Prepare against a resolved base, including committed but unpushed changes. */
  async prepare(inputs = this.host.inputs): Promise<PreparedPublication> {
    const carried = this.host.carried()
    const disk = await readDisk(this.host.dir, inputs, this.pathsToReconcile(), p => this.host.isSafeRoomPath(p), this.oversizedCache, carried?.untracked)
    for (const item of disk) await this.host.beforeBaseRead?.(item.path)
    const desired = plan(inputs, disk, this.host.roomDoc.ensureRoomSalt())
    const textPaths = [...desired.entries].filter(([p, entry]) => entry.state === 'shared' && authorizesText(inputs.policy, p)).map(([p]) => p)
    const baseTexts = await gitShowMany(this.host.dir, this.host.shared || inputs.head, textPaths)
    for (const p of textPaths) {
      const sha = carried?.untracked.get(p)?.sha
      if (sha) baseTexts.set(p, await checkoutText(this.host.dir, sha, p))
    }
    const facts: ManifestFact[] = []
    for (const [path, entry] of desired.entries) facts.push({ path, change: entry.change, hash: entry.hash, size: entry.size, baseHash: entry.baseHash, text: entry.text, binary: entry.held === 'binary', at: entry.at })
    for (const path of desired.excludedPaths) facts.push({ path, change: 'M', excluded: true })
    return { inputs, desired, baseTexts, facts }
  }

  /** Final synchronous gate; called immediately before the Y transaction. */
  valid(prepared: PreparedPublication): boolean {
    const { host } = this
    if (host.stopped || host.inputs !== prepared.inputs) return false
    const holder = participantRecord(host.roomDoc, host.name)?.holder
    if (holder && holder.sessionId !== host.fence) return false
    for (const p of prepared.desired.textPaths) {
      const entry = prepared.desired.entries.get(p)!
      try {
        const stat = fs.lstatSync(host.abs(p))
        if (!stat.isFile() || !host.isSafeRoomPath(p) || stat.size !== entry.size) return false
        if (fs.readFileSync(host.abs(p), 'utf8') !== entry.text) return false
      } catch { return false }
    }
    return true
  }

  /** May run inside an outer HEAD-transition transaction; Yjs nests it into the same transaction. */
  apply(prepared: PreparedPublication, complete: boolean): boolean {
    if (!this.valid(prepared)) { this.markDirty(); return false }
    const { host } = this
    const { desired, inputs } = prepared
    host.roomDoc.doc.transact(() => {
      publishManifest({ room: host.roomDoc, name: host.name, fence: host.fence, base: inputs.head, level: inputs.policy.level,
        prefixes: inputs.policy.textPrefixes, complete, ...(inputs.policy.publisher ? {} : { publisher: inputs.policy.publisherName ?? 'another session' }) }, prepared.facts)
      const old = new Set(host.roomDoc.changedPaths(host.name))
      for (const p of old) {
        if (desired.entries.get(p)?.state === 'shared') continue
        host.roomDoc.clearOverlay(host.name, p, host)
        host.roomDoc.unmarkDeleted(host.name, p, host)
      }
      for (const [p, entry] of desired.entries) {
        if (entry.state !== 'shared') continue
        if (entry.change === 'D') {
          host.roomDoc.markDeleted(host.name, p, host)
          host.roomDoc.clearOverlay(host.name, p, host)
        } else if (entry.text !== undefined) {
          host.roomDoc.unmarkDeleted(host.name, p, host)
          host.roomDoc.setOverlay(host.name, p, entry.text, host)
        }
        const base = prepared.baseTexts.get(p)
        if (base !== undefined) host.roomDoc.setBaseText(host.name, host.shared || inputs.head, p, base, host)
      }
      host.roomDoc.reconcileBaseTexts(host.name, host)
    }, host)
    this.excludedPaths.clear()
    for (const p of desired.excludedPaths) this.excludedPaths.add(p)
    const previousSkips = new Set([...host.skips.size, ...host.skips.budget, ...host.skips.ignore])
    host.skips.size.clear(); host.skips.budget.clear(); host.skips.ignore.clear()
    for (const [p, reason] of desired.excludedReasons) if (reason === 'size') host.skips.size.add(p)
    else if (reason === 'budget') host.skips.budget.add(p)
    else host.skips.ignore.add(p)
    for (const [p, reason] of desired.excludedReasons) if (!previousSkips.has(p)) host.noteSkip(p, reason === 'size' ? 'over size cap' : reason === 'budget' ? 'over total budget' : 'ignore')
    this.errors.clear()
    for (const p of desired.textPaths) host.batch.published(p)
    if (desired.entries.size || desired.excluded.length) host.bumpLastActive()
    return true
  }

  async reconcile(_paths: Iterable<string> | 'all' = 'all', complete = true): Promise<PreparedPublication | undefined> {
    try {
      const prepared = await this.prepare(this.host.inputs)
      for (const p of prepared.desired.textPaths) {
        await this.host.beforePublishWrite?.(p)
        if (this.host.phase === 'seed' || this.host.phase === 'watch') this.host.onSeedProgress?.()
      }
      if (await gitHead(this.host.dir) !== this.host.base) throw new Error('HEAD moved during publication')
      if (!this.apply(prepared, complete)) return undefined
      if (complete) await this.host.onFullScan?.(prepared.inputs.policy, prepared.desired.entries, prepared.desired.unsettled)
      if (this.host.phase === 'seed' || this.host.phase === 'watch') this.host.onSeedProgress?.()
      return prepared
    } catch (error) { this.reconcileFailed(error); return undefined }
  }
}
