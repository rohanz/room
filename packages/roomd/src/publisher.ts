import fs from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import { manifestKey, type RoomDoc } from '@room/shared'
import { gitHead, gitShowManyCapped, type GitBlobInfo } from './git.js'
import { checkoutText, type Baseline } from './baseline.js'
import { readDisk, StalePublication } from './disk-scan.js'
import { markManifestIncomplete, prepareManifestPublication, prepareManifestPublicationYielding, type ManifestFact } from './manifest-publish.js'
import { authorizesText, defaultExcludedPath, planYielding, type PublicationInputs, type PublicationPlan, type PlannedEntry, type SharingPolicy } from './policy.js'
import type { DiskBatch } from './disk-batch.js'

interface Host {
  readonly dir: string
  readonly name: string
  /** Undefined while the name lease is paused: nothing is written (hub §7). */
  readonly fence: string | undefined
  readonly roomDoc: RoomDoc
  readonly batch: DiskBatch
  readonly skips: { size: Set<string>; budget: Set<string>; ignore: Set<string> }
  readonly stopped: boolean
  readonly phase: string
  readonly inputs: PublicationInputs
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
  readonly fence: string | undefined
  readonly inputs: PublicationInputs
  readonly desired: PublicationPlan
  readonly baseTexts: ReadonlyMap<string, string | undefined>
  readonly facts: readonly ManifestFact[]
  readonly textOps: ReadonlyMap<string, ReturnType<RoomDoc['prepareOverlayDiff']>>
  readonly baseTextDeletes: readonly string[]
  readonly overlayDeletes: readonly string[]
  readonly manifestPlan: ReturnType<typeof prepareManifestPublication>
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
/** Publisher-only cleanup of text from one fenced incarnation. Held manifest entries
 * have no text and are intentionally outside this internal enumeration. */
const incarnationOverlayPaths = (room: RoomDoc, incarnation: string): string[] =>
  [...room.overlays.get(incarnation)?.keys() ?? []]

/** Withdraw one observed publisher incarnation during a same-worktree handoff. Never touches a newer head. */
export function withdrawFormerPublisher(room: RoomDoc, name: string, fence: string, successor: string): void {
  const key = manifestKey(name, fence)
  const baseTextDeletes = [...room.ownedBaseTexts.keys()].filter(old => old.startsWith(`${name}\0`))
  room.doc.transact(() => {
    const head = room.manifestHead.get(name)
    if (!head || head.fence !== fence || head.coverage.kind === 'none') return
    room.manifest.delete(key)
    room.overlays.delete(key)
    room.manifestHead.set(name, { ...head, coverage: { kind: 'none', reason: 'not-publisher' }, publisher: successor,
      excluded: [], rev: head.rev + 1, semRev: head.semRev + 1, scannedAt: Date.now() })
    for (const old of baseTextDeletes) room.ownedBaseTexts.delete(old)
  })
}

/** One publisher path: capture inputs, read disk/Git, pure plan, synchronous guarded apply. */
export class Publisher {
  private readonly excludedPaths = new Set<string>()
  private readonly errors = new Set<string>()
  private readonly oversizedCache = new Map<string, { size: number; mtimeMs: number; base: string; hash: string }>()
  private dirtyTimer?: ReturnType<typeof setTimeout>
  private formerPublisher?: { name: string; fence: string }
  constructor(private readonly host: Host) {
    const name = host.inputs.policy.publisherName
    const fence = name && host.roomDoc.manifestHead.get(name)?.fence
    if (name && name !== host.name && fence) this.formerPublisher = { name, fence }
  }

  pathsToReconcile(extra: Iterable<string> = []): Set<string> {
    const fence = this.host.fence
    const current = fence === undefined ? undefined : this.host.roomDoc.manifest.get(manifestKey(this.host.name, fence))
    return new Set([...current?.keys() ?? [], ...this.excludedPaths, ...extra])
  }

  stop(): void { if (this.dirtyTimer) clearTimeout(this.dirtyTimer) }

  /** Synchronous narrowing from the currently published snapshot; widening waits for readDisk. */
  applyInputs(next: PublicationInputs): void {
    const { host } = this
    if (next.policy.publisher && !host.inputs.policy.publisher && this.formerPublisher) {
      withdrawFormerPublisher(host.roomDoc, this.formerPublisher.name, this.formerPublisher.fence, host.name)
      this.formerPublisher = undefined
    }
    const fence = host.fence
    // Paused: the next publication under a fence applies these inputs in full.
    if (fence === undefined) { this.markDirty(); return }
    const incarnation = manifestKey(host.name, fence)
    const current = host.roomDoc.manifest.get(incarnation)
    const overlayPaths = incarnationOverlayPaths(host.roomDoc, incarnation)
    const facts: ManifestFact[] = []
    const factPaths = new Set<string>()
    const retainedText = new Set<string>()
    let budget = 0
    if (next.policy.level !== 'intent' && next.policy.publisher) {
      for (const [path, entry] of [...current?.entries() ?? []].sort(([a], [b]) => a.localeCompare(b))) {
        if (defaultExcludedPath(path) || next.rules.roomIgnore.ignores(path) || (entry.size !== undefined && entry.size > next.rules.sizeCap)) {
          facts.push({ path, change: entry.change, excluded: true })
          factPaths.add(path)
          this.excludedPaths.add(path)
          continue
        }
        const permit = authorizesText(next.policy, path)
        const text = permit && entry.change !== 'D' && entry.state === 'shared' ? host.roomDoc.overlayText(incarnation, path)?.toString() : undefined
        if (text !== undefined && budget + Buffer.byteLength(text) > next.rules.budget) {
          facts.push({ path, change: entry.change, excluded: true })
          factPaths.add(path)
          this.excludedPaths.add(path)
          continue
        }
        if (text !== undefined) budget += Buffer.byteLength(text)
        facts.push({ path, change: entry.change, ...(permit ? { hash: entry.hash, size: entry.size, baseHash: entry.baseHash } : {}),
          ...(text !== undefined ? { text } : {}), binary: entry.held === 'binary', at: entry.at })
        factPaths.add(path)
        if (text !== undefined || entry.change === 'D') retainedText.add(path)
      }
      for (const path of this.excludedPaths) if (!factPaths.has(path)) facts.push({ path, change: 'M', excluded: true })
    }
    const manifestPlan = prepareManifestPublication({ room: host.roomDoc, name: host.name, fence, base: next.head, level: next.policy.level,
      prefixes: next.policy.textPrefixes, complete: host.roomDoc.manifestHead.get(host.name)?.complete ?? false,
      ...(next.policy.publisher ? {} : { publisher: next.policy.publisherName ?? 'another session' }) }, facts)
    const wantedBase = new Set(facts.filter(f => !f.excluded && authorizesText(next.policy, f.path)).map(f => `${host.name}\0${next.head}:${f.path}`))
    const baseTextDeletes = [...host.roomDoc.ownedBaseTexts.keys()].filter(key => key.startsWith(`${host.name}\0`) && !wantedBase.has(key))
    host.roomDoc.doc.transact(() => {
      manifestPlan.commit(host.roomDoc.manifestHead.get(host.name)?.complete ?? false)
      for (const path of overlayPaths) {
        if (retainedText.has(path)) continue
        host.roomDoc.clearOverlay(incarnation, path, host)
      }
      for (const key of baseTextDeletes) host.roomDoc.ownedBaseTexts.delete(key)
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
    const capturedFence = this.host.fence
    const valid = () => !this.host.stopped && this.host.inputs === inputs && this.host.fence === capturedFence
    let baseBlobs: ReadonlyMap<string, GitBlobInfo | undefined> = new Map()
    const disk = await readDisk(this.host.dir, inputs, this.pathsToReconcile(carried?.untracked.keys()), p => this.host.isSafeRoomPath(p), this.oversizedCache, carried?.untracked, valid,
      blobs => { baseBlobs = blobs })
    let diskCount = 0
    for (const item of disk) { if (diskCount++ % 32 === 0) await setImmediate(); await this.host.beforeBaseRead?.(item.path) }
    let desired: PublicationPlan
    try { desired = await planYielding(inputs, disk, this.host.roomDoc.ensureRoomSalt()) }
    catch (error) {
      if (capturedFence !== undefined) markManifestIncomplete(this.host.roomDoc, this.host.name, capturedFence)
      throw error
    }
    if (desired.unsettled.length) {
      if (this.host.fence !== undefined) markManifestIncomplete(this.host.roomDoc, this.host.name, this.host.fence)
      this.reconcileFailed(new Error(`scan incomplete: could not read ${desired.unsettled.length} path(s)`))
    }
    const textPaths: string[] = []
    let textCount = 0
    for (const [p, entry] of desired.entries) {
      if (textCount++ % 32 === 0) await setImmediate()
      if (entry.state === 'shared' && authorizesText(inputs.policy, p)) textPaths.push(p)
    }
    const baseTextPaths: string[] = []
    let basePathCount = 0
    for (const p of textPaths) { if (basePathCount++ % 32 === 0) await setImmediate(); if (baseBlobs.get(p) !== undefined) baseTextPaths.push(p) }
    const baseTexts = await gitShowManyCapped(this.host.dir, inputs.head, baseTextPaths, inputs.rules.sizeCap, baseBlobs)
    for (const p of textPaths) {
      if (textCount++ % 32 === 0) await setImmediate()
      const sha = carried?.untracked.get(p)?.sha
      if (sha) baseTexts.set(p, await checkoutText(this.host.dir, sha, p, 'utf8', inputs.rules.sizeCap))
    }
    const facts: ManifestFact[] = []
    const textOps = new Map<string, ReturnType<RoomDoc['prepareOverlayDiff']>>()
    let lastYield = performance.now()
    let sinceYield = 0
    const incarnation = capturedFence === undefined ? undefined : manifestKey(this.host.name, capturedFence)
    for (const [path, entry] of desired.entries) {
      if (++sinceYield >= 32 || performance.now() - lastYield >= 15) {
        await setImmediate(); lastYield = performance.now(); sinceYield = 0
      }
      if (!valid()) throw new StalePublication('publication inputs changed during prepare')
      facts.push({ path, change: entry.change, hash: entry.hash, size: entry.size, baseHash: entry.baseHash, text: entry.text, binary: entry.held === 'binary', at: entry.at })
      if (entry.text !== undefined && incarnation) {
        textOps.set(path, this.host.roomDoc.prepareOverlayDiff(incarnation, path, entry.text))
      }
    }
    for (const path of desired.excludedPaths) {
      if (++sinceYield >= 32 || performance.now() - lastYield >= 15) { await setImmediate(); lastYield = performance.now(); sinceYield = 0 }
      if (!valid()) throw new StalePublication('publication inputs changed during prepare')
      facts.push({ path, change: 'M', excluded: true })
    }
    const baseTextDeletes: string[] = []
    const wanted = new Set<string>()
    const ownerBasePrefix = `${this.host.name}\0`
    const currentBasePrefix = `${ownerBasePrefix}${inputs.head}:`
    let wantedCount = 0
    for (const [p, entry] of desired.entries) {
      if (wantedCount++ % 32 === 0) await setImmediate()
      if (entry.held !== 'scope' && authorizesText(inputs.policy, p)) wanted.add(`${currentBasePrefix}${p}`)
    }
    let baseCount = 0
    for (const key of this.host.roomDoc.ownedBaseTexts.keys()) {
      if (++baseCount % 32 === 1) await setImmediate()
      if (!valid()) throw new StalePublication('publication inputs changed during prepare')
      if (key.startsWith(ownerBasePrefix) && (!wanted.has(key) ||
        (key.startsWith(currentBasePrefix) && baseTexts.get(key.slice(currentBasePrefix.length)) === undefined))) baseTextDeletes.push(key)
    }
    const manifestPlan = await prepareManifestPublicationYielding({ room: this.host.roomDoc, name: this.host.name, fence: capturedFence ?? '',
      base: inputs.head, level: inputs.policy.level, prefixes: inputs.policy.textPrefixes, complete: true,
      ...(inputs.policy.publisher ? {} : { publisher: inputs.policy.publisherName ?? 'another session' }) }, facts)
    const overlayDeletes: string[] = []
    if (incarnation) {
      let overlayCount = 0
      for (const p of incarnationOverlayPaths(this.host.roomDoc, incarnation)) {
        if (overlayCount++ % 32 === 0) await setImmediate()
        if (desired.entries.get(p)?.state !== 'shared' || desired.entries.get(p)?.change === 'D') overlayDeletes.push(p)
      }
    }
    return { fence: capturedFence, inputs, desired, baseTexts, facts, textOps, baseTextDeletes, overlayDeletes, manifestPlan }
  }

  /** Final synchronous gate; called immediately before the Y transaction. */
  valid(prepared: PreparedPublication): boolean {
    if (prepared.desired.unsettled.length) return false
    const { host } = this
    if (host.stopped || host.inputs !== prepared.inputs || host.fence === undefined || host.fence !== prepared.fence) return false
    return true
  }

  /** No event-loop yield can occur between this check and the publication transaction. */
  identityValid(prepared: PreparedPublication): boolean {
    if (!this.valid(prepared)) return false
    for (const p of prepared.desired.textPaths) {
      const entry = prepared.desired.entries.get(p)!
      try {
        const stat = fs.lstatSync(this.host.abs(p))
        if (!stat.isFile() || stat.size !== entry.size || stat.mtimeMs !== entry.at || stat.ino !== entry.ino) return false
      } catch { return false }
    }
    return true
  }

  /** Filesystem checks run in yielding prepare, before any Y transaction. */
  async validatePrepared(prepared: PreparedPublication): Promise<boolean> {
    if (!this.valid(prepared)) return false
    const { host } = this
    let count = 0
    for (const p of prepared.desired.textPaths) {
      if (++count % 32 === 1) await setImmediate()
      if (!this.valid(prepared)) return false
      const entry = prepared.desired.entries.get(p)!
      try {
        const stat = fs.lstatSync(host.abs(p))
        // readDisk checked the read against a second stat. Rechecking file identity here
        // keeps the final synchronous transaction gate cheap even for many files.
        if (!stat.isFile() || !host.isSafeRoomPath(p) || stat.size !== entry.size || stat.mtimeMs !== entry.at || stat.ino !== entry.ino) return false
      } catch { return false }
    }
    return true
  }

  /** May run inside an outer HEAD-transition transaction; Yjs nests it into the same transaction. */
  apply(prepared: PreparedPublication, complete: boolean): boolean {
    if (!this.valid(prepared)) { this.markDirty(); return false }
    const { host } = this
    const { desired, inputs } = prepared
    const fence = host.fence!
    const incarnation = manifestKey(host.name, fence)
    host.roomDoc.doc.transact(() => {
      prepared.manifestPlan.commit(complete)
      for (const p of prepared.overlayDeletes) host.roomDoc.clearOverlay(incarnation, p, host)
      for (const [p, entry] of desired.entries) {
        if (entry.state !== 'shared') continue
        if (entry.change === 'D') {
          host.roomDoc.clearOverlay(incarnation, p, host)
        } else if (entry.text !== undefined) {
          host.roomDoc.applyPreparedOverlayDiff(incarnation, p, prepared.textOps.get(p)!, host)
        }
        const base = prepared.baseTexts.get(p)
        if (base !== undefined) host.roomDoc.ownedBaseTexts.set(`${host.name}\0${inputs.head}:${p}`, base)
      }
      for (const key of prepared.baseTextDeletes) host.roomDoc.ownedBaseTexts.delete(key)
    }, host)
    this.excludedPaths.clear()
    for (const p of desired.excludedPaths) this.excludedPaths.add(p)
    const previousSkips = new Set([...host.skips.size, ...host.skips.budget, ...host.skips.ignore])
    host.skips.size.clear(); host.skips.budget.clear(); host.skips.ignore.clear()
    for (const [p, reason] of desired.excludedReasons) if (reason === 'size') host.skips.size.add(p)
    else if (reason === 'budget') host.skips.budget.add(p)
    else host.skips.ignore.add(p)
    for (const [p, reason] of desired.excludedReasons) if (!previousSkips.has(p)) host.noteSkip(p, reason === 'size' ? 'over size cap' : reason === 'budget' ? 'over total budget' : reason === 'untracked lockfile' ? reason : 'ignore')
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
      if (!await this.validatePrepared(prepared) || !this.identityValid(prepared) || !this.apply(prepared, complete)) return undefined
      if (complete) await this.host.onFullScan?.(prepared.inputs.policy, prepared.desired.entries, prepared.desired.unsettled)
      if (this.host.phase === 'seed' || this.host.phase === 'watch') this.host.onSeedProgress?.()
      return prepared
    } catch (error) {
      // Replaced inputs are not a failure: whoever replaced them publishes again, as when apply refuses a stale snapshot.
      if (!(error instanceof StalePublication)) this.reconcileFailed(error)
      return undefined
    }
  }
}
