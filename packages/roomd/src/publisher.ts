import fs from 'node:fs'
import { scopeCovers, type RoomDoc } from '@room/shared'
import { baselineText, type Baseline } from './baseline.js'
import { git, gitBlobInfoMany, gitChanged, gitHead, gitShow, gitShowMany, type GitBlobInfo } from './git.js'
import type { DiskBatch } from './disk-batch.js'
import { clampShare, type ShareLevel } from './share-level.js'

const TRACKED_ONLY_LOCKFILES = new Set(['uv.lock', 'poetry.lock', 'Pipfile.lock', 'pdm.lock', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'go.sum'])

const errMsg = (error: unknown): string => error instanceof Error ? error.message : String(error)
class ReportedFailure extends Error {
  constructor(original: unknown) { super(errMsg(original)) }
}

/** Eligible paths eventually converge to disk state compared with HEAD text, or the
 * carried baseline for a carried untracked file. HEAD is checked once per reconcile
 * batch; pollHead reseeds after later moves. Stopped guards prevent late writes and
 * generation guards prevent writes across sharing changes. */
export interface EligibilityFacts {
  ignored: boolean
  safe: boolean
  level: ShareLevel
  inScope: boolean
  retained: boolean
  withinSize: boolean
  withinBudget: boolean
}

export type Eligibility = { share: true } | { share: false; reason: 'ignore' | 'unsafe' | 'level' | 'scope' | 'size' | 'budget' }

/** One decision for whether a path may have an overlay or deletion mark. */
export function eligibility(facts: EligibilityFacts): Eligibility {
  if (facts.ignored) return { share: false, reason: 'ignore' }
  if (!facts.safe) return { share: false, reason: 'unsafe' }
  if (facts.level === 'intent') return { share: false, reason: 'level' }
  if (facts.level === 'declared' && !facts.inScope && !facts.retained) return { share: false, reason: 'scope' }
  if (!facts.withinSize) return { share: false, reason: 'size' }
  if (!facts.withinBudget) return { share: false, reason: 'budget' }
  return { share: true }
}

interface PublicationHost {
  readonly dir: string
  readonly name: string
  readonly roomDoc: RoomDoc
  readonly skips: { size: Set<string>; budget: Set<string>; ignore: Set<string>; share: Set<string> }
  readonly batch: DiskBatch
  readonly sizeCap: number
  readonly totalBudget: number
  readonly shareCeiling?: () => ShareLevel
  readonly beforePublishWrite?: (relpath: string) => Promise<void>
  readonly beforeBaseRead?: (relpath: string) => Promise<void>
  readonly retrySchedule: (run: () => void, delayMs: number) => () => void
  readonly phase: string
  readonly onSeedProgress?: () => void
  readonly stopped: boolean
  readonly sharingGeneration: number
  readonly publishUnder?: string
  readonly base: string
  readonly shared: string
  readonly share: ShareLevel
  log(line: string): void
  abs(relpath: string): string
  isTracked(relpath: string): boolean
  isSafeRoomPath(relpath: string): boolean
  scheduleDisk(relpath: string, isNew: boolean): void
  noteSkip(relpath: string, reason: string): void
  skipIgnored(relpath: string, reason: string): void
  bumpLastActive(): void
  enqueue(work: () => Promise<void>): Promise<void>
  reconcileGitChanges(): Promise<void>
  choosePublisher(): void
  setEffectiveShare(level: ShareLevel): void
  scopePaths(): string[]
  carried(): Baseline | undefined
}

export class Publisher {
  constructor(private readonly host: PublicationHost) {}
  stopRetry(): void { this.retryTimer?.() }
  setRetained(paths: Set<string>): void { this.retainedDeclaredPaths = paths }
  retainedDeclared(): string[] { return [...this.retainedDeclaredPaths].sort() }
  clearRetained(): void { this.retainedDeclaredPaths.clear() }
  private oversizedCache = new Map<string, { size: number; mtimeMs: number; base: string; changed: boolean; hash?: string }>()
  private retryTimer?: () => void
  private retryDelayMs = 1000
  private reconcileDirty = false
  private readonly inFlightPaths = new Map<string, number>()
  private sharingDirty = false
  /** Changed paths whose declared scope ended; they stay shared while they differ from base. */
  private retainedDeclaredPaths: Set<string> = new Set<string>()
  retainLeavingScope(oldPaths: string[], nextPaths: string[]): void {
    if (!oldPaths.length || this.host.publishUnder) return
    const known = new Set([...this.host.roomDoc.changedPaths(this.host.name), ...this.host.roomDoc.deletedFor(this.host.name).keys(), ...this.host.skips.share, ...this.host.batch.knownPaths(), ...this.inFlightPaths.keys()])
    for (const relpath of known) {
      if (scopeCovers({ paths: oldPaths }, relpath) && !scopeCovers({ paths: nextPaths }, relpath)) this.retainedDeclaredPaths.add(relpath)
    }
  }

  /** Published state (possibly left over from an earlier daemon session), recorded skips, plus the given paths. */
  pathsToReconcile(extra: Iterable<string> = []): Set<string> {
    return new Set([
      ...this.host.roomDoc.changedPaths(this.host.name),
      ...this.host.skips.size, ...this.host.skips.budget, ...this.host.skips.share,
      ...this.host.roomDoc.deletedFor(this.host.name).keys(),
      ...this.retainedDeclaredPaths,
      ...extra,
    ])
  }

  /** May this file's text (or its deletion) be published at the current level? */
  isShared(relpath: string): boolean {
    const allowed = clampShare(this.host.share, this.host.shareCeiling?.() ?? 'full')
    if (allowed !== this.host.share) this.host.setEffectiveShare(allowed)
    return this.sharedAtCurrentLevel(relpath)
  }

  sharedAtCurrentLevel(relpath: string): boolean {
    return eligibility(this.eligibilityFacts(relpath)).share
  }

  eligibilityFacts(relpath: string) {
    return {
      ignored: false, safe: true, level: this.host.share,
      inScope: scopeCovers({ paths: this.host.scopePaths() }, relpath),
      retained: this.retainedDeclaredPaths.has(relpath),
      withinSize: true, withinBudget: true,
    }
  }

  /** Re-evaluate changed files against the current sharing level. */
  async resharePaths(): Promise<void> {
    if (this.host.stopped) return
    const changed = await gitChanged(this.host.dir).catch(error => { throw this.reportFailure(error) })
    await this.reconcile(changed)
  }

  /** Read UTF-8 text; undefined for missing, binary, or over-cap files. */
  private readText(relpath: string, quiet = false): string | undefined {
    try {
      const stat = fs.lstatSync(this.host.abs(relpath))
      if (!this.host.isSafeRoomPath(relpath) || stat.isSymbolicLink()) return undefined
      if (!stat.isFile()) return undefined
      const size = eligibility({ ...this.eligibilityFacts(relpath), level: 'full', withinSize: stat.size <= this.host.sizeCap })
      if (!size.share && size.reason === 'size') {
        if (!this.host.skips.size.has(relpath) && !quiet) this.host.noteSkip(relpath, 'over size cap')
        this.host.skips.size.add(relpath)
        return undefined
      }
      this.host.skips.size.delete(relpath)
      const bytes = fs.readFileSync(this.host.abs(relpath))
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        if (!quiet) this.host.skipIgnored(relpath, 'not UTF-8')
        return undefined
      }
    } catch {
      return undefined
    }
  }

  /** Withdraw a file from the room without touching disk; remembers it as withheld when it differs from base. */
  withhold(relpath: string, changed: boolean): void {
    const had = this.host.roomDoc.overlayText(this.host.name, relpath) !== undefined || (this.host.roomDoc.deleted.get(this.host.name)?.has(relpath) ?? false)
    this.host.roomDoc.doc.transact(() => {
      if (had) {
        this.host.roomDoc.clearOverlay(this.host.name, relpath, this.host)
        this.host.roomDoc.unmarkDeleted(this.host.name, relpath, this.host)
      }
      this.host.roomDoc.reconcileBaseTexts(this.host.name, this.host)
    }, this.host)
    if (had) this.host.log(`withdrew ${relpath} overlay (sharing ${this.host.share})`)
    this.retainedDeclaredPaths.delete(relpath)
    if (changed) this.host.skips.share.add(relpath)
    else this.host.skips.share.delete(relpath)
  }

  /** Withdraw a path when an ignore rule excludes it, including deletion marks. */
  withdrawIgnored(relpath: string, reason: string): void {
    const had = this.host.roomDoc.overlayText(this.host.name, relpath) !== undefined || (this.host.roomDoc.deleted.get(this.host.name)?.has(relpath) ?? false)
    if (had) {
      this.host.roomDoc.doc.transact(() => { this.host.roomDoc.clearOverlay(this.host.name, relpath, this.host); this.host.roomDoc.unmarkDeleted(this.host.name, relpath, this.host); this.host.roomDoc.reconcileBaseTexts(this.host.name, this.host) }, this.host)
      this.host.log(`withdrew ${relpath} (${reason})`)
    }
    this.retainedDeclaredPaths.delete(relpath)
    this.host.skips.share.delete(relpath)
    this.host.skipIgnored(relpath, reason)
  }

  /** Bytes of overlay text this person currently shares, excluding one path (about to be replaced). */
  sharedBytes(except: string): number {
    let total = 0
    for (const [relpath, text] of this.host.roomDoc.overlay(this.host.name)) if (relpath !== except) total += text.length
    return total
  }

  trackPaths(paths: Iterable<string>): () => void {
    const held = [...paths]
    for (const p of held) this.inFlightPaths.set(p, (this.inFlightPaths.get(p) ?? 0) + 1)
    return () => {
      for (const p of held) {
        const n = this.inFlightPaths.get(p) ?? 0
        if (n <= 1) this.inFlightPaths.delete(p)
        else this.inFlightPaths.set(p, n - 1)
      }
    }
  }

  reconcileFailed(error: unknown): void {
    if (error instanceof ReportedFailure) return
    this.host.log(`warn: ${errMsg(error)}`)
    if (this.host.stopped) return
    this.reconcileDirty = true
    if (this.retryTimer) return
    const delay = this.retryDelayMs
    this.retryDelayMs = Math.min(delay * 2, 30_000)
    this.retryTimer = this.host.retrySchedule(() => {
      this.retryTimer = undefined
      if (!this.host.stopped) void this.host.reconcileGitChanges()
    }, delay)
  }

  private reportFailure(error: unknown): ReportedFailure {
    this.reconcileFailed(error)
    return new ReportedFailure(error)
  }

  reconciled(): void {
    if (!this.reconcileDirty) return
    this.reconcileDirty = false
    this.retryDelayMs = 1000
    this.retryTimer?.()
    this.retryTimer = undefined
  }

  /** Publish disk state for these paths and published paths, reading base texts in one git process. */
  async reconcile(extra: Iterable<string>): Promise<void> {
    if (this.host.stopped) return
    const generation = this.host.sharingGeneration
    const paths = Array.from(this.pathsToReconcile(extra))
    const release = this.trackPaths(paths)
    try {
      const base = this.host.base, shared = this.host.shared
      const oversized = paths.filter(p => {
        try { const stat = fs.lstatSync(this.host.abs(p)); return stat.isFile() && stat.size > this.host.sizeCap } catch { return false }
      })
      const oversizedSet = new Set(oversized)
      const ordinary = paths.filter(p => !oversizedSet.has(p))
      const [texts, sharedTexts, blobs] = await Promise.all([
        gitShowMany(this.host.dir, base, ordinary),
        shared === base ? undefined : gitShowMany(this.host.dir, shared, ordinary),
        gitBlobInfoMany(this.host.dir, base, oversized),
      ])
      // One HEAD check per batch: a move since the read is left to pollHead, which reseeds against the new HEAD.
      if (this.host.stopped) return
      if (generation !== this.host.sharingGeneration) { this.markSharingDirty(); return }
      if (await gitHead(this.host.dir) !== base) return
      if (generation !== this.host.sharingGeneration) { this.markSharingDirty(); return }
      for (const relpath of paths) {
        if (this.host.stopped) return
        if (generation !== this.host.sharingGeneration) { this.markSharingDirty(); return }
        await this.publishDiskState(relpath, { base, texts, shared, sharedTexts, blobs })
        if (this.host.phase === 'seed' || this.host.phase === 'watch') this.host.onSeedProgress?.()
      }
      if (generation !== this.host.sharingGeneration) this.markSharingDirty()
      else this.reconciled()
    } catch (error) { throw this.reportFailure(error) }
    finally { release() }
  }

  markSharingDirty(): void {
    if (this.host.stopped || this.sharingDirty) return
    this.sharingDirty = true
    void this.host.enqueue(async () => {
      this.sharingDirty = false
      await this.resharePaths()
    })
  }

  /** `read` holds base texts at `read.base` and `read.shared`, after the batch HEAD check in reconcile. */
  async publishDiskState(relpath: string, read?: { base: string; texts: Map<string, string | undefined>; shared: string; sharedTexts?: Map<string, string | undefined>; blobs?: Map<string, GitBlobInfo | undefined> }): Promise<void> {
    if (this.host.stopped) return
    const release = this.trackPaths([relpath])
    try {
      const generation = this.host.sharingGeneration
      const sharingChanged = () => {
        if (generation === this.host.sharingGeneration) return false
        this.markSharingDirty()
        return true
      }
      this.host.choosePublisher()
      if (this.host.publishUnder) return
      this.host.skips.size.delete(relpath)
      this.host.skips.budget.delete(relpath)
      const trackedOnly = TRACKED_ONLY_LOCKFILES.has(relpath.slice(relpath.lastIndexOf('/') + 1))
      if (trackedOnly && fs.existsSync(this.host.abs(relpath)) && !this.host.isTracked(relpath)) {
        this.withdrawIgnored(relpath, 'untracked lockfile')
        return
      }
      if (trackedOnly) this.host.skips.ignore.delete(relpath)
      const safe = this.host.isSafeRoomPath(relpath)
      const pathEligibility = eligibility({ ...this.eligibilityFacts(relpath), safe })
      if (!pathEligibility.share && pathEligibility.reason === 'unsafe') {
        this.host.roomDoc.clearOverlay(this.host.name, relpath, this.host)
        this.host.roomDoc.unmarkDeleted(this.host.name, relpath, this.host)
        this.retainedDeclaredPaths.delete(relpath)
        return
      }
      if (this.host.batch.deferHot(relpath)) return
      const publishingBase = this.host.base, sharedBase = this.host.shared
      const batched = read?.base === publishingBase && read.shared === sharedBase && read.texts.has(relpath)
      const headText = () => batched ? Promise.resolve(read!.texts.get(relpath)) : gitShow(this.host.dir, publishingBase, relpath)
      const carried = this.host.carried()
      const carriedFile = carried?.untracked.has(relpath) === true
      /** What the disk is compared with: HEAD's text, or a carried untracked file's carried text (the lead's, not a worker change). */
      const baseText = async () => {
        await this.host.beforeBaseRead?.(relpath)
        return carriedFile ? baselineText(carried!, relpath, async () => undefined) : headText()
      }
      /** The base text published under baseOf: the compared text, unless baseOf is another commit or holds no carried text of its own. */
      const publishedText = async (compared: string | undefined) => {
        if (sharedBase !== publishingBase) return batched && read!.sharedTexts ? read!.sharedTexts.get(relpath) : gitShow(this.host.dir, sharedBase, relpath)
        return carriedFile && !carried!.carriedCommit ? headText() : compared
      }
      const moved = () => publishingBase !== this.host.base || sharedBase !== this.host.shared
      const headMoved = async () => !batched && await gitHead(this.host.dir) !== publishingBase
      const oversizedChanged = async () => {
        const stat = fs.statSync(this.host.abs(relpath))
        const cached = this.oversizedCache.get(relpath)
        const sameFile = cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs
        if (sameFile && cached.base === publishingBase) {
          if (!cached.changed) this.host.skips.size.delete(relpath)
          return cached.changed
        }
        const blob = read?.base === publishingBase && read.blobs?.has(relpath)
          ? read.blobs.get(relpath) : (await gitBlobInfoMany(this.host.dir, publishingBase, [relpath])).get(relpath)
        let hash = sameFile ? cached.hash : undefined
        if (blob?.size === stat.size && !hash) hash = (await git(this.host.dir, ['hash-object', '--no-filters', '--', relpath])).trim()
        const changed = !blob || blob.size !== stat.size || hash !== blob.hash
        this.oversizedCache.set(relpath, { size: stat.size, mtimeMs: stat.mtimeMs, base: publishingBase, changed, ...(hash ? { hash } : {}) })
        if (!changed) this.host.skips.size.delete(relpath)
        return changed
      }
      const exists = fs.existsSync(this.host.abs(relpath))
      const beforeText = this.host.roomDoc.text(relpath, this.host.name)
      const beforeDeleted = this.host.roomDoc.deleted.get(this.host.name)?.has(relpath) ?? false
      let droppedStale = false

      if (!exists) {
        const base = await baseText()
        if (sharingChanged()) return
        const published = base === undefined ? undefined : await publishedText(base)
        if (sharingChanged()) return
        if (this.host.stopped || moved() || await headMoved()) { this.host.scheduleDisk(relpath, true); return }
        if (sharingChanged()) return
        if (published === undefined) {
          this.host.roomDoc.doc.transact(() => {
            this.host.roomDoc.clearOverlay(this.host.name, relpath, this.host)
            this.host.roomDoc.unmarkDeleted(this.host.name, relpath, this.host)
          }, this.host)
          this.retainedDeclaredPaths.delete(relpath)
          droppedStale = beforeText !== undefined || beforeDeleted
        } else if (!this.isShared(relpath)) {
          if (sharingChanged()) return
          this.withhold(relpath, true)
          return
        } else {
          if (sharingChanged()) return
          this.host.skips.share.delete(relpath)
          this.host.roomDoc.doc.transact(() => {
            this.host.roomDoc.markDeleted(this.host.name, relpath, this.host)
            this.host.roomDoc.clearOverlay(this.host.name, relpath, this.host)
            this.host.roomDoc.setBaseText(this.host.name, sharedBase, relpath, published, this.host)
          }, this.host)
        }
      } else if (!this.isShared(relpath)) {
        if (sharingChanged()) return
        // Withheld by the sharing level: publish nothing, but remember whether it differs from base.
        const disk = this.readText(relpath, true)
        const changed = disk === undefined && this.host.skips.size.has(relpath)
          ? await oversizedChanged() : disk !== undefined && disk !== await baseText()
        if (sharingChanged()) return
        this.withhold(relpath, changed)
        return
      } else {
        if (sharingChanged()) return
        this.host.skips.share.delete(relpath)

        const disk = this.readText(relpath)
        if (disk === undefined) {
          if (this.host.skips.size.has(relpath)) await oversizedChanged()
          if (sharingChanged()) return
          this.host.roomDoc.clearOverlay(this.host.name, relpath, this.host)
          this.host.roomDoc.unmarkDeleted(this.host.name, relpath, this.host)
          this.retainedDeclaredPaths.delete(relpath)
          return
        }
        const base = await baseText()
        if (sharingChanged()) return
        const published = disk === base ? undefined : await publishedText(base)
        await this.host.beforePublishWrite?.(relpath)
        if (sharingChanged()) return
        if (this.host.stopped || this.host.publishUnder || !this.host.isSafeRoomPath(relpath) || moved() || await headMoved()) { this.host.scheduleDisk(relpath, true); return }
        if (sharingChanged()) return
        // The level or scope may have changed while we waited on git: never write text the current level withholds.
        if (!this.isShared(relpath)) { if (!sharingChanged()) this.withhold(relpath, disk !== base); return }
        if (sharingChanged()) return
        if (disk !== base && !eligibility({ ...this.eligibilityFacts(relpath), withinBudget: this.sharedBytes(relpath) + disk.length <= this.host.totalBudget }).share) {
          if (!this.host.skips.budget.has(relpath)) { this.host.skips.budget.add(relpath); this.host.noteSkip(relpath, `over the ${Math.round(this.host.totalBudget / 1024)} KB total budget`) }
          this.host.roomDoc.clearOverlay(this.host.name, relpath, this.host)
          this.host.roomDoc.unmarkDeleted(this.host.name, relpath, this.host)
          this.retainedDeclaredPaths.delete(relpath)
          return
        }
        this.host.skips.budget.delete(relpath)
        this.host.roomDoc.doc.transact(() => {
          this.host.roomDoc.unmarkDeleted(this.host.name, relpath, this.host)
          if (disk === base) this.host.roomDoc.clearOverlay(this.host.name, relpath, this.host)
          else {
            this.host.roomDoc.setOverlay(this.host.name, relpath, disk, this.host)
            if (disk.length <= this.host.sizeCap) {
              this.host.roomDoc.setBaseText(this.host.name, sharedBase, relpath, published ?? '', this.host)
            }
          }
        }, this.host)
      }

      const afterText = this.host.roomDoc.text(relpath, this.host.name)
      const afterDeleted = this.host.roomDoc.deleted.get(this.host.name)?.has(relpath) ?? false
      if (afterText === undefined && !afterDeleted) this.retainedDeclaredPaths.delete(relpath)
      if (beforeText !== afterText || beforeDeleted !== afterDeleted) {
        this.host.batch.published(relpath)
        this.host.bumpLastActive()
        this.host.log(droppedStale ? `dropped stale overlay ${relpath}` : afterDeleted ? `marked ${relpath} deleted` : afterText === undefined ? `cleared ${relpath} overlay` : `published ${relpath} overlay`)
      }
    } finally {
      release()
      this.host.roomDoc.reconcileBaseTexts(this.host.name, this.host)
    }
  }

}
