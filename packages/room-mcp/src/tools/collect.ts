import { writeWorkerRecordRef } from '../worker-refs.js'
import { retainedWorkerLines } from '../worker-retained.js'
import { validPid } from '@room/relay/process'
import { requireWorkerInventory } from '../worker-store.js'
import { requireWorkerEvidence } from '../worker-store.js'
import { asyncFilter } from '../async-filter.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { setImmediate } from 'node:timers/promises'
import { claimsOverlap, type RetiredWorker } from '@room/shared'
import { git, gitWholeTree } from '@room/roomd/git'
import { boundedGit, boundedGitSync, carriedContentHashes, carriedUnchangedPaths, workerBaseline } from '@room/roomd/baseline'
import { MATERIALIZED_PATH, containedRepoPath, realGitCommonDir, validRepoPath } from '@room/roomd'
import { cleanupWorker, cleanupWorkerLogs, collectBaseRef, collectHeadRef, ignoredWorkerArtifacts, pruneMissingWorkerWorktree, saveDiscardPatch, saveWorkerScratch, workerOwnedPaths, CARRY_FILE_LIMIT, type WorkerCleanupPreservation } from '../worker-git.js'
import { signalWorker, pidPresent, workerProcessOwnership, terminateWorktreeProcesses, stopWorkerWithEscalation, type CwdProcessLister, type ProcessProbe } from '../worker-process.js'
import { decideCollect, decideDiscard, decideStop, workerRealState } from '../worker-state.js'
import { buildCombinedTree, scratchCollectNote } from './combined-tree.js'
import { addCarriedUntrackedModes, gitTreeModes, materializeMergedFile, mergedFileMode } from './files.js'
import { releaseClaimsOnDone } from './claims.js'
import { RW, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'
import type { Session } from '../session.js'
import { finishPendingCollect, nothingToCollectLine, removeCollectedCheckout, retireIfNothingToCollect, outsideCollectLine, retireWorker } from '../retire.js'
import { localWorkers, openWorkerReader, registryForDir } from '../worker-registry.js'
import { realStateInput, type LocalWorker } from '../worker-status.js'
import { currentToolTiming } from '../timing.js'
import { CollectionReview } from '../collection-review.js'
import { acknowledgeKeptPublication } from '../kept-publication.js'
import { collectedTreeEvidence } from '../preview-evidence.js'

export const defs: ToolDef[] = [{
  name: 'room_collect', annotations: { ...RW, destructiveHint: true },
  description: 'Use to "bring in their work" unstaged, discard it, or keep the worker for resumption. Defer until follow-ups end. Conflicts write nothing.',
  inputSchema: { ...{ additionalProperties: false }, type: 'object', properties: {
    tag: str('worker tag'), mode: { type: 'string', enum: ['apply', 'copy'] },
    discard: { type: 'boolean' },
    keep: { type: 'boolean' },
    paths: strs('copy mode: repo-relative files or directories'),
    force: { type: 'boolean', description: 'overwrite copies; discard ignored files' },
  } },
}]

const split = (value: string) => value.split('\0').filter(Boolean)
/** Per-file collection ceiling: the carry and scratch cap, so whatever a worker could receive it can return. */
const COLLECT_FILE_LIMIT = CARRY_FILE_LIMIT
const COLLECT_YIELD_EVERY = 32
const COPY_INSTALL_LIMIT = 4_096
/** How long collect waits for a finished worker's host to exit; room_wait's done notice states it. */
const EXIT_WAIT_MS = 15_000

type FileIdentity = { size: number; mtimeMs: number; ino: number; dev: number; mode: number } | null

function fileIdentity(file: string): FileIdentity {
  let stat: fs.Stats
  try { stat = fs.lstatSync(file) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
  if (!stat.isFile()) throw new Error('collection destination is not a regular file: ' + file)
  return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev, mode: stat.mode & 0o777 }
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a === null || b === null ? a === b
    : a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev && a.mode === b.mode
}

/** The descriptor is checked both before and after the bounded read. */
function boundedCollectText(file: string, expected: FileIdentity): Buffer | null {
  if (expected === null) return null
  if (expected.size > COLLECT_FILE_LIMIT) throw new Error(file + ' exceeds collection text limit; nothing written')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fs.fstatSync(fd)
    if (!sameIdentity(expected, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev, mode: stat.mode & 0o777 })) throw new Error(file + ' changed during collection; nothing written, retry')
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) throw new Error(file + ' changed during collection; nothing written, retry')
      offset += count
    }
    if (!sameIdentity(expected, fileIdentity(file))) throw new Error(file + ' changed during collection; nothing written, retry')
    return bytes
  } finally { fs.closeSync(fd) }
}

/** Compare without loading either whole file into JS memory. */
async function sameFileBytes(a: string, b: string, size: number): Promise<boolean> {
  const left = await fs.promises.open(a, 'r')
  let right: fs.promises.FileHandle | undefined
  try {
    right = await fs.promises.open(b, 'r')
    const one = Buffer.alloc(Math.min(64 * 1024, size)), two = Buffer.alloc(one.length)
    for (let offset = 0; offset < size; offset += one.length) {
      await setImmediate()
      const length = Math.min(one.length, size - offset)
      const [x, y] = await Promise.all([left.read(one, 0, length, offset), right.read(two, 0, length, offset)])
      if (x.bytesRead !== length || y.bytesRead !== length || !one.subarray(0, length).equals(two.subarray(0, length))) return false
    }
    return true
  } finally { await Promise.all([left.close(), right?.close()]) }
}

/** Only signal processes after confirming this is still the worker's owned git worktree. */
const ownershipRecords = async (s: Session) => [...s.room.retiredWorkers(), ...(await localWorkers(s.dir))]

async function stopOwnedWorktreeProcesses(leadDir: string, w: LocalWorker, leadName: string, workers: Iterable<LocalWorker | RetiredWorker>, errors?: string[], probe?: ProcessProbe, list?: CwdProcessLister): Promise<string[]> {
  if (!decideStop(await workerRealState(leadDir, w, { ownership: true, leadName, workers })).cwd) return []
  if (w.id) {
    const registry = await registryForDir(leadDir)
    const record = (await registry.read(w.id))
    if (!record || record.sharedWith || (await registry.worktreeOwner(record)) || requireWorkerEvidence(await registry.checkoutUsers(record)).length) return []
  }
  try { return await terminateWorktreeProcesses(w.dir, { protectedPids: w.pid ? [w.pid] : [], probe, list }) }
  catch (e) {
    errors?.push(`cwd process cleanup failed: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

const failureReason = (w: LocalWorker): string => w.exitCode !== undefined && w.exitCode !== 0
  ? `exit code ${w.exitCode}${w.summary ? `; ${w.summary.replace(/\s+/g, ' ').slice(0, 180)}` : ''}`
  : w.stopReason ?? w.summary?.replace(/\s+/g, ' ').slice(0, 180) ?? 'worker reported failure'

/** A discard refused for ignored output that no recovery patch covers: where it is, and the exact ways forward. */
const ignoredDiscardRefusal = (tag: string, dir: string, ignored: string[], details: string[] = []): string => [
  `error: discard refused; ignored artifacts not covered by a recovery patch: ${ignored.join(', ')}`,
  ...details, `retained worktree: ${dir}`,
  `to keep any of them, copy them out of ${dir} first; then room_collect(tag="${tag}", discard=true, force=true) deletes them with the worktree`,
].join('\n')

/** Reject symlinks at every component, including dangling destination links. */
function safePath(root: string, rel: string): string {
  if (!validRepoPath(rel, MATERIALIZED_PATH)) throw new Error('unsafe collection path: ' + rel)
  const result = containedRepoPath(root, path.join(root, rel), { leaf: 'reject-link', allowMissing: true })
  if (!result.ok) throw new Error(result.reason === 'link' ? 'symlink collection path refused: ' + rel : 'unsafe collection path: ' + rel)
  return result.path
}

async function copyFiles(root: string, paths: string[]): Promise<string[]> {
  const files = new Set<string>()
  let count = 0
  const visit = async (rel: string): Promise<void> => {
    if (count++ % COLLECT_YIELD_EVERY === 0) await setImmediate()
    const file = safePath(root, rel), stat = fs.statSync(file)
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) await visit(rel + '/' + name)
    else if (stat.isFile()) files.add(rel)
    else throw new Error('not a regular file: ' + rel)
  }
  for (const rel of paths) await visit(rel)
  return [...files].sort()
}

async function assertNoOperation(dir: string): Promise<void> {
  const names = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']
  const files = (await git(dir, ['rev-parse', ...names.flatMap(name => ['--git-path', name])])).trim().split('\n')
  if (files.length !== names.length) throw new Error('could not inspect Git operation state in ' + dir)
  for (const file of files) {
    if (fs.existsSync(path.resolve(dir, file))) throw new Error('finish the existing Git operation in ' + dir + ' before collecting')
  }
}

/** Capture the worker's source, not the combined result: follow-ups continue in its own checkout. */
async function keptSnapshot(w: LocalWorker, root: string, head: string, paths: string[], scratch: ReadonlySet<string> = new Set()) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'room-collect-index-'))
  const env = { ...process.env, GIT_INDEX_FILE: path.join(temp, 'index') }
  const run = async (args: string[], count?: number) => (await boundedGit(root, ['-c', 'core.hooksPath=/dev/null', ...args], count, env)).toString().trim()
  try {
    await run(['read-tree', head], paths.length)
    // Fold the lead's carried untracked blobs into the private tree before updating changed paths.
    const entries = new Map((w.carriedUntracked ?? []).map(p => [p.path, `${p.mode && (p.mode & 0o111) ? '100755' : '100644'} ${p.sha}\t${p.path}\0`]))
    const sources = paths.filter(p => !scratch.has(p) && !workerOwnedPaths(w).includes(p)).map(p => ({ p, identity: fileIdentity(safePath(root, p)) }))
    const present = sources.filter(source => source.identity !== null)
    const hashes = carriedContentHashes(root, present.map(source => source.p), true)
    for (const [index, source] of present.entries()) entries.set(source.p, `${source.identity!.mode & 0o111 ? '100755' : '100644'} ${hashes[index]}\t${source.p}\0`)
    for (const source of sources) if (!source.identity) entries.set(source.p, `0 ${'0'.repeat(head.length)}\t${source.p}\0`)
    const info = path.join(temp, 'entries')
    fs.writeFileSync(info, [...entries.values()].join(''), { mode: 0o600 })
    boundedGitSync(root, ['update-index', '-z', '--index-info'], { env, stdinFile: info, wholeTreePaths: entries.size })
    const tree = await run(['write-tree'], entries.size)
    const sha = await run(['-c', 'user.name=Room', '-c', 'user.email=room@localhost', 'commit-tree', tree, '-p', head, '-m', 'room: kept collection baseline'])
    return { sha, sources }
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
}

export function handlers(state: HandlerState): Record<string, Handler> {
  const cleanRetiredSharedOwner = async (s: Session, borrower: LocalWorker): Promise<string | undefined> => {
    const registry = await registryForDir(s.dir)
    const current = (await registry.read(borrower.id))
    const owner = current && (await registry.worktreeOwner(current))
    if (!owner || owner.phase !== 'retired' || !owner.keptWorktree
      || !owner.archive?.keptReason?.startsWith('shared checkout: ')) return
    try { await registry.beginOperation(owner.id, 'collect') } catch { return }
    try {
      const fresh = (await registry.read(owner.id))
      if (!fresh || fresh.phase !== 'retired' || !fresh.keptWorktree || requireWorkerEvidence(await registry.checkoutUsers(fresh)).length) return
      const status = (await registry.status(fresh.id))
      if (!status) return
      const w = { ...realStateInput(fresh, status), status: 'done' as const, exitCode: 0 }
      const preservation: WorkerCleanupPreservation = { ignored: [], uncollected: [] }
      if (!await cleanupWorker(s.dir, w, { collected: true, processOptions: { probe: state.ctx?.probe, list: state.ctx?.listCwdProcesses }, leadName: s.me.name, workers: (await ownershipRecords(s)), preservation })) {
        const details = [
          ...(preservation.ignored.length ? [`ignored files not copied: ${preservation.ignored.join(', ')}`] : []),
          ...(preservation.uncollected.length ? [`uncollected work: ${preservation.uncollected.join(', ')}`] : []),
          ...(preservation.commitsAfterCollection ? [`commits after collection: ${preservation.commitsAfterCollection.sha} ${preservation.commitsAfterCollection.paths.join(', ') || '(no changed paths)'}`] : []),
        ]
        if (!details.length) return `kept ${fresh.tag}'s worktree: cleanup incomplete`
        const reason = `shared checkout: no borrowers; ${details.join('; ')}`
        await registry.command(fresh.id, { type: 'retired-checkout-kept', dir: w.dir, reason })
        for (const room of state.rooms.all()) {
          const list = room.room.doc.getArray<RetiredWorker>('retiredWorkers')
          const index = list.toArray().findIndex(entry => entry.id === fresh.id)
          if (index >= 0) room.room.doc.transact(() => { const entry = list.get(index); list.delete(index); list.insert(index, [{ ...entry, keptWorktree: w.dir, keptReason: reason }]) })
        }
        return `kept ${fresh.tag}'s worktree at ${w.dir}: ${details.join('; ')}. Copy what you need from there, then room_collect(tag="${fresh.tag}", discard=true) (add force=true to delete ignored files too)`
      }
      await registry.command(fresh.id, { type: 'retired-checkout-removed' })
      for (const room of state.rooms.all()) {
        const list = room.room.doc.getArray<RetiredWorker>('retiredWorkers')
        const index = list.toArray().findIndex(entry => entry.id === fresh.id)
        if (index >= 0) room.room.doc.transact(() => {
          const { keptWorktree: _kept, keptReason: _reason, ...entry } = list.get(index)
          list.delete(index)
          list.insert(index, [entry])
        })
      }
      if (preservation.recoveryRef) return `cleaned up ${fresh.tag}; branch recovery ref: ${preservation.recoveryRef}`
    } finally { await registry.finishOperation(owner.id) }
  }
  const missingCapability = async (s: Session, w: LocalWorker): Promise<string> => {
    const registry = await openWorkerReader(s.dir)
    const record = (await registry.reserved(w.tag))
    if (record && record.lead.participant !== s.me.name) {
      const parent = (await registry.reservedByTagOrName(record.lead.participant))
      return `${w.tag} belongs to ${record.lead.participant}; collect it through that lead (resume it if needed), or room_collect tag=${parent?.tag ?? 'PARENT'} discard=true force=true to save recovery patches`
    }
    return `${w.tag}: no local worker capability (worktree missing or unmanaged)`
  }
  const holdingWorker = async (tag: string, from: Session): Promise<Session> => {
    const record = await (await openWorkerReader(from.dir)).reserved(tag)
    return state.rooms.all().find(room => record?.room === room.roomName) ?? from
  }
  const unverifiedLive = async (s: Session, w: LocalWorker): Promise<string | undefined> => {
    if (!pidPresent(w.pid, state.ctx?.probe)) return undefined
    const facts = await workerRealState(s.dir, w, { process: true, hasHandle: !!state.rooms.handle?.(s, w.id), probe: state.ctx?.probe })
    // 'not-ours' means the worker's process has exited and another process now holds its pid:
    // nothing of ours is running, so nothing is left behind. Only an unreadable identity blocks.
    return facts.process === 'unknown' ? `could not verify ${w.tag}'s process (pid ${w.pid}); left running, not stopped` : undefined
  }
  /** The exit recorded for the worker's last launched run. Read from the exit records: during collection the record
   * is `collecting`, which hides the run's status. */
  const lastExit = async (s: Session, w: LocalWorker) => {
    const registry = await openWorkerReader(s.dir)
    const run = (await registry.read(w.id))?.runs.filter(r => r.launch?.outcome !== 'never').at(-1)?.n
    return run === undefined ? undefined : (await registry.exits(w.id)).find(e => e.run === run)
  }
  /** Why the host's exit is not confirmed yet, or undefined once a witnessed exit is recorded. Collect only takes a
   * worker that reported done, and its report wins over the exit code (registry §6): any witnessed exit confirms
   * the host is gone. */
  const uncleanExit = async (s: Session, w: LocalWorker): Promise<string | undefined> => {
    if (state.workerAlive(s, w)) return 'its host process is still running'
    if (w.exitCode === 0) return undefined
    return (await lastExit(s, w))?.witnessed ? undefined : 'exit not witnessed'
  }
  /** How a run that reported done then ended abnormally, from its witnessed exit; undefined after a clean exit. */
  const exitAfterReport = async (s: Session, w: LocalWorker): Promise<string | undefined> => {
    const exit = await lastExit(s, w)
    if (!exit?.witnessed) return undefined
    return exit.signal ? `killed by ${exit.signal}` : exit.code !== null && exit.code !== 0 ? `exit code ${exit.code}` : undefined
  }
  const ownership = async (s: Session, w: Pick<LocalWorker, 'lead'>, discarding: Set<string>): Promise<{ owned: boolean; liveLead?: string }> => {
    const live = (await localWorkers(s.dir))
    const known = [...live, ...s.room.retiredWorkers()]
    const visited = new Set<string>()
    let lead = w.lead
    let liveLead: string | undefined
    while (lead && !visited.has(lead)) {
      if (lead === s.me.name) return { owned: true, liveLead }
      visited.add(lead)
      const active = live.find(parent => parent.name === lead)
      if (active && !discarding.has(lead) && !liveLead && (state.workerAlive(s, active) || pidPresent(active.pid, state.ctx?.probe))) liveLead = lead
      lead = known.find(parent => parent.name === lead)?.lead ?? ''
    }
    return { owned: false }
  }
  /** Explicit orphan recovery uses local registry identities, never replicated room ownership. */
  const orphanDiscardAllowed = async (s: Session, w: LocalWorker): Promise<boolean> => {
    const human = s.me.owner ?? s.me.name
    const registry = await openWorkerReader(s.dir)
    const records = (requireWorkerInventory(await registry.list()))
    const live = (await localWorkers(s.dir))
    const visited = new Set<string>()
    let record = (await registry.read(w.id))
    while (record && !visited.has(record.id)) {
      // Spawn names workers from the human owner plus the exact tag. Do not infer an
      // owner by splitting arbitrary participant names or trusting room projections.
      if (record.name !== `${human}+${record.tag}` || record.lead.room !== s.roomName || record.legacy?.unowned) return false
      visited.add(record.id)
      const leadName = record.lead.participant
      // The terminal lead is often an ordinary session, not a worker. Its durable
      // instance still protects it; an unreadable but present PID also blocks recovery.
      if (!validPid(record.lead.instance.pid) || pidPresent(record.lead.instance.pid, state.ctx?.probe)) return false
      const parent = live.find(parent => parent.name === leadName)
      if (parent && (state.workerAlive(s, parent) || pidPresent(parent.pid, state.ctx?.probe))) return false
      record = records.find(parent => parent.name === leadName)
      if (!record) return leadName === human || leadName.startsWith(human + '+')
    }
    return false
  }
  const descendants = async (s: Session, w: LocalWorker): Promise<LocalWorker[]> => {
    const out: LocalWorker[] = []
    const visit = async (parent: LocalWorker) => {
      for (const child of (await localWorkers(s.dir))) if (child.lead === parent.name) { await visit(child); out.push(child) }
    }
    await visit(w)
    return out
  }
  const takeWorkerOperation = async (s: Session, w: LocalWorker, op: 'collect' | 'discard'): Promise<string> => {
    if (!w.id) return 'untrusted'
    const registry = await registryForDir(s.dir)
    const trusted = await registry.trustedOutside({ participant: s.me.name, room: s.roomName }, w.tag)
      ?? await registry.trusted({ participant: s.me.name, room: s.roomName, dir: s.dir }, w.tag, op === 'discard')
    if (!trusted || trusted.record.id !== w.id) return 'untrusted'
    try { await registry.beginOperation(w.id, op); return w.id }
    catch { return 'busy' }
  }
  type Registry = Awaited<ReturnType<typeof registryForDir>>
  /** Discard phase for a retired worker whose worktree was kept; undefined when this tag has none owned here. */
  const discardKeptWorktree = async (a: Record<string, unknown>, registry: Registry, discarding: Set<string>): Promise<string | undefined> => {
    const { rooms } = state
    const kept = rooms.all().flatMap(s => s.room.retiredWorkers()
      .filter(r => r.tag === a.tag && r.keptWorktree)
      .map(r => ({ s, r }))).find(async ({ s, r }) => (await ownership(s, r, discarding)).owned)
    if (!kept || (await localWorkers(kept.s.dir)).some(live => live.tag === a.tag)) return undefined
    const { s, r } = kept
    const active = (requireWorkerInventory(await registry.list())).find(record => record.tag === r.tag && record.keptWorktree === r.keptWorktree)
    const activeStatus = active && (await registry.status(active.id))
    if (!active || !activeStatus) return 'error: kept worker has no local registry record'
    const borrowedOwner = (await registry.worktreeOwner(active))
    const borrowed = !!active.sharedWith || !!borrowedOwner
    const w: LocalWorker = { ...realStateInput(active, activeStatus), dir: r.keptWorktree!, branch: 'room/' + r.tag, status: 'done', exitCode: 0, pid: 0 }
    try { await registry.beginOperation(active.id, 'discard') }
    catch { return 'error: this worker is already being handled or retired' }
    try {
      const shared = !borrowed && fs.existsSync(r.keptWorktree!) && requireWorkerEvidence(await registry.checkoutUsers(active))[0]
      if (shared) return `error: discard refused; ${shared.record.tag} still uses ${r.tag}'s worktree: ${r.keptWorktree}`
      const missing = !borrowed && decideDiscard(await workerRealState(s.dir, w)) === 'prune'
      const ignored = missing || borrowed ? [] : await ignoredWorkerArtifacts(w, s.dir)
      if (ignored.length && a.force !== true) return ignoredDiscardRefusal(r.tag, w.dir, ignored)
      await registry.beginDiscard(active.id, a.force === true, [])
      await registry.markDiscardStep(active.id, 'children')
      await registry.beginStop(active.id, 'discarded')
      const cleanupErrors: string[] = []
      const terminated = borrowed ? [] : await stopOwnedWorktreeProcesses(s.dir, w, s.me.name, (await ownershipRecords(s)), cleanupErrors, state.ctx?.probe, state.ctx?.listCwdProcesses)
      if (cleanupErrors.length) throw new Error(cleanupErrors.join('; '))
      // A kept worktree that is no longer an owned Room worktree is refused, not forgotten: cleanupWorker decides.
      const missingDetail = missing ? await pruneMissingWorkerWorktree(s.dir, w) : undefined
      if (missing || borrowed) cleanupWorkerLogs(s.dir, active)
      await registry.markDiscardStep(active.id, 'stop')
      const patch = missing || borrowed ? undefined : await saveDiscardPatch(s.dir, w, bytes => registry.recordDiscardPatch(active.id, bytes))
      await registry.markDiscardStep(active.id, 'patch')
      const preservation: WorkerCleanupPreservation = { ignored: [], uncollected: [] }
      if (!missing && !borrowed && !await cleanupWorker(s.dir, w, { collected: true, discarded: true, terminatedProcesses: terminated, processOptions: { probe: state.ctx?.probe, list: state.ctx?.listCwdProcesses }, leadName: s.me.name, workers: (await ownershipRecords(s)), preservation })) throw new Error('worker is not an owned Room worktree')
      await registry.markDiscardStep(active.id, 'cleanup')
      const archive = s.room.doc.getArray<RetiredWorker>('retiredWorkers')
      const index = archive.toArray().findIndex(item => item.id === active.id)
      if (index >= 0) s.room.doc.transact(() => {
        archive.delete(index)
        const { keptWorktree: _keptWorktree, ...cleared } = r
        archive.insert(index, [{ ...cleared, summary: 'discarded', disposition: 'discarded' }])
      })
      await registry.markDiscardStep(active.id, 'prune')
      await retireWorker(rooms, s, active.id, { ...r, summary: 'discarded', disposition: 'discarded', keptWorktree: undefined }, { keptWorktree: undefined })
      return (borrowed ? `detached ${r.tag}; the worktree belongs to ${borrowedOwner?.tag ?? active.sharedWith}` : 'discarded ' + r.tag) + (missingDetail ? '; its worktree was already gone; ' + missingDetail : '') + (patch ? '; recovery patch: ' + patch + ' (kept for a week)' : '') + (preservation.recoveryRef ? '; branch recovery ref: ' + preservation.recoveryRef : '') + (terminated.length ? '; stopped processes: ' + terminated.join(', ') : '') + (ignored.length ? '; deleted without a copy: ' + ignored.join(', ') : '') + (cleanupErrors.length ? '; ' + cleanupErrors.join('; ') : '')
    } catch (e) { await registry.interruptDiscard(active.id, e instanceof Error ? e.message : String(e)).catch(() => {}); return 'error: ' + (e instanceof Error ? e.message : String(e)) + '; retained ' + w.dir }
    finally { await registry.finishOperation(active.id) }
  }
  /** Discard phase for a live registered worker: borrowers and nested workers first, then stop, patch, clean up and retire. */
  const discardWorker = async (a: Record<string, unknown>, lead: Session, registry: Registry, discarding: Set<string>, actingLead?: Session): Promise<string> => {
    const { rooms } = state
    let s = actingLead ?? (await holdingWorker(a.tag as string, lead))
    const w = (await localWorkers(s.dir, record => record.tag === a.tag))[0]
    if (!w) return 'error: no worker ' + a.tag + ' owned by you'
    const workerRecord = await registry.read(w.id)
    const owner = (await ownership(s, w, discarding))
    if (!owner.owned || (workerRecord?.outside && w.lead !== s.me.name)) {
      if (workerRecord?.outside || a.force !== true || !(await orphanDiscardAllowed(s, w))) return 'error: no worker ' + a.tag + ' owned by you'
      // Act for this dead lead only inside discard. The normal registry capability,
      // operation lease, worktree ownership and process checks still apply below.
      s = { ...s, me: { ...s.me, name: w.lead } }
    }
    if (owner.liveLead) return `error: ${w.tag} belongs to ${owner.liveLead}, which is still running; ask it with room_send, or discard ${owner.liveLead}'s worker first`
    const borrowedOwner = workerRecord && (await registry.worktreeOwner(workerRecord))
    const borrowed = !!w.sharedWith || !!borrowedOwner
    const lock = await takeWorkerOperation(s, w, 'discard')
    if (lock === 'untrusted') {
      // No worktree capability can be proven for a checkout that is gone (dir= into a removed checkout). With its
      // branch and process gone too, nothing remains to stop, patch or clean up: retiring the record is the discard.
      if (workerRecord && await retireIfNothingToCollect(s.dir, registry, workerRecord, { probe: state.ctx?.probe, hasHandle: x => state.workerAlive(s, x) })) {
        await rooms.project()
        return `discarded ${w.tag}: nothing to collect; its worktree and branch were already gone`
      }
      return `error: ${(await missingCapability(s, w))}`
    }
    if (lock === 'busy') return 'error: this worker is already being handled or retired'
    try {
    const sharedResults: string[] = []
    if (!borrowed && !workerRecord?.outside) {
      const users = requireWorkerEvidence(await registry.checkoutUsers((await registry.read(w.id))!))
      const running = users.find(({ status }) => !['done', 'failed', 'stopped'].includes(status.status))
      if (running && fs.existsSync(w.dir)) return `error: discard refused; ${running.record.tag} is still running in ${w.tag}'s worktree: ${w.dir}`
      for (const { record: user } of users) {
        const result = await roomCollect({ tag: user.tag, discard: true }, discarding, s)
        if (!result.startsWith('detached ')) return `error: could not detach ${user.tag} before discarding ${w.tag}: ${result}`
        sharedResults.push(result)
      }
    }
      const unsafe = await unverifiedLive(s, w)
      if (unsafe) return unsafe
      const children = (await descendants(s, w))
      if (children.length && a.force !== true) return `error: ${w.tag} has nested workers: ${children.map(c => c.tag).join(', ')}; collect or discard them first, or repeat with force=true to save recovery patches and discard them`
      const beforePlan = await workerRealState(s.dir, w, { ownership: !workerRecord?.outside, leadName: s.me.name, workers: (await ownershipRecords(s)) })
      const ignoredBefore = !borrowed && decideDiscard(beforePlan) === 'cleanup' ? await ignoredWorkerArtifacts(w, s.dir) : []
      if (ignoredBefore.length && a.force !== true) return ignoredDiscardRefusal(w.tag, w.dir, ignoredBefore)
      await registry.beginDiscard(lock, a.force === true, children.map(child => child.id!).filter(Boolean))
      const childResults: string[] = []
      // Recurse through each direct lead so deeper descendants retain their own
      // lead's capability instead of being impersonated by the top-level worker.
      for (const child of children.filter(child => child.lead === w.name)) {
        if (!(await localWorkers(s.dir)).some(live => live.id === child.id)) continue
        // Missing parents cannot resolve the common Git directory. Keep the surviving
        // checkout as the registry/Git anchor; trusted() still checks the nested path.
        const childLead = { ...s, dir: fs.existsSync(w.dir) ? w.dir : s.dir, me: { ...s.me, name: w.name } } as Session
        const result = await roomCollect({ tag: child.tag, discard: true, force: true }, new Set([...discarding, w.name]), childLead)
        childResults.push(result)
        // A child's reply may start with detached borrowers; its last lifecycle
        // outcome precedes any appended retained-item diagnostics.
        const own = result.split('\n').reverse().find(line => /^(discarded |stopped |detached |error:)/.test(line)) ?? ''
        if (!own.startsWith('discarded ') && !own.startsWith('stopped ') && !own.startsWith('detached ')) {
          await registry.interruptDiscard(lock, `could not dispose of nested worker ${child.tag}: ${result}`)
          return `error: could not dispose of nested worker ${child.tag}: ${result}; retained ${w.dir}`
        }
      }
      await registry.markDiscardStep(lock, 'children')
      // A headless host can take its child server down as it exits. Record and stop
      // worktree processes while they are still observable, before dismissing it.
      const cleanupErrors: string[] = []
      const beforeStop = await workerRealState(s.dir, w, { process: true, hasHandle: !!rooms.handle?.(s, w.id), probe: state.ctx?.probe })
      const verifiedProcess = decideStop(beforeStop).host === 'signal'
      const terminated = borrowed || workerRecord?.outside ? [] : await stopOwnedWorktreeProcesses(s.dir, w, s.me.name, (await ownershipRecords(s)), cleanupErrors, state.ctx?.probe, state.ctx?.listCwdProcesses)
      if (state.workerAlive(s, w) || pidPresent(w.pid, state.ctx?.probe)) {
        const how = await state.dismissWorker(s, w, 'discarded by the lead')
        if ((await localWorkers(s.dir, record => record.id === w.id))[0]?.status === 'running' && (state.workerAlive(s, w) || pidPresent(w.pid, state.ctx?.probe))) {
          await registry.interruptDiscard(lock, `could not discard ${w.tag}: ${how}`)
          return 'could not discard ' + w.tag + ': ' + how + (cleanupErrors.length ? '; ' + cleanupErrors.join('; ') : '')
        }
        if (how.includes('cwd process cleanup failed:')) cleanupErrors.push(how)
        const stopped = await stopWorkerWithEscalation({
          terminate: () => true, exited: () => !state.workerAlive(s, w),
          force: async () => decideStop(await workerRealState(s.dir, w, { process: true, hasHandle: !!rooms.handle?.(s, w.id), probe: state.ctx?.probe })).host === 'signal'
            && signalWorker(w.pid, 'SIGKILL', undefined, undefined, w, state.ctx?.probe),
          now: state.now, sleep: state.ctx?.sleep,
        })
        if (!stopped) throw new Error('worker process has not stopped')
      }
      await registry.markDiscardStep(lock, 'stop')
      const unsafeAfterDismissal = await unverifiedLive(s, w)
      if (unsafeAfterDismissal) {
        await registry.interruptDiscard(lock, unsafeAfterDismissal)
        return unsafeAfterDismissal
      }
      if (!borrowed && !workerRecord?.outside) terminated.push(...await stopOwnedWorktreeProcesses(s.dir, w, s.me.name, (await ownershipRecords(s)), cleanupErrors, state.ctx?.probe, state.ctx?.listCwdProcesses))
      // A failed inspection is not an empty process table. Do not publish a
      // recovery snapshot or delete a checkout whose writers we cannot inspect.
      if (cleanupErrors.length) throw new Error(cleanupErrors.join('; '))
      const afterStop = await workerRealState(s.dir, w, { ownership: !workerRecord?.outside, leadName: s.me.name, workers: (await ownershipRecords(s)) })
      const missing = !workerRecord?.outside && !borrowed && decideDiscard(afterStop) === 'prune'
      let missingDetail: string | undefined
      if (missing) {
        try { missingDetail = await pruneMissingWorkerWorktree(s.dir, w) }
        catch (error) {
          // A persisted worker may outlive a lead that rejoins from another checkout.
          // Its verified process can still be dismissed, but the new checkout must not
          // prune a branch for a worktree path that is outside its own repository.
          const recordedPath = path.basename(w.dir) === w.tag
            && path.basename(path.dirname(w.dir)) === 'workers'
            && path.basename(path.dirname(path.dirname(w.dir))) === '.room'
            && w.branch === `room/${w.tag}`
          if (!verifiedProcess || !recordedPath || !(error instanceof Error) || !error.message.includes('is not an owned Room worktree')) throw error
        }
        cleanupWorkerLogs(s.dir, workerRecord!)
      }
      const ownedWorktree = !borrowed && decideDiscard(afterStop) === 'cleanup'
      const ignored = ownedWorktree ? await ignoredWorkerArtifacts(w, s.dir) : []
      if (ignored.length && a.force !== true) {
        await registry.interruptDiscard(lock, `ignored artifacts appeared: ${ignored.join(', ')}`)
        return ignoredDiscardRefusal(w.tag, w.dir, ignored, [
          ...ignored.map(p => `kept ${p} at ${path.join(w.dir, p)}`),
          ...(terminated.length ? ['stopped processes: ' + terminated.join(', ')] : []),
          ...cleanupErrors,
        ])
      }
      const patch = ownedWorktree ? await saveDiscardPatch(s.dir, w, bytes => registry.recordDiscardPatch(lock, bytes)) : undefined
      await registry.markDiscardStep(lock, 'patch')
      const preservation: WorkerCleanupPreservation = { ignored: [], uncollected: [] }
      if (ownedWorktree && !await cleanupWorker(s.dir, w, { collected: true, discarded: true, terminatedProcesses: terminated, processOptions: { probe: state.ctx?.probe, list: state.ctx?.listCwdProcesses }, leadName: s.me.name, workers: (await ownershipRecords(s)), preservation })) throw new Error('worker is not an owned Room worktree')
      if (borrowed || workerRecord?.outside) cleanupWorkerLogs(s.dir, workerRecord!)
      await registry.markDiscardStep(lock, 'cleanup')
      releaseClaimsOnDone(s, () => false, w.name, false)
      await registry.markDiscardStep(lock, 'prune')
      const retiredAt = Date.now()
      await retireWorker(rooms, s, lock, {
        name: w.name, tag: w.tag, lead: w.lead, host: w.host, ...(w.model ? { model: w.model } : {}), task: w.task,
        summary: borrowed ? 'detached' : 'discarded', files: [], fileCount: 0, startedAt: w.startedAt,
        finishedAt: w.finishedAt ?? retiredAt, retiredAt, outcome: 'dismissed', disposition: 'discarded',
      })
      return [...sharedResults, ...childResults, (borrowed
        ? `detached ${w.tag}; the worktree belongs to ${borrowedOwner?.tag ?? w.sharedWith}`
        : workerRecord?.outside || decideDiscard(afterStop) === 'retain-directory' ? `stopped ${w.tag}; kept ${w.dir} (an existing directory, not a Room worktree)` : 'discarded ' + w.tag) + (missingDetail ? '; its worktree was already gone; ' + missingDetail : '') + (patch ? '; recovery patch: ' + patch + ' (kept for a week)' : '') + (preservation.recoveryRef ? '; branch recovery ref: ' + preservation.recoveryRef : '') + (terminated.length ? '; stopped processes: ' + terminated.join(', ') : '') + (ignored.length ? '; deleted without a copy: ' + ignored.join(', ') : '') + (cleanupErrors.length ? '; ' + cleanupErrors.join('; ') : '')].join('\n')
    } catch (e) {
      await registry.interruptDiscard(lock, e instanceof Error ? e.message : String(e)).catch(() => {})
      return 'error: ' + (e instanceof Error ? e.message : String(e)) + '; retained ' + w.dir
    }
    finally { await registry.finishOperation(lock) }
  }
  type CollectCandidate = { s: Session; w: LocalWorker }
  /** One room_collect call's shared state; the call keeps ownership of locks and the abort/finally paths. */
  type CollectRun = {
    a: Record<string, unknown>; lead: Session; leadRoot: string; registry: Registry; out: string[]
    workerLocks: string[]; now: () => number; sleep: (ms: number) => Promise<void>; nextPhase: (name: string) => void
  }
  type MergePlan = {
    heads: Map<string, string>; result: Awaited<ReturnType<typeof buildCombinedTree>>
    snapshots: Map<string, Awaited<ReturnType<typeof keptSnapshot>>>
    changes: { p: string; file: string; before: Buffer | null; after: Buffer | null; mode: number; oldMode: number }[]
    destinations: { p: string; identity: FileIdentity }[]
  }
  /**
   * Inspect and reserve one candidate: re-verify it after taking its operation lock (pushed to
   * `run.workerLocks`; the caller's finally releases it), stop its worktree processes and wait for
   * its exit. Undefined when it is skipped; notes go to `run.out`. With a tag, failures throw.
   */
  const reserveCandidate = async (run: CollectRun, s: Session, candidate: LocalWorker): Promise<{ w: LocalWorker; root: string } | undefined> => {
    const { a, lead, leadRoot, registry, out, workerLocks, now, sleep } = run
    let w = candidate
    const unsafe = await unverifiedLive(s, w)
    if (unsafe) { out.push(unsafe); return undefined }
    const stopped = w.pid > 0 && !state.workerAlive(s, w) && !pidPresent(w.pid, state.ctx?.probe)
    const decision = decideCollect(await workerRealState(lead.dir, w), !!a.tag, stopped)
    if (decision === 'skip-status') { out.push('skipped ' + w.tag + ': ' + w.status + (w.status === 'failed' ? ` (${failureReason(w)})` : '')); return undefined }
    if (decision === 'skip-partial') {
      const why = w.stopReason === 'lead-session-ended' ? "the lead's session ended" : 'its process exited'
      out.push(`skipped ${w.tag}: stopped before finishing (${why}); room_collect tag=${w.tag} to take its partial edits, mode=copy for named files, or discard=true`)
      return undefined
    }
    const workerLock = await takeWorkerOperation(s, w, 'collect')
    if (workerLock === 'untrusted') { out.push(`skipped ${(await missingCapability(s, w))}`); return undefined }
    if (workerLock === 'busy') { out.push(`skipped ${w.tag}: already being handled`); return undefined }
    workerLocks.push(workerLock)
    try {
      const unsafeAfterLock = await unverifiedLive(s, w)
      if (unsafeAfterLock) { out.push(unsafeAfterLock); return undefined }
      // Reserving can wait for retirement; judge the checkout again once this worktree is locked.
      if (decideCollect(await workerRealState(lead.dir, w), !!a.tag, stopped) === 'missing') {
        await pruneMissingWorkerWorktree(lead.dir, w, false)
        out.push(`${a.tag ? 'nothing to collect' : 'skipped ' + w.tag}: worktree ${w.dir} is gone`)
        return undefined
      }
      const workerRoot = fs.realpathSync(w.dir)
      if (workerRoot === leadRoot) throw new Error('worker must have a separate worktree')
      await assertNoOperation(w.dir)
      if (await realGitCommonDir(lead.dir) !== await realGitCommonDir(w.dir)) throw new Error('worker is not a worktree of this repository')
      const worktreeRecord = (await registry.read(w.id))
      const ownerRecord = worktreeRecord && (await registry.worktreeOwner(worktreeRecord))
      const expectedBranch = ownerRecord?.branch ?? w.branch
      if ((!ownerRecord && w.branch !== 'room/' + w.tag) || (await git(w.dir, ['branch', '--show-current'])).trim() !== expectedBranch) throw new Error('worker must be on its recorded Room branch')
      await gitWholeTree(w.dir, ['ls-files', '-z'])
      const cleanupErrors: string[] = []
      const terminated = await stopOwnedWorktreeProcesses(lead.dir, w, s.me.name, (await ownershipRecords(s)), cleanupErrors, state.ctx?.probe, state.ctx?.listCwdProcesses)
      if (terminated.length) out.push('stopped processes from ' + w.tag + ': ' + terminated.join(', '))
      out.push(...cleanupErrors.map(error => `${w.tag}: ${error}`))
      const deadline = now() + EXIT_WAIT_MS
      while (state.workerAlive(s, w) && now() < deadline) await sleep(Math.min(250, deadline - now()))
      if (state.workerAlive(s, w)) { out.push(`skipped ${w.tag}: process still exiting after 15 s; call room_collect tag=${w.tag} again in a few seconds`); return undefined }
      const unsafeAfterWait = await unverifiedLive(s, w)
      if (unsafeAfterWait) { out.push(unsafeAfterWait); return undefined }
      const current = (await localWorkers(s.dir, record => record.id === w.id))[0]
      if (!current || current.id !== w.id || current.startedAt !== w.startedAt || (current.status !== 'done' && !(stopped && (current.status === 'running' || current.status === 'dismissed')))) {
        out.push('skipped ' + w.tag + ': changed while waiting'); return undefined
      }
      w = current.status === 'done' ? current : { ...current, status: 'done', exitCode: current.exitCode ?? 0 }
      // Its report wins over a later abnormal exit (registry §6): the reported work is collected, and the lead told.
      const abnormal = current.status === 'done' ? await exitAfterReport(s, w) : undefined
      if (abnormal) out.push(`${w.tag} reported done, then its host process exited abnormally (${abnormal}); collecting what it reported`)
      return { w, root: workerRoot }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      if (a.tag) throw e
      out.push(`skipped ${w.tag}: ${(await workerRealState(lead.dir, w)).worktree === 'vanished' ? 'worktree missing; ' : ''}${reason}`)
      return undefined
    }
  }
  /** Copy mode: install the named files from one worker with all-or-nothing rollback; the worker stays recoverable. */
  const applyCopy = async (run: CollectRun, { s, w }: CollectCandidate, workerRoot: string): Promise<string> => {
    const { a, lead, leadRoot, out } = run
    const releasePaths = (paths: string[]) => releaseClaimsOnDone(s, c => !paths.some(p => claimsOverlap(c, { path: p, from: 1, to: Number.MAX_SAFE_INTEGER })), w.name, false)
    if (!Array.isArray(a.paths) || !a.paths.length || a.paths.some(p => typeof p !== 'string')) return 'error: copy requires non-empty paths'
    const files = await copyFiles(workerRoot, a.paths as string[])
    // Installation must have no await between its final gate and last rename.
    if (files.length > COPY_INSTALL_LIMIT) return `error: copy has more than ${COPY_INSTALL_LIMIT} files; split the selection`
    const modified = new Set(split(await gitWholeTree(lead.dir, ['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--'])))
    const tracked = new Set(split(await gitWholeTree(lead.dir, ['ls-files', '-z'])))
    const copyPlan: { p: string; source: NonNullable<FileIdentity>; destination: FileIdentity }[] = []
    for (const [index, p] of files.entries()) {
      if (index % COLLECT_YIELD_EVERY === 0) await setImmediate()
      const src = safePath(workerRoot, p), source = fileIdentity(src)
      if (!source) throw new Error('copy source vanished: ' + p)
      const dst = safePath(leadRoot, p)
      const destination = fileIdentity(dst)
      if (a.force !== true && (modified.has(p) || (!tracked.has(p) && destination !== null))) {
        // Large matching files are a conservative conflict. Explicit force can
        // still copy them without bringing their bytes into JS for comparison.
        if (destination === null || destination.size !== source.size || source.size > COLLECT_FILE_LIMIT || !await sameFileBytes(dst, src, source.size)) return 'error: lead has modified ' + p + '; pass force=true to overwrite'
        if (!sameIdentity(source, fileIdentity(src)) || !sameIdentity(destination, fileIdentity(dst))) throw new Error(p + ' changed during collection; nothing written, retry')
      }
      copyPlan.push({ p, source, destination })
    }
    const stagedRoot = fs.mkdtempSync(path.join(leadRoot, '.room', 'collect-copy-'))
    let keepRecovery = false
    try {
      const prepared = [] as (typeof copyPlan[number] & { staged: string; backup: string })[]
      for (const [index, plan] of copyPlan.entries()) {
        if (index % COLLECT_YIELD_EVERY === 0) await setImmediate()
        const staged = path.join(stagedRoot, `${index}.new`)
        await fs.promises.copyFile(safePath(workerRoot, plan.p), staged)
        fs.chmodSync(staged, plan.source.mode)
        prepared.push({ ...plan, staged, backup: path.join(stagedRoot, `${index}.old`) })
      }
      // Recheck every source and destination after all asynchronous preparation.
      for (const { p, source, destination } of prepared) {
        if (!sameIdentity(source, fileIdentity(safePath(workerRoot, p))) || !sameIdentity(destination, fileIdentity(safePath(leadRoot, p)))) throw new Error(p + ' changed during collection; nothing written, retry')
      }
      const installed: { dst: string; staged: string; backup: string; hadOriginal: boolean; copied: boolean }[] = []
      try {
        // Only bounded, synchronous metadata operations occur from the gate through
        // the final rename. Retain old leaves for rollback if a later rename fails.
        for (const { p, destination, staged, backup } of prepared) {
          const dst = safePath(leadRoot, p)
          if (!sameIdentity(destination, fileIdentity(dst))) throw new Error(p + ' changed during collection; nothing written, retry')
          fs.mkdirSync(path.dirname(dst), { recursive: true })
          const checked = safePath(leadRoot, p)
          if (!sameIdentity(destination, fileIdentity(checked))) throw new Error(p + ' changed during collection; nothing written, retry')
          const entry = { dst: checked, staged, backup, hadOriginal: destination !== null, copied: false }
          if (entry.hadOriginal) fs.renameSync(checked, backup)
          installed.push(entry)
          fs.renameSync(staged, checked)
          entry.copied = true
        }
      } catch (error) {
        const rollbackErrors: string[] = []
        for (const entry of installed.reverse()) {
          try {
            if (entry.copied) fs.unlinkSync(entry.dst)
            if (entry.hadOriginal) fs.renameSync(entry.backup, entry.dst)
          } catch (rollbackError) { rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)) }
        }
        if (rollbackErrors.length) {
          keepRecovery = true
          throw new Error(`copy failed; rollback incomplete; originals kept in ${stagedRoot}: ${rollbackErrors.join('; ')}`, { cause: error })
        }
        throw error
      }
      for (const { p } of prepared) out.push('copied ' + p)
    } finally {
      if (!keepRecovery) await fs.promises.rm(stagedRoot, { recursive: true, force: true })
    }
    releasePaths(files)
    if (!files.length) out.push('nothing copied (empty directories)')
    out.push(await collectedTreeEvidence(leadRoot))

    // Named artifacts are only a partial collection; keep the worker recoverable.
    return out.join('\n')
  }
  /**
   * Merge plan: build the combined tree from the selected workers, refuse on provenance gaps,
   * unsupported files or conflicts (nothing written), take keep snapshots, and compute each
   * destination's change and mode against the lead's current bytes.
   */
  const prepareMergePlan = async (run: CollectRun, selected: CollectCandidate[], workerRoots: ReadonlyMap<LocalWorker, string>): Promise<{ refusal: string } | MergePlan> => {
    const { a, lead, leadRoot, out, nextPhase } = run
    // Latin-1 transports bytes losslessly through the text engine, including binary additions.
    // Resolve each HEAD inside the assembly capture used by all merge consumers.
    const result = await buildCombinedTree({ ...state, baseFor: () => 'HEAD', shareOf: () => 'full' }, lead,
      selected.map(({ s, w }) => ({ session: s, person: w.name })), {
        diskOnly: true, encoding: 'latin1', skipCallerOnly: true, limit: COLLECT_FILE_LIMIT,
        roots: new Map([[path.resolve(lead.dir), leadRoot], ...selected.map(({ w }) => [path.resolve(w.dir), workerRoots.get(w)!] as const)]),
      })
    const heads = new Map([[lead.me.name, result.inputs.headFor(lead.dir)!]])
    const capturedWorkers = new Map(selected.map(({ s, w }) => {
      const captured = result.inputs.worker(s, w.name)
      if (!captured || captured.id !== w.id) throw new Error(`${w.name}: worker authorization changed during collection; nothing written, retry`)
      heads.set(w.name, result.inputs.headFor(captured.dir)!)
      return [w.name, captured] as const
    }))
    const provenance = result.gaps.filter(gap => gap.kind === 'provenance')
    if (provenance.length) return { refusal: [...out, 'Nothing written; preview provenance is incomplete: ' + provenance.map(gap => `${gap.person}${gap.path ? ': ' + gap.path : ''}: ${gap.why}`).join('; ') + '. All selected workers kept.'].join('\n') }
    const unsupported = result.ignoredNotes.filter(note => !note.includes('gitignored') && !note.includes('linked input'))
    if (unsupported.length) {
      // Over-limit worker files have one remedy: copy them, so the next collect sees the same bytes on both sides.
      const remedy = selected.map(({ w }) => {
        const large = result.gaps.filter(gap => gap.person === w.name && gap.path && gap.why.startsWith('over ')).map(gap => gap.path!)
        return large.length ? ` Copy them first with room_collect(tag="${w.tag}", mode="copy", paths=${JSON.stringify(large)}) then collect again.` : ''
      }).join('')
      return { refusal: [...out, 'Nothing written; files need manual collection: ' + unsupported.join('; ') + '. All selected workers kept.' + remedy].join('\n') }
    }
    const tags = (names: string[]) => names.map(name => selected.find(x => x.w.name === name)?.w.tag ?? 'your edits').join(', ')
    if (result.conflictingPaths.size) return { refusal: [...out, 'Nothing written; conflicting files: ' + [...result.conflictingPaths].map(([p, names]) => p + ' (' + tags(names) + ')').join('; '), 'Collect one at a time, or resolve by hand using room_read.'].join('\n') }
    const snapshots = new Map<string, Awaited<ReturnType<typeof keptSnapshot>>>()
    if (a.keep === true) for (const { w } of selected) snapshots.set(w.id,
      await keptSnapshot(capturedWorkers.get(w.name)!, workerRoots.get(w)!, heads.get(w.name)!, result.paths, result.scratch.get(w.name)))
    const changes: MergePlan['changes'] = []
    nextPhase('prepare')
    // A worker's mode change is judged against its own base, like its text.
    const baseModes = new Map<string, Map<string, number>>()
    const unchangedCarried = new Map<string, Set<string>>()
    for (const { w } of selected) {
      const base = result.deltaBases.get(w.name)!
      const record = result.inputs.records.get(w.name)!
      baseModes.set(w.name, addCarriedUntrackedModes(await gitTreeModes(lead.dir, base), record))
      unchangedCarried.set(w.name, carriedUnchangedPaths(workerBaseline(record)))
    }
    const destinations: MergePlan['destinations'] = []
    let preparedCount = 0
    for (const [p, text] of result.merged) {
      if (preparedCount++ % COLLECT_YIELD_EVERY === 0) await setImmediate()
      const file = safePath(leadRoot, p)
      const identity = fileIdentity(file)
      destinations.push({ p, identity })
      const before = boundedCollectText(file, identity)
      if ((before === null ? null : before.toString('latin1')) !== result.initial.get(p)) throw new Error(p + ' changed during collection; nothing written, retry')
      const oldMode = identity?.mode ?? 0o644
      const mode = mergedFileMode(p, oldMode, selected.map(({ w }) => {
        const record = result.inputs.records.get(w.name)!
        return { dir: workerRoots.get(w)!, baseModes: baseModes.get(w.name)!, ownedPaths: workerOwnedPaths(record), unchangedCarried: unchangedCarried.get(w.name), carriedPaths: new Set(record.carriedUntracked?.map(entry => entry.path) ?? []) }
      }))
      const after = text === null ? null : Buffer.from(text, 'latin1')
      if ((before?.equals(after ?? Buffer.alloc(0)) && after !== null && mode === oldMode) || (before === null && after === null)) continue
      changes.push({ p, file, before, after, mode, oldMode })
    }
    return { heads, result, snapshots, changes, destinations }
  }
  /**
   * Apply a merge plan: mark collection started (ids go to `collectStarted`, which the caller aborts
   * on failure), pin each worker's source refs, then write every change after one final identity
   * gate, restoring originals if any write fails.
   */
  const applyMergePlan = async (run: CollectRun, selected: CollectCandidate[], workerRoots: ReadonlyMap<LocalWorker, string>, plan: MergePlan, collectStarted: Set<string>): Promise<void> => {
    const { lead, leadRoot, registry } = run
    const { heads, result, snapshots, changes, destinations } = plan
    // Start collection and publish the source metadata before the final destination
    // gate. An aborted attempt may leave these refs; the next collection overwrites
    // them, and worker cleanup removes them.
    for (const { w } of selected) if (w.id) {
      await registry.beginCollect(w.id)
      collectStarted.add(w.id)
    }
    // Keep the exact source HEAD and merge baseline used by this collection. A
    // retained shared checkout may receive another commit before its last user exits.
    for (const { w } of selected) {
      const record = result.inputs.records.get(w.name)!
      writeWorkerRecordRef(registry.commonDir, collectHeadRef(w.tag, w.id), snapshots.get(w.id)?.sha ?? heads.get(w.name)!, record)
      writeWorkerRecordRef(registry.commonDir, collectBaseRef(w.tag, w.id), result.deltaBases.get(w.name)!, record)
    }
    // No await from this final identity gate through the last destination write.
    // Restore originals on any write failure.
    for (const { p, identity } of destinations) {
      if (!sameIdentity(identity, fileIdentity(safePath(leadRoot, p)))) throw new Error(p + ' changed during collection; nothing written, retry')
    }
    for (const { w } of selected) for (const { p, identity } of snapshots.get(w.id)?.sources ?? []) {
      if (!sameIdentity(identity, fileIdentity(safePath(workerRoots.get(w)!, p)))) throw new Error(p + ' changed during collection; nothing written, retry')
    }
    const written: typeof changes = []
    try {
      for (const change of changes) {
        written.push(change)
        materializeMergedFile(leadRoot, change.p, change.after, change.mode)
      }
    } catch (e) {
      for (const change of written.reverse()) {
        materializeMergedFile(leadRoot, change.p, change.before, change.oldMode)
      }
      throw e
    }
  }
  const roomCollect = async (a: Record<string, unknown>, discarding = new Set<string>(), actingLead?: Session): Promise<string> => {
    const { rooms } = state, lead = actingLead ?? state.S()
    const registry = await registryForDir(lead.dir)
    const unknown = Object.keys(a).find(key => !['tag', 'mode', 'discard', 'keep', 'paths', 'force'].includes(key))
    if (unknown) return 'error: unknown argument ' + unknown
    if (a.tag !== undefined && (typeof a.tag !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(a.tag))) return 'error: valid worker tag required'
    if (a.mode !== undefined && a.mode !== 'apply' && a.mode !== 'copy') return 'error: mode must be apply or copy'
    for (const key of ['discard', 'force', 'keep']) if (a[key] !== undefined && typeof a[key] !== 'boolean') return 'error: ' + key + ' must be a boolean'
    if (a.keep === true && (a.discard || a.mode === 'copy')) return 'error: keep is only supported in apply mode without discard'
    if ((a.discard || a.mode === 'copy') && !a.tag) return 'error: tag required for copy or discard'
    if (a.paths !== undefined && a.mode !== 'copy') return 'error: paths is only supported in copy mode'
    if (a.discard) return await discardKeptWorktree(a, registry, discarding) ?? await discardWorker(a, lead, registry, discarding, actingLead)
    const sessions = a.tag ? [(await holdingWorker(a.tag as string, lead))] : rooms.all()
    const candidates = (await Promise.all(sessions.map(async s => (await asyncFilter((await localWorkers(s.dir, record => record.room === s.roomName)), async w => {
      if (a.tag && w.tag !== a.tag) return false
      const owner = (await ownership(s, w, discarding))
      return owner.owned && (!owner.liveLead || !!a.tag)
    })).map(w => ({ s, w }))))).flat()
      .sort((a, b) => (a.w.finishedAt ?? 0) - (b.w.finishedAt ?? 0) || (a.w.tag < b.w.tag ? -1 : a.w.tag > b.w.tag ? 1 : 0))
    if (a.tag && !candidates.length) return 'error: no worker ' + a.tag + ' owned by you'
    if (a.tag) {
      const { s, w } = candidates[0]
      const owner = (await ownership(s, w, discarding))
      if (owner.liveLead) return `error: ${w.tag} belongs to ${owner.liveLead}, which is still running; ask it with room_send, or discard ${owner.liveLead}'s worker first`
    }
    const out: string[] = []
    const selected: typeof candidates = []
    const leadRoot = fs.realpathSync(lead.dir)
    const workerRoots = new Map<LocalWorker, string>()
    const workerLocks: string[] = []
    const collectStarted = new Set<string>()
    const timing = currentToolTiming()
    let endPhase = timing?.begin('inspect')
    const nextPhase = (name: string) => { endPhase?.(); endPhase = timing?.begin(name) }
    const now = state.now ?? Date.now
    const sleep = state.ctx?.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
    const run: CollectRun = { a, lead, leadRoot, registry, out, workerLocks, now, sleep, nextPhase }
    const nothingLeft: string[] = []
    try {
      for (const item of candidates) {
        const { s } = item; let { w } = item
        // Its output is already applied; only cleanup remains, once its host is confirmed gone. keep=true instead
        // collects it again under the operation lease (already-present output writes nothing) and replaces the
        // pending cleanup with a kept baseline; a refusal leaves it pending.
        const holder = await registryForDir(s.dir)
        const currentRecord = await holder.read(w.id)
        if (currentRecord?.outside && currentRecord.capabilities.collect === 'none') {
          const trusted = await holder.trustedOutside({ participant: s.me.name, room: s.roomName }, w.tag)
          if (!trusted || trusted.record.id !== w.id) { out.push(`skipped ${await missingCapability(s, w)}`); continue }
          const retired = a.keep !== true && a.mode !== 'copy' && await retireIfNothingToCollect(s.dir, holder, trusted.record,
            { probe: state.ctx?.probe, hasHandle: x => state.workerAlive(s, x) })
          out.push(outsideCollectLine(trusted.record) + (retired ? `; retired ${w.tag}` : `; room_collect(tag="${w.tag}", discard=true) ends its record`))
          if (retired) await rooms.project()
          continue
        }
        const record = a.mode !== 'copy' && a.keep !== true ? currentRecord : undefined
        if (record?.collectPending) {
          out.push(await finishPendingCollect(s, rooms, w.id, { probe: state.ctx?.probe, list: state.ctx?.listCwdProcesses,
            alive: x => state.workerAlive(s, x) || workerProcessOwnership(x.pid, x, state.ctx?.probe) !== 'not-ours' }) ?? `skipped ${w.tag}: changed while waiting`)
          continue
        }
        // Collecting means finishing with it; with nothing left to collect that is retirement, reported once below.
        if (record && await retireIfNothingToCollect(s.dir, holder, record, { probe: state.ctx?.probe, hasHandle: x => state.workerAlive(s, x) })) {
          nothingLeft.push(w.tag)
          continue
        }
        // A worker that reported done is running until its host exits; the done notice promises this wait.
        const reported = await (await openWorkerReader(s.dir)).status(w.id)
        if (w.status === 'running' && reported?.status === 'running' && reported.summary !== undefined) {
          const deadline = now() + EXIT_WAIT_MS
          let current: LocalWorker | undefined = w
          while (current?.status === 'running' && now() < deadline) {
            await sleep(Math.min(250, deadline - now()))
            current = (await localWorkers(s.dir, record => record.id === w.id))[0]
          }
          if (!current) { out.push('skipped ' + w.tag + ': changed while waiting'); continue }
          if (current.status === 'running') { out.push(`skipped ${w.tag}: reported done, but its process is still exiting after 15 s; call room_collect tag=${w.tag} again in a few seconds`); continue }
          w = current
        }
        const reserved = await reserveCandidate(run, s, w)
        if (!reserved) continue
        selected.push({ s, w: reserved.w })
        workerRoots.set(reserved.w, reserved.root)
      }
      if (nothingLeft.length) {
        await rooms.project()
        out.push(nothingToCollectLine(nothingLeft))
      }
      if (!selected.length) return out.join('\n') || 'No finished changes to collect.'
      nextPhase(a.mode === 'copy' ? 'copy' : 'merge')
      await assertNoOperation(lead.dir)
      if (a.mode === 'copy') return await applyCopy(run, selected[0], workerRoots.get(selected[0].w)!)
      const plan = await prepareMergePlan(run, selected, workerRoots)
      if ('refusal' in plan) return plan.refusal
      const { result, snapshots, changes } = plan
      await applyMergePlan(run, selected, workerRoots, plan, collectStarted)
      out.push('Changes from ' + selected.map(x => x.w.tag).join(', ') + ': ' + (changes.map(x => x.p).join(', ') || 'already present') + '. Nothing committed or staged.')
      // Worker scratch is not merged; keep a copy before cleanup removes the worktrees.
      const scratchSelected = selected.filter(({ w }) => result.scratch.has(w.name))
      const scratchNote = scratchCollectNote(result.scratch, name => selected.find(x => x.w.name === name)?.w.tag ?? name,
        saveWorkerScratch(leadRoot, scratchSelected.map(({ w }) => ({ tag: w.tag, root: workerRoots.get(w)!, paths: result.scratch.get(w.name)! }))))
      if (scratchNote) out.push(scratchNote)
      nextPhase('cleanup')
      let keptPublication: import('../worker-status.js').WorkerRecord['keptPublication']
      if (a.keep === true) {
        const previous = (await Promise.all(selected.map(async ({ w }) => (await registry.read(w.id))?.keptPublication))).filter(value => value !== undefined)
        keptPublication = await acknowledgeKeptPublication(lead, {
          paths: [...new Set(previous.flatMap(value => value.paths))], pending: true,
          ...(previous.some(value => value.overflow) ? { overflow: true } : {}),
        }, changes.map(change => change.p), changes)
        if (keptPublication.pending) out.push('kept preview freshness pending: the lead has not acknowledged a complete post-application publication; plain resume retries it')
      }
      for (const { s, w: chosen } of selected) {
        let w = chosen
        const snapshot = snapshots.get(w.id)
        if (snapshot) {
          // After keep, preview/collect measure the worker from this snapshot. Its collected
          // edits are now in the lead's working tree and participate through the lead's overlay.
          const wasPending = !!(await registry.read(w.id))?.collectPending
          await registry.command(w.id, { type: 'collect-keep', base: snapshot.sha, keptPublication })
          collectStarted.delete(w.id)
          releaseClaimsOnDone(s, () => false, w.name, false)
          out.push(`kept ${w.tag}: finished and resumable; worktree, branch, logs and host session retained` + (wasPending ? '; its pending automatic cleanup is cancelled' : ''))
          continue
        }
        let archived: { entry: RetiredWorker; keptWorktree?: string } | undefined
        // A worktree kept for a reason that can pass (exit unconfirmed, ignored output, nested workers, failed
        // cleanup) stays with a live record; a later collect or the sweep finishes it (finishPendingCollect).
        let pending: string | undefined
        const finishOne = async () => {
          if (pending) await registry.deferCollectCleanup(w.id, pending)
          else if (archived) {
            await retireWorker(rooms, s, w.id, archived.entry, archived.keptWorktree ? { keptWorktree: archived.keptWorktree } : {})
            const note = await cleanRetiredSharedOwner(s, w)
            if (note) out.push(note)
          }
          else await registry.abortCollect(w.id)
          collectStarted.delete(w.id)
        }
        releaseClaimsOnDone(s, () => false, w.name, false)
        const retire = (summary: string, keptWorktree?: string, keptReason?: string) => {
          const retiredAt = Date.now()
          const files = result.paths.filter(p => result.owners.get(p)?.includes(w.name))
          archived = { keptWorktree, entry: {
            name: w.name, tag: w.tag, lead: w.lead, host: w.host, ...(w.model ? { model: w.model } : {}),
            task: w.task, summary, ...(keptWorktree ? { keptWorktree, keptReason } : {}), files, fileCount: files.length,
            startedAt: w.startedAt, finishedAt: w.finishedAt ?? retiredAt, retiredAt, outcome: 'dismissed', disposition: 'collected',
          } }
        }
        // Collection does not block on a process: an unconfirmed exit keeps the record live with its worktree, and a
        // later collect or the sweep finishes cleanup once the process is gone (finishPendingCollect).
        const unconfirmed = (await uncleanExit(s, w))
        if (unconfirmed) {
          pending = unconfirmed
          out.push(`kept ${w.tag}: changes collected; clean exit not confirmed (${unconfirmed}); cleaned up by a later room_collect or the automatic sweep once its process is gone`)
          await finishOne()
          continue
        }
        const keepLive = (reason: string) => {
          pending = reason
          out.push(`${w.tag}'s record stays live with its worktree; a later room_collect or the automatic sweep finishes cleanup once that is resolved, or discard=true removes it`)
        }
        // The host's exit is witnessed (uncleanExit): a nonzero code after its report, or an exit 0 recorded after
        // the status was read, does not make the collected output failed.
        if (w.exitCode !== 0) w = { ...w, exitCode: 0 }
        try {
          const record = (await registry.read(w.id))
          const owner = record && (await registry.worktreeOwner(record))
          if (record && (record.sharedWith || owner)) {
            retire(w.summary ?? '')
            out.push(`detached ${w.tag}; the worktree belongs to ${owner?.tag ?? record.sharedWith}`)
            await finishOne()
            continue
          }
          // A live borrower keeps the owner's checkout: the owner retires now and the checkout follows the borrower.
          const running = record && requireWorkerEvidence(await registry.checkoutUsers(record)).find(({ status }) => !['done', 'failed', 'stopped'].includes(status.status))
          if (running) {
            out.push(`kept ${w.tag}'s worktree: ${running.record.tag} is still running in it`)
            retire(w.summary ?? '', w.dir, `shared checkout: ${running.record.tag}`)
            await finishOne()
            continue
          }
          // The same rules a later collect and the sweep apply (retire.ts); finished borrowers are retired first.
          const result = await removeCollectedCheckout(s, record, w, { probe: state.ctx?.probe, list: state.ctx?.listCwdProcesses, alive: other => state.workerAlive(s, other) }, {
            justCollected: true,
            retireUser: async user => {
              const reply = await roomCollect({ tag: user.tag, discard: true }, discarding, s)
              if (!reply.startsWith('detached ')) throw new Error(`could not retire ${user.tag} before cleaning ${w.tag}: ${reply}`)
              out.push(`retired ${user.tag} with ${w.tag}`)
            },
          })
          if (result.removed) {
            retire(w.summary ?? '')
            out.push('cleaned up ' + w.tag + ': temporary files and logs')
            if (result.recoveryRef) out.push('branch recovery ref: ' + result.recoveryRef)
            if (result.terminated.length) out.push('stopped processes from ' + w.tag + ': ' + result.terminated.join(', '))
          } else {
            out.push(`kept ${w.tag}: ${result.reason}`, ...result.lines ?? [])
            keepLive(result.reason)
          }
        } catch (e) {
          const reason = 'cleanup incomplete: ' + (e instanceof Error ? e.message : String(e))
          out.push('cleanup incomplete for ' + w.tag + ': ' + (e instanceof Error ? e.message : String(e)))
          // A slow or failed `git worktree remove` is retried, never retired over (see finishPendingCollect).
          archived = undefined
          keepLive(reason)
        }
        await finishOne()
      }
      out.push(await collectedTreeEvidence(leadRoot))
      return out.join('\n')
    } catch (e) {
      for (const id of collectStarted) await registry.abortCollect(id).catch(() => {})
      return [...out, 'error: ' + (e instanceof Error ? e.message : String(e))].join('\n')
    }
    finally { endPhase?.(); for (const workerLock of workerLocks) await registry.finishOperation(workerLock) }
  }
  return { room_collect: async a => {
    const session = state.S()
    if (a.checkpoint !== undefined) return 'error: checkpoint moved to room_review; use action hold, release or status'
    const unknown = Object.keys(a).find(key => !['tag', 'mode', 'discard', 'keep', 'paths', 'force'].includes(key))
    if (unknown) return 'error: unknown argument ' + unknown
    const registry = await registryForDir(session.dir)
    const endLease = currentToolTiming()?.begin('lease')
    try { return await registry.withCollectLease(session.dir, async () => {
      endLease?.()
      const review = new CollectionReview(registry.root, session.dir)
      review.assertClear()
      const reply = await roomCollect(a)
      return [reply, ...retainedWorkerLines(registry.commonDir)].join('\n')
    }) }
    catch (error) { return [`error: ${error instanceof Error ? error.message : String(error)}`, ...retainedWorkerLines(registry.commonDir)].join('\n') }
    finally { endLease?.() }
  } }
}
