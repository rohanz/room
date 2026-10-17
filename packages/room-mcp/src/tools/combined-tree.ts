import fs from 'node:fs'
import path from 'node:path'
import { git, gitBlobInfoMany, gitWholeTree, isGitTimeout, type GitBlobInfo } from '@room/roomd/git'
import { ensureCommit, roomRemote } from '@room/roomd'
import { DISK_READ_PATH, containedRepoPath, validRepoPath } from '@room/roomd'
import type { Session } from '../session.js'
import { gitMergeFile } from '../merge.js'
import { carryRef, collectHeadRef, workerOwnedPaths } from '../worker-git.js'
import { decidePreview, workerRealState } from '../worker-state.js'
import { carriedCommitUnchangedPaths, carriedPaths, carriedUnchangedPaths, carriesWork, MissingBaseBlob, pairBaseline, type Baseline } from '@room/roomd/baseline'
import { REGENERABLE_BUILD_DIRS, acceptedGit, formatCount, isRegenerableBuildPath, participantRecord, participantsView, snapshot, snapshotMetadata, snapshotStillCurrent, versionOf, type ParticipantGit, type ParticipantSnapshot, type Version } from '@room/shared'
import { trustedWorker, type HandlerState } from './context.js'
import { carriedFrom, localWorkerBaseline, localWorkers, registrySnapshotForDir } from '../worker-registry.js'
import { keptPublicationMatches } from '../kept-publication.js'
import type { LocalWorker } from '../worker-status.js'
import { DISK_TEXT_LIMIT, HistoricalTextTooLarge, readBoundedCheckoutText, readBoundedDiskText } from './disk-text.js'

interface PreviewGap { person: string; path?: string; why: string; kind?: 'provenance' }
type Participant = { person: string; session: Session }

/** How long one preview waits for participants' published changes to settle before reporting a move. */
export const PREVIEW_SETTLE_MS = 12_000
const SETTLE_QUIET_MS = 1_000, SETTLE_POLL_MS = 250

export class PreviewMoved extends Error {
  constructor(readonly people: string[]) { super(`${people.join(', ')} moved during the preview; re-run`) }
}

const viewOf = (state: HandlerState, session: Session) => session.awareness ? participantsView(session.room, session.awareness, state.now?.() ?? Date.now()) : []
const movedSince = (state: HandlerState, snaps: readonly { person: string; session: Session; snap: ParticipantSnapshot | undefined }[]) =>
  snaps.filter(({ session, snap }) => snap && !snapshotStillCurrent(session.room, snap, viewOf(state, session))).map(({ person }) => person)

/**
 * One bounded wait per preview. A worker's room_done republishes its overlay and its exit then ends its
 * holder, so a preview called on its completion message sees it move once or twice within seconds.
 */
export function previewSettler(state: HandlerState, participants: readonly Participant[]) {
  const now = () => state.now?.() ?? Date.now()
  const sleep = state.ctx?.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const deadline = now() + PREVIEW_SETTLE_MS
  const capture = (except: ReadonlySet<string>) => participants.filter(({ person }) => !except.has(person)).map(({ person, session }) => {
    const meta = snapshotMetadata(session.room, person, viewOf(state, session))
    return { person, session, snap: meta && { ...meta, texts: new Map<string, string>() } }
  })
  return {
    /** Waits until nobody (but `except`) has moved for a quiet interval or the bound is spent; false once it already was. */
    async settle(except: ReadonlySet<string> = new Set()): Promise<boolean> {
      if (now() >= deadline) return false
      let snaps = capture(except), quietSince = now()
      while (now() - quietSince < SETTLE_QUIET_MS && now() < deadline) {
        await sleep(Math.min(SETTLE_POLL_MS, deadline - now()))
        if (movedSince(state, snaps).length) { snaps = capture(except); quietSince = now() }
      }
      return true
    },
  }
}

export async function buildCombinedTree(state: HandlerState, caller: Session, participants: Participant[], options: { resolve?: boolean; diskOnly?: boolean; encoding?: BufferEncoding; skipCallerOnly?: boolean; roots?: ReadonlyMap<string, string>; settler?: ReturnType<typeof previewSettler> } = {}) {
  const settler = options.settler ?? previewSettler(state, participants)
  for (;;) {
    const result = await buildCombinedTreeOnce(state, caller, participants, options)
    if (result.current) return result
    if (!await settler.settle(result.settledWorkers())) throw new PreviewMoved(result.moved())
  }
}

const SILENT_IGNORED = /(^|\/)(?:\.venv|venv|__pycache__|node_modules|\.room|\.git|\.cache|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.nox)(?:\/|$)|(^|\/)\.room\.json$|\.tsbuildinfo$|\.py[co]$/
const BUILD_DIRS = new Set<string>(REGENERABLE_BUILD_DIRS)

/** Caches stay silent; regenerable build output is one line for everyone; other ignored paths are named per person. */
export function ignoredOutputNotes(byPerson: ReadonlyMap<string, readonly string[]>): string[] {
  const notes: string[] = [], kinds = new Set<string>(), owners: string[] = []
  let count = 0, allFolders = true
  for (const [person, ignored] of byPerson) {
    const visible = ignored.filter(p => !SILENT_IGNORED.test(p))
    const built = visible.filter(isRegenerableBuildPath)
    for (const p of built) kinds.add((p.split('/').find(part => BUILD_DIRS.has(part)) ?? p) + '/')
    if (built.length) owners.push(person)
    count += built.length
    allFolders &&= built.every(p => p.endsWith('/'))
    const other = visible.filter(p => !isRegenerableBuildPath(p))
    if (other.length) notes.push('NOT previewed (gitignored, ' + person + '): ' + other.join(', '))
  }
  if (count) notes.unshift(`build output not previewed (gitignored, regenerable): ${formatCount(count, allFolders ? 'folder' : 'path')} (${[...kinds].sort().join(', ')}) ${owners.length === 1 ? `from ${owners[0]}` : `across ${owners.length} participants`}`)
  return notes
}

/**
 * Worker scratch names: logs, plus the temp, swap and OS files among roomd's default ignores (defaultIgnoredPath).
 * Its data files (.bin, .zip, .sqlite...) and folders stay previewed and collected: a worker's new test fixture is
 * one. An untracked scratch file that no base holds and spawn did not carry is a worker's own output, not a change
 * to merge; tracked or carried ones are merged like any file.
 */
export const isScratchName = (p: string) => {
  const name = p.slice(p.lastIndexOf('/') + 1)
  return /\.(?:log|tmp)$/i.test(name) || name === '.DS_Store' || name.endsWith('~') || /^(?:\.#.*|\.tmp(?:[.-].*)?|\..+\.(?:tmp(?:[.-].*)?|sw[opx]|part|atomic))$/i.test(name)
}

const SCRATCH_LISTED = 20
const andList = (names: readonly string[]) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
const scratchKind = 'untracked logs or temp files, never committed'
/** Path -> the participants whose worktree holds it as scratch, in path order. */
function scratchByPath(byPerson: ReadonlyMap<string, ReadonlySet<string>>): Map<string, string[]> {
  const byPath = new Map<string, string[]>()
  for (const [person, paths] of byPerson) for (const p of paths) byPath.set(p, [...byPath.get(p) ?? [], person])
  return new Map([...byPath].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
}
const listScratch = (byPath: ReadonlyMap<string, readonly string[]>, describe: (people: readonly string[]) => string) => {
  const items = [...byPath].slice(0, SCRATCH_LISTED).map(([p, people]) => `${p} (${describe(people)})`)
  return items.join(', ') + (byPath.size > SCRATCH_LISTED ? ` and ${byPath.size - SCRATCH_LISTED} more` : '')
}
/** One low-key preview line for worker scratch; two workers' same-named logs are not a conflict. */
function scratchPreviewNote(byPerson: ReadonlyMap<string, ReadonlySet<string>>): string | undefined {
  const byPath = scratchByPath(byPerson)
  if (!byPath.size) return undefined
  return `worker scratch, not previewed (${scratchKind}): ${listScratch(byPath, people => people.length > 1 ? `${andList(people)} each wrote one` : people[0])}; collect does not bring it in`
}

/** Collect's line for worker scratch it did not bring in: where each worker's copy was saved, and anything not saved. */
export function scratchCollectNote(byPerson: ReadonlyMap<string, ReadonlySet<string>>, tagOf: (person: string) => string,
  outcome: { saved: ReadonlyMap<string, readonly string[]>; skipped: readonly { tag: string; path: string; reason: string }[] }): string | undefined {
  const byPath = scratchByPath(byPerson)
  if (!byPath.size) return undefined
  const folders = [...outcome.saved.keys()].sort().map(tag => `.room/scratch/${tag}/`)
  const unsaved = outcome.skipped.slice(0, SCRATCH_LISTED).map(({ tag, path: p, reason }) => `${p} (${tag}: ${reason})`).join(', ')
    + (outcome.skipped.length > SCRATCH_LISTED ? ` and ${outcome.skipped.length - SCRATCH_LISTED} more` : '')
  return `not collected: worker scratch (${scratchKind}): ${listScratch(byPath, people => people.map(tagOf).join(', '))}`
    + (folders.length ? `; saved under ${andList(folders)}` : '') + (unsaved ? `; NOT saved (lost when the worktree is removed; copy with mode=copy first): ${unsaved}` : '')
}

/** The ordered combined-tree engine shared by preview and collection. Never writes a clone. */
async function buildCombinedTreeOnce(state: HandlerState, caller: Session, participants: { person: string; session: Session }[], options: { resolve?: boolean; diskOnly?: boolean; encoding?: BufferEncoding; skipCallerOnly?: boolean; roots?: ReadonlyMap<string, string> } = {}) {
  const { rooms, baseFor } = state
  const people = participants.map(p => p.person)
  const snapshots = new Map<string, { session: Session; snap: ParticipantSnapshot | undefined }>()
  const acceptedRecords = new Map<string, ParticipantGit>()
  if (!options.diskOnly) for (const { person, session } of participants) {
    const view = session.awareness ? participantsView(session.room, session.awareness, state.now?.() ?? Date.now()) : []
    const snap = snapshot(session.room, person, view)
    snapshots.set(person, { session, snap })
    const record = acceptedGit(snap ? snap.record : participantRecord(session.room, person), view)
    if (record !== 'updating') acceptedRecords.set(person, { ...record })
  }
  const gaps: PreviewGap[] = []
  // The caller's own workers' worktrees on this machine are authoritative in any room: their commits and uncommitted
  // edits count before (or without) daemon publication, and after the worker exits and withdraws its overlay.
  const previewWorkers = new WeakMap<Session, Map<string, Awaited<ReturnType<typeof trustedWorker>>>>()
  // A finished worker read from its worktree cannot move the preview: its exit (last publish, ended lease) only changes its overlay.
  // The exemption holds only for the run captured here; a resumed or restarted worker is checked again.
  const settledRuns = new Map<string, { dir: string; lead: string; run: string }>()
  const runOf = (w: LocalWorker) => [w.status, w.pid, w.startedAt, w.finishedAt, w.exitCode].join(':')
  const settledWorkers = () => new Set([...settledRuns].filter(([person, captured]) => {
    const now = localWorkers(captured.dir, record => record.name === person && record.lead.participant === captured.lead)[0]
    return !!now && now.status !== 'running' && runOf(now) === captured.run
  }).map(([person]) => person))
  for (const { session: s, person } of [{ session: caller, person: caller.me.name }, ...participants]) {
    let byPerson = previewWorkers.get(s)
    if (!byPerson) { byPerson = new Map(); previewWorkers.set(s, byPerson) }
    if (byPerson.has(person)) continue
    const candidate = await trustedWorker(s, person)
    const real = candidate && await workerRealState(s.dir, candidate)
    const worker = real && decidePreview(real, true) === 'disk' ? candidate : undefined
    if (worker && real?.finished) settledRuns.set(person, { dir: s.dir, lead: s.me.name, run: runOf(worker) })
    byPerson.set(person, worker)
  }
  const previewWorker = (s: Session, person: string) => previewWorkers.get(s)?.get(person)
  const coverageLines: string[] = []
  for (const [person, { session, snap }] of snapshots) {
    if (previewWorker(session, person)) { coverageLines.push(`${person}: trusted local worktree`); continue }
    if (!snap) { gaps.push({ person, why: 'no manifest record' }); coverageLines.push(`${person}: no manifest record`); continue }
    const age = Math.max(0, Math.floor(((state.now?.() ?? Date.now()) - snap.head.scannedAt) / 1000))
    coverageLines.push(`${person} (${snap.head.level}, scanned ${age}s ago, rev ${snap.head.rev}):`)
    const shared = [...snap.entries].filter(([, entry]) => entry.state === 'shared').map(([path]) => path)
    const held = [...snap.entries].filter(([, entry]) => entry.state === 'held').map(([path, entry]) => `${path} (${entry.held ?? 'not shared'})`)
    coverageLines.push(`  shared: ${shared.length ? shared.join(', ') : 'none'}`)
    coverageLines.push(`  changed, text not shared: ${held.length ? held.join(', ') : 'none'}`)
    if (snap.head.excluded.length) coverageLines.push(`  ${snap.head.excluded.length} changed path(s) excluded by ${person}'s rules (names not shared)`)
    if (snap.head.coverage.kind === 'none') coverageLines.push(`  coverage: ${snap.head.coverage.reason}`)
    if (!snap.head.complete) coverageLines.push(snap.record?.git?.anchored === false
      ? `  no anchor on the room's remote: ${person}'s changes cannot be compared until its branch shares history with a remote branch`
      : '  updating after a commit; re-run')
    if (!snap.head.complete || !snap.fenceValid || snap.head.base !== snap.record?.git?.base) gaps.push({ person, why: 'manifest updating or holder changed' })
    if (!snap.roomSalt || !/^[a-f0-9]{64}$/i.test(snap.roomSalt)) gaps.push({ person, why: 'room salt missing or invalid; exclusion coverage cannot be certified' })
    if (snap.head.coverage.kind === 'none') gaps.push({ person, why: `coverage ${snap.head.coverage.reason}` })
    if (snap.head.excluded.length) gaps.push({ person, why: `${snap.head.excluded.length} changed path(s) excluded; names not shared` })
  }
  const diskWorkers = new Map(participants.flatMap(({ session, person }) => {
    const worker = previewWorker(session, person)
    return worker ? [[person, worker] as const] : []
  }))
  // Capture each disk boundary once, before any Git or file read can yield. Collection
  // supplies the same roots it already validated for its entire operation.
  const previewDirs = new Set([caller.dir])
  for (const { session, person } of [{ session: caller, person: caller.me.name }, ...participants]) {
    const worker = previewWorker(session, person)
    if (worker) previewDirs.add(worker.dir)
  }
  const roots = options.roots ?? new Map([...previewDirs].map(dir => {
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('unsafe preview root: ' + dir)
    return [path.resolve(dir), fs.realpathSync(dir)]
  }))
  const rootOf = (dir: string) => {
    const canonical = fs.realpathSync(dir)
    const root = roots.get(path.resolve(dir)) ?? [...roots.values()].find(value => value === canonical)
    if (!root) throw new Error('uncaptured preview root: ' + dir)
    return root
  }
  for (const dir of previewDirs) rootOf(dir)
  const remoteVersions = new Map<string, Map<string, Version>>()
  // Participants who left a path alone share its base text: read each commit's file once per preview (UTF-8;
  // a run's Latin-1 merge reads its own copy).
  const committedTexts = new Map<string, Promise<string | undefined>>()
  const gitAt = (sha: string, relpath: string, size?: number) => {
    const key = `${sha}:${relpath}`
    let text = committedTexts.get(key)
    if (!text) { text = readBoundedCheckoutText(caller.dir, key, relpath, 'utf8', true, size); committedTexts.set(key, text) }
    return text
  }
  const remoteVersion = async (s: Session, person: string, p: string): Promise<Version> => {
    let versions = remoteVersions.get(person)
    if (!versions) { versions = new Map(); remoteVersions.set(person, versions) }
    const cached = versions.get(p)
    if (cached) return cached
    const snap = snapshots.get(person)?.snap
    let version = await versionOf(snap, p, {
      gitAt,
      known: hash => readBoundedCheckoutText(caller.dir, hash, p, 'utf8', false).catch(() => undefined),
    })
    // A worker's daemon publishes its carried untracked files as base (baseline.ts), but its base commit lacks
    // them: an unlisted one is still the blob spawn carried, never a deletion. Read that blob by its id, and only
    // when the published base is the recorded carry commit or descends from it; otherwise the version is unknown.
    const carried = version.kind === 'base' && version.text === undefined ? relationFor(s.dir, person)?.baseline : undefined
    const blob = carried?.untracked.get(p)
    if (carried && blob && snap) {
      const proven = snap.head.base === carried.sha || await descends(carried.sha, snap.head.base)
      const text = proven ? await readBoundedCheckoutText(caller.dir, blob.sha, p, 'utf8').catch(error => {
        if (error instanceof HistoricalTextTooLarge) return error
        throw error
      }) : undefined
      version = typeof text === 'string' ? { kind: 'base', text }
        : text instanceof HistoricalTextTooLarge ? { kind: 'unknown', why: 'too-large', detail: 'historical text exceeds Room read limit' }
          : { kind: 'unknown', why: 'fetch', detail: proven ? `${person}'s carried base blob is unavailable` : `${person}'s published base does not follow its carried base` }
    }
    versions.set(p, version)
    return version
  }
  const previewText = async (s: Session, p: string, person: string) => {
    const w = previewWorker(s, person)
    const dir = w?.dir ?? (person === caller.me.name && s === caller ? caller.dir : undefined)
    if (!dir) {
      const version = await remoteVersion(s, person, p)
      const text = version.kind === 'text' ? version.text : version.kind === 'base' ? version.text ?? null : version.kind === 'deleted' ? null : undefined
      return options.encoding === 'latin1' && typeof text === 'string' ? Buffer.from(text, 'utf8').toString('latin1') : text
    }
    if (!validRepoPath(p, { ...DISK_READ_PATH, blank: 'allow' })) throw new Error('unsafe preview path: ' + p)
    const root = rootOf(dir)
    try {
      const result = containedRepoPath(root, path.join(root, p), { leaf: 'read-contained-link' })
      if (!result.ok) throw new Error('unsafe preview symlink: ' + p)
      const file = result.path
      return await readBoundedDiskText(file, options.encoding ?? 'utf8', { root, path: path.join(root, p) })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }
  const bases = [{ person: caller.me.name, base: baseFor(caller, caller.me.name) }, ...participants.map(({ person, session }) => ({ person, base: baseFor(session, person) }))]
  const remote = await roomRemote(caller.dir, caller.roomName)
  for (const item of bases) if (!await ensureCommit(caller.dir, remote, item.base))
    throw new Error(`${item.person}'s anchor ${item.base.slice(0, 10)} is not in this clone; git fetch, then retry`)
  let ancestor = bases[0].base
  for (const item of bases.slice(1)) {
    if (item.base === ancestor) continue
    try { ancestor = (await git(caller.dir, ['merge-base', ancestor, item.base])).trim() }
    catch (error) { if (isGitTimeout(error)) throw error; throw new Error(`${item.person}'s HEAD ${item.base.slice(0, 10)} is not in this clone; git fetch, then retry`) }
  }
  // A worker's own changes are its tree against its baseline (baseline.ts), whichever side calls:
  // a shared merge-base would count the lead's carried work as the worker's.
  const ancestry = new Map<string, Promise<boolean>>()
  const descends = (from: string, sha: string) => {
    const key = from + ':' + sha
    if (!ancestry.has(key)) ancestry.set(key, git(caller.dir, ['merge-base', '--is-ancestor', from, sha]).then(() => true, error => { if (isGitTimeout(error)) throw error; return false }))
    return ancestry.get(key)!
  }
  const allSides = [{ person: caller.me.name, session: caller }, ...participants]
  // One relation per side for this build, reused by provenance, pairing and the
  // lead-absent check. Freshness still re-reads records when the result is used.
  const relations = new Map<string, ReturnType<typeof carriedFrom>>()
  const relationFor = (dir: string, person: string) => {
    const key = `${dir}\0${person}`
    if (!relations.has(key)) relations.set(key, carriedFrom(dir, person))
    return relations.get(key)
  }
  for (const { person, session } of allSides) relationFor(session.dir, person)
  const callerCarried = relationFor(caller.dir, caller.me.name), callerWorker = callerCarried?.baseline
  const includedNames = new Set(allSides.map(side => side.person))
  const registry = registrySnapshotForDir(caller.dir)
  const records = new Map(allSides.flatMap(({ person }) => {
    const record = registry.reservedByTagOrName(person)
    return record?.name === person && record.room === caller.roomName && !['retiring', 'retired', 'abandoned', 'discarding'].includes(record.phase)
      ? [[person, record] as const] : []
  }))
  const workersById = new Map((records.size ? localWorkers(caller.dir) : []).map(worker => [worker.id, worker]))
  // Use the same incarnation as the captured record, even when an unrelated
  // legacy record happens to reuse a participant name.
  const workerStates = new Map([...records].flatMap(([person, record]) => {
    const worker = workersById.get(record.id)
    return worker ? [[person, worker] as const] : []
  }))
  const callerBaseline = await pairBaseline(callerWorker, undefined, ancestor, descends)
  const rootFor = (name: string): string | undefined => {
    const seen = new Set<string>()
    while (records.has(name) && includedNames.has(records.get(name)!.lead.participant)) {
      if (seen.has(name)) return undefined
      seen.add(name); name = records.get(name)!.lead.participant
    }
    return name
  }
  const lineageRoots = new Set([...records].filter(([, record]) => includedNames.has(record.lead.participant))
    .map(([name]) => rootFor(name)).filter((name): name is string => name !== undefined))
  const anchor = lineageRoots.size === 1 ? allSides.find(side => side.person === [...lineageRoots][0]) : undefined
  const anchorName = anchor?.person ?? caller.me.name
  const anchored = !!anchor && anchorName !== caller.me.name
  const depth = (name: string): number => {
    const seen = new Set<string>()
    while (records.has(name) && includedNames.has(records.get(name)!.lead.participant)) {
      if (seen.has(name)) return Number.MAX_SAFE_INTEGER
      seen.add(name); name = records.get(name)!.lead.participant
    }
    return seen.size
  }
  // Collection already uses this registry key. Applying the same policy in every
  // preview makes the outcome independent of caller/request order, not a claim
  // that Git's repeated-line alignment preserves every semantic intent.
  const contributors = anchor ? allSides.filter(side => side.person !== anchorName).sort((a, b) =>
    depth(a.person) - depth(b.person) || (workerStates.get(a.person)?.finishedAt ?? 0) - (workerStates.get(b.person)?.finishedAt ?? 0)
      || ((records.get(a.person)?.tag ?? a.person) < (records.get(b.person)?.tag ?? b.person) ? -1
        : (records.get(a.person)?.tag ?? a.person) > (records.get(b.person)?.tag ?? b.person) ? 1 : 0)) : participants
  const refValues = new Map<string, string | undefined>()
  const refValue = async (ref: string) => {
    if (!refValues.has(ref)) refValues.set(ref, await git(caller.dir, ['rev-parse', '--verify', ref]).then(text => text.trim(), () => undefined))
    return refValues.get(ref)
  }
  // Poll bounded ref-file metadata, never spawn synchronous Git during settling.
  const refStamp = (ref: string) => {
    try { const stat = fs.statSync(path.join(registry.commonDir, ref)); return [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':') } catch { return 'absent' }
  }
  const packedStamp = refStamp('packed-refs')
  const callerGitDir = (await git(caller.dir, ['rev-parse', '--absolute-git-dir'])).trim()
  const headStamp = () => { try { const head = fs.readFileSync(path.join(callerGitDir, 'HEAD'), 'utf8'); return head + ':' + (head.startsWith('ref: ') ? refStamp(head.slice(5).trim()) : '') } catch { return 'absent' } }
  const capturedHead = headStamp()
  const localHead = (await git(caller.dir, ['rev-parse', 'HEAD'])).trim()
  const lifecycle = [...records].map(([person, record]) => ({ person, id: record.id, base: record.base, seq: record.seq,
    key: [workerStates.get(person)?.finishedAt ?? 0, record.tag].join(':'),
    refs: [collectHeadRef(record.tag, record.id), carryRef(record.tag)].map(ref => [ref, refStamp(ref)] as const) }))
  const proven = new Map<string, Baseline>()
  if (anchor) for (const { person, session } of contributors) {
    const relation = relationFor(session.dir, person), record = records.get(person)
    if (!relation || !record || rootFor(person) !== anchorName) continue
    const baseline = await pairBaseline(relation.baseline, undefined, ancestor, descends)
    if (!baseline) continue
    const delivered = await refValue(collectHeadRef(record.tag, record.id)) === baseline.sha
      && (await git(caller.dir, ['log', '-1', '--format=%s', baseline.sha])).trim() === 'room: kept collection baseline'
    const carry = await refValue(carryRef(record.tag))
    const inherited = record.carriedBase === baseline.sha && (carry === undefined || carry === baseline.sha)
    const parentSnapshot = snapshots.get(relation.lead)?.snap
    const parentWorker = previewWorker(session, relation.lead)
    const parentHead = relation.lead === caller.me.name ? localHead
      : parentWorker ? (await git(parentWorker.dir, ['rev-parse', 'HEAD'])).trim()
      : parentSnapshot?.fenceValid && parentSnapshot.head.complete && parentSnapshot.head.fence === parentSnapshot.record?.git?.fence
        && parentSnapshot.head.base === parentSnapshot.record.git.base ? parentSnapshot.record.git.head : undefined
    if (delivered || inherited || (!!parentHead && await descends(baseline.sha, parentHead))) {
      proven.set(person, baseline)
      if (relation.lead !== caller.me.name && !parentWorker && (delivered || inherited || !!record.carriedUntracked?.length)
        && !keptPublicationMatches(session, record.keptPublication, parentSnapshot, baseline.sha)) {
        gaps.push({ kind: 'provenance', person: relation.lead, why: `${relation.lead}'s published snapshot has no acknowledged post-baseline scan for ${person}; message its lead without refresh to retry publication` })
      }
    } else gaps.push({ kind: 'provenance', person, why: 'worker baseline provenance could not be verified' })
  }
  const pairs = new Map<string, Baseline | undefined>()
  const sharedBaselines = new Map<string, [Baseline, Baseline]>()
  for (const { person, session } of participants) {
    const theirs = relationFor(session.dir, person)
    const leadPair = callerCarried?.lead === person || theirs?.lead === caller.me.name
    pairs.set(person, leadPair ? await pairBaseline(callerCarried?.lead === person ? callerWorker : undefined,
      theirs?.lead === caller.me.name ? theirs.baseline : undefined, ancestor, descends) : undefined)
    if (!leadPair && callerWorker && theirs &&
      (await Promise.all([descends(ancestor, callerWorker.sha), descends(ancestor, theirs.baseline.sha)])).every(Boolean)) {
      sharedBaselines.set(person, [callerWorker, theirs.baseline])
    }
  }
  if (anchor) for (const { person } of contributors) pairs.set(person, proven.get(person))
  const deltaBases = new Map([...pairs].map(([person, pair]) => [person, pair?.sha ?? ancestor]))
  // A carried file a worker left as spawn carried it is the lead's, not the worker's change: nothing of it is
  // read or merged for that worker. One hash-object per worker decides it; a lead's generated sources can be
  // hundreds of carried files, and reading each one's base cost two Git processes per file per read.
  // A tracked file the carry commit changed is left alone only when its blob id and mode on disk prove it is
  // still the commit's (carriedCommitUnchangedPaths); index state never decides it.
  const untouched = new Map<string, ReadonlySet<string>>()
  for (const { person, session } of participants) {
    const pair = pairs.get(person), worker = previewWorker(session, person)
    if (!carriesWork(pair) || !worker || pair.worker !== person) continue
    const root = rootOf(worker.dir)
    let own = false
    try { own = fs.realpathSync(pair.dir) === root } catch { /* a vanished baseline checkout reads every file */ }
    if (!own) continue
    const unchanged = carriedUnchangedPaths({ ...pair, dir: root })
    if (pair.carriedCommit) {
      const tracked = (await carriedPaths(pair)).filter(p => !pair.untracked.has(p))
      for (const p of await carriedCommitUnchangedPaths({ ...pair, dir: root }, tracked)) unchanged.add(p)
    }
    untouched.set(person, unchanged)
  }
  const leftAlone = (person: string | undefined, p: string) => !!person && !!untouched.get(person)?.has(p)
  const pathSet = new Set<string>()
  /** Paths a participant may have changed; the rest only the caller changed. */
  const theirPaths = new Set<string>()
  const ignoredNotes: string[] = []
  const ignoredBy = new Map<string, string[]>()
  const committedPaths = async (person: string, from: string, to: string) => {
    // Merge paths independently: rename-aware --name-only omits the deleted source.
    const paths = [...new Set((await gitWholeTree(caller.dir, ['diff', '--no-renames', '--name-only', '-z', from, to])).split('\0').filter(Boolean))]
    if (paths.length > 2000) gaps.push({ person, why: `committed path enumeration exceeded 2000 (${paths.length}); using manifest paths only` })
    return paths.length > 2000 ? [] : paths
  }
  // A lead's revert to HEAD clears its manifest entry, but still changes a file
  // the worker inherited at spawn. Compare those carried paths explicitly.
  for (const pair of pairs.values()) if (carriesWork(pair)) for (const p of await carriedPaths(pair)) {
    await new Promise<void>(resolve => setImmediate(resolve))
    if (leftAlone(pair.worker, p)) continue
    pathSet.add(p)
    theirPaths.add(p)
  }
  const carriedAnywhere = new Set([callerBaseline, ...pairs.values(), ...[...sharedBaselines.values()].flat()].flatMap(pair => [...pair?.untracked.keys() ?? []]))
  /** Participant -> its worker scratch: untracked logs and temp files never committed or carried, neither previewed nor collected. */
  const scratchBy = new Map<string, ReadonlySet<string>>()
  const workerScratch = async (untracked: readonly string[], changed: readonly string[]) => {
    const tracked = new Set(changed)
    const candidates = untracked.filter(p => isScratchName(p) && !tracked.has(p) && !carriedAnywhere.has(p))
    const committed = new Set<string>()
    if (candidates.length) for (const sha of new Set([ancestor, ...bases.map(item => item.base), ...deltaBases.values()])) {
      for (const [p, blob] of await gitBlobInfoMany(caller.dir, sha, candidates)) if (blob) committed.add(p)
    }
    return new Set(candidates.filter(p => !committed.has(p)))
  }
  for (const [index, item] of [{ person: caller.me.name, session: caller }, ...participants].entries()) {
    const worker = previewWorker(item.session, item.person)
    const dir = worker?.dir ?? (item.person === caller.me.name ? caller.dir : undefined)
    const ignored = dir ? (await gitWholeTree(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])).split('\0').filter(Boolean) : []
    if (ignored.length) ignoredBy.set(item.person, [...ignoredBy.get(item.person) ?? [], ...ignored])
    const changed = dir ? (await gitWholeTree(dir, ['diff', '--no-renames', '--name-only', '-z', ancestor, '--'])).split('\0').filter(Boolean) : []
    const untracked = dir ? (await gitWholeTree(dir, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean) : []
    const scratch = index > 0 && worker ? await workerScratch(untracked, changed) : new Set<string>()
    if (scratch.size) scratchBy.set(item.person, scratch)
    const add = (p: string) => { if (index > 0 && (leftAlone(item.person, p) || scratch.has(p))) return; pathSet.add(p); if (index > 0) theirPaths.add(p) }
    if (!options.diskOnly) for (const p of snapshots.get(item.person)?.snap?.entries.keys() ?? []) {
      await new Promise<void>(resolve => setImmediate(resolve))
      if (!ignored.some(i => p === i || (i.endsWith('/') && p.startsWith(i)))) add(p)
    }
    for (const p of [...changed, ...untracked]) { await new Promise<void>(resolve => setImmediate(resolve)); add(p) }
    for (const base of new Set([baseFor(item.session, item.person), deltaBases.get(item.person) ?? callerBaseline?.sha ?? ancestor])) {
      if (base !== ancestor) for (const p of await committedPaths(item.person, ancestor, base)) {
        await new Promise<void>(resolve => setImmediate(resolve)); add(p)
      }
    }
  }
  ignoredNotes.push(...ignoredOutputNotes(ignoredBy))
  // A path only the caller changed keeps the caller's text when skipCallerOnly: only the caller's own side is checked,
  // so a lead's hundreds of untracked files cost one check each, not one per participant and a remote lookup.
  const callerOnlyPath = (p: string) => !!options.skipCallerOnly && !theirPaths.has(p)
  // ls-files represents nested repositories/submodules as directory entries.
  // They are not file text and cannot participate in a file merge preview.
  const safetySides = [{ session: caller, person: caller.me.name }, ...participants].map(({ session, person }) => {
    const worker = previewWorker(session, person)
    const dir = worker?.dir ?? (session === caller && person === caller.me.name ? caller.dir : undefined)
    return { person, root: dir ? rootOf(dir) : undefined,
      linkedInputs: workerOwnedPaths(localWorkerBaseline(session.dir, person)) }
  })
  const diskDirs = [caller.dir, ...participants.map(({ session, person }) => previewWorker(session, person)?.dir).filter((dir): dir is string => !!dir)]
  for (const p of pathSet) {
    await new Promise<void>(resolve => setImmediate(resolve))
    let excluded = false
    const callerOnlyHere = callerOnlyPath(p)
    for (const { person, root, linkedInputs } of callerOnlyHere ? safetySides.slice(0, 1) : safetySides) {
      let reason = linkedInputs.includes(p) ? 'linked input' : undefined
      if (!reason && root) {
        try {
          if (!containedRepoPath(root, path.join(root, p), { leaf: 'read-contained-link', allowRoot: true }).ok) reason = 'symlink leaving the worktree'
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
          try { if (fs.lstatSync(path.join(root, p)).isSymbolicLink()) reason = 'dangling symlink' } catch { /* absent path */ }
        }
      }
      if (reason) {
        ignoredNotes.push(`NOT previewed (${reason}, ${person}): ${p}`)
        gaps.push({ person, path: p, why: reason })
        excluded = true
      }
    }
    if (excluded) { pathSet.delete(p); continue }
    if ((callerOnlyHere ? diskDirs.slice(0, 1) : diskDirs).some(dir => { try { return fs.lstatSync(path.join(dir, p)).isDirectory() } catch { return false } })) {
      pathSet.delete(p)
      ignoredNotes.push('NOT previewed (directory or nested repository): ' + p)
      gaps.push({ person: caller.me.name, path: p, why: 'directory or nested repository' })
    }
  }
  if (!options.diskOnly) for (const p of [...pathSet]) {
    await new Promise<void>(resolve => setImmediate(resolve))
    if (callerOnlyPath(p)) continue
    for (const { person, session } of participants) {
      if (previewWorker(session, person)) continue
      const version = await remoteVersion(session, person, p)
      if (version.kind === 'text' || version.kind === 'base' || version.kind === 'deleted') continue
      const why = version.kind === 'held'
        ? version.entry.held === 'scope' ? `changed by ${person}, outside ${person}'s declared area` : `changed by ${person}, text not shared (${version.why})`
        : version.kind === 'excluded' ? `changed by ${person}, excluded by their rules` : `version unknown: ${version.detail}`
      gaps.push({ person, path: p, why })
      // Only this participant's version is unavailable; keep other versions.
    }
  }
  if (anchored) {
    const snap = snapshots.get(anchorName)?.snap
    for (const p of [...pathSet]) {
      const version = await remoteVersion(anchor!.session, anchorName, p)
      if (!snap?.head.complete || !snap.fenceValid || snap.head.level !== 'full'
        || snap.head.base !== snap.record?.git?.base || !['text', 'base', 'deleted'].includes(version.kind)) {
        gaps.push({ kind: 'provenance', person: anchorName, path: p, why: 'published preview anchor unavailable or not fully shared' })
        pathSet.delete(p)
      }
    }
  }
  // A path only the caller changed cannot conflict and keeps the caller's text. Skipping it avoids reading
  // gigabytes of a lead's untracked art when only the participants' changes matter (collect, preview without a run).
  let callerOnly = 0
  if (options.skipCallerOnly) for (const p of pathSet) {
    await new Promise<void>(resolve => setImmediate(resolve))
    if (callerOnlyPath(p)) { pathSet.delete(p); callerOnly++ }
  }
  const baseTexts = new Map<string, string | null>()
  const historicalInfo = new Map<string, Promise<Map<string, GitBlobInfo | undefined>>>()
  const infoAt = (sha: string) => {
    if (!historicalInfo.has(sha)) historicalInfo.set(sha, gitBlobInfoMany(caller.dir, sha, pathSet))
    return historicalInfo.get(sha)!
  }
  const entryAt = async (baseline: Baseline | undefined, p: string) =>
    baseline?.untracked.get(p)?.sha ?? (await infoAt(baseline?.sha ?? ancestor)).get(p)?.hash ?? null
  const textAt = async (sha: string, p: string) => {
    const key = sha + ':' + p
    if (!baseTexts.has(key)) {
      const blob = (await infoAt(sha)).get(p)
      if (blob && blob.size > DISK_TEXT_LIMIT) throw new HistoricalTextTooLarge(p)
      baseTexts.set(key, blob ? (await (!options.encoding || options.encoding === 'utf8' ? gitAt(sha, p, blob.size)
        : readBoundedCheckoutText(caller.dir, `${sha}:${p}`, p, options.encoding, true, blob.size))) ?? null : null)
    }
    return baseTexts.get(key)!
  }
  // Each carried base is read once per preview: the checks below and every merge step reuse it.
  const carriedTexts = new Map<string, Promise<string>>()
  const baseAt = async (pair: Baseline | undefined, p: string) => {
    if (!pair) return textAt(ancestor, p)
    if (!pair.untracked.has(p)) return textAt(pair.sha, p)
    const sha = pair.untracked.get(p)!.sha, key = pair.dir + '\0' + sha + '\0' + p
    let text = carriedTexts.get(key)
    if (!text) {
      text = readBoundedCheckoutText(pair.dir, sha, p, options.encoding).then(carried => {
        if (carried === undefined) throw new MissingBaseBlob(p)
        return carried
      })
      carriedTexts.set(key, text)
    }
    return text
  }
  const pairBaseAt = async (person: string, p: string) => {
    const shared = sharedBaselines.get(person)
    if (shared) {
      let sameBlob = false
      try {
        const [a, b] = shared
        const [aInfo, bInfo] = await Promise.all([infoAt(a.sha), infoAt(b.sha)])
        const aHash = a.untracked.get(p)?.sha ?? aInfo.get(p)?.hash
        const bHash = b.untracked.get(p)?.sha ?? bInfo.get(p)?.hash
        sameBlob = !!aHash && aHash === bHash
      } catch { /* unavailable proof: use the Git ancestor */ }
      if (sameBlob) return baseAt(shared[0], p)
    }
    return baseAt(pairs.get(person), p)
  }
  for (const pair of new Set([callerBaseline, ...pairs.values()])) for (const p of pair?.untracked.keys() ?? []) {
    await new Promise<void>(resolve => setImmediate(resolve))
    if (pathSet.has(p) && !leftAlone(pair?.worker, p)) await baseAt(pair, p).catch(error => {
      if (!(error instanceof MissingBaseBlob)) throw error
      pathSet.delete(p)
      ignoredNotes.push(error.message)
      gaps.push({ person: pair?.worker ?? caller.me.name, path: p, why: error.message })
    })
  }
  if (!anchor) {
    const baselines: Baseline[] = []
    for (const { person, session } of allSides) {
      const baseline = await pairBaseline(relationFor(session.dir, person)?.baseline, undefined, ancestor, descends)
      if (baseline) baselines.push(baseline)
    }
    if (baselines.length >= 2) for (const p of [...pathSet]) {
      const original = await entryAt(undefined, p)
      const versions = await Promise.all(baselines.map(async baseline => ({ baseline, entry: await entryAt(baseline, p) })))
      const changed = versions.filter(value => value.entry !== original)
      let inheritedRevert = false
      // A later baseline may revert an earlier delivered value back to the common
      // ancestor. Omitting that unchanged-looking side would resurrect the value.
      for (const later of versions.filter(value => value.entry === original)) for (const prior of changed) {
        if (prior.baseline.sha !== later.baseline.sha && await descends(prior.baseline.sha, later.baseline.sha)) inheritedRevert = true
      }
      if (new Set(changed.map(value => value.entry)).size < 2 && !inheritedRevert) continue
      const workers = (inheritedRevert ? versions : changed).map(value => value.baseline.worker)
      const leads = [...new Set(workers.map(name => records.get(name)?.lead.participant).filter(Boolean))]
      gaps.push({ kind: 'provenance', person: workers.join(', '), path: p, why: `start from different delivered versions; include ${leads.join(', ') || 'their lead'} in the preview` })
      ignoredNotes.push(`NOT previewed: ${p}: ${workers.join(', ')} start from different delivered versions; include ${leads.join(', ') || 'their lead'} in the preview`)
      pathSet.delete(p)
    }
  }
  for (const p of [...pathSet]) {
    await new Promise<void>(resolve => setImmediate(resolve))
    try {
      await textAt(ancestor, p)
      await baseAt(callerBaseline, p)
      for (const person of pairs.keys()) if (!leftAlone(person, p)) await pairBaseAt(person, p)
    } catch (error) {
      if (!(error instanceof HistoricalTextTooLarge)) throw error
      pathSet.delete(p)
      gaps.push({ person: caller.me.name, path: p, why: error.message })
      ignoredNotes.push(`NOT previewed (historical text exceeds Room read limit): ${p}`)
    }
  }
  const paths = Array.from(pathSet).sort()
  const includedParticipants = participants.map(({ person, session }) => {
    const base = bases.find(item => item.person === person)!.base
    const snap = snapshots.get(person)?.snap
    return {
      person, base, gitRecord: acceptedRecords.get(person),
      liveShared: !previewWorker(session, person) && !!snap && paths.some(p => snap.entries.get(p)?.state === 'shared'),
    }
  })
  const merged = new Map<string, string | null>()
  const owners = new Map<string, string[]>()
  const anchorBaseline = anchored ? await pairBaseline(relationFor(caller.dir, anchorName)?.baseline, undefined, ancestor, descends) : callerBaseline
  for (const p of paths) {
    await new Promise<void>(resolve => setImmediate(resolve))
    const mine = await previewText(anchor?.session ?? caller, p, anchorName)
    const text = mine === undefined ? await textAt(ancestor, p) : mine
    merged.set(p, text)
    if (text !== await baseAt(anchorBaseline, p)) owners.set(p, [anchorName])
  }
  const initial = new Map(merged)
  const out: string[] = []
  const fallbacks = new Set<string>()

  out.push(...coverageLines, ...ignoredNotes)
  const scratchNote = scratchPreviewNote(scratchBy)
  if (scratchNote) out.push(scratchNote)
  let hardCount = 0
  let conflictCount = 0
  const resolvedText = new Map<string, string>()
  const conflictingPaths = new Map<string, string[]>()
  for (const [index, { person, session }] of contributors.entries()) {
    const clean: string[] = [], conflicts: string[] = [], onlyOne: string[] = [], sameChange: string[] = [], resolvable: string[] = []
    const pair = pairs.get(person)
    for (const p of paths) {
      // A preview of many rewritten files must let other room calls run between files.
      await new Promise<void>(resolve => setImmediate(resolve))
      if (leftAlone(person, p) || scratchBy.get(person)?.has(p)) continue
      const mine = merged.get(p)
      const b = await pairBaseAt(person, p)
      const theirsRaw = await previewText(session, p, person)
      const mineT = mine ?? '', theirs = theirsRaw === undefined ? b : theirsRaw
      if (theirs === b) continue
      if (mine === theirs) {
        const prior = owners.get(p) ?? [caller.me.name]
        sameChange.push(`${prior.join(' + ')} and ${person} made the same change: ${p}`)
        owners.set(p, [...new Set([...prior, person])])
        continue
      }
      if (mine === b) {
        onlyOne.push(`${p} (${person} only)`)
        merged.set(p, theirs)
        owners.set(p, [...(owners.get(p) ?? []), person])
        continue
      }
      // Deletion versus modification and competing binary contents cannot be text-merged.
      if (mine === null || theirs === null || [b, mine, theirs].some(text => text?.includes('\0'))) {
        const prior = owners.get(p) ?? [caller.me.name]
        conflictingPaths.set(p, [...new Set([...(conflictingPaths.get(p) ?? []), ...prior, person])])
        hardCount++; conflictCount++
        conflicts.push(p + ': conflict between ' + [...prior, person].join(', '))
        continue
      }
      const res = await gitMergeFile(b ?? '', mineT, theirs ?? '', { ours: 'combined', base: 'base', theirs: person })
      const mergeInfo = res as typeof res & { algorithm?: 'git' | 'fallback'; fallbackReason?: string }
      if (mergeInfo.algorithm === 'fallback') fallbacks.add(mergeInfo.fallbackReason ?? 'git merge-file unavailable')
      const hunks = res.conflicts
      if (!hunks.length) {
        clean.push(p)
        merged.set(p, res.text)
        owners.set(p, [...(owners.get(p) ?? []), person])
        continue
      }
      let line = 1, unresolved = 0
      const detail: string[] = [], resolvedLines: string[] = []
      const prior = owners.get(p) ?? [caller.me.name]
      const pairNames: string[] = []
      for (const owner of prior) {
        const ownerSession = owner === caller.me.name ? caller : rooms.holding(owner, caller)
        const ownerRaw = await previewText(ownerSession, p, owner)
        const ownerText = ownerRaw === null ? '' : ownerRaw ?? b
        const pairResult = await gitMergeFile(b ?? '', ownerText ?? '', theirs ?? '', { ours: owner, base: 'base', theirs: person })
        const pairInfo = pairResult as typeof pairResult & { algorithm?: 'git' | 'fallback'; fallbackReason?: string }
        if (pairInfo.algorithm === 'fallback') fallbacks.add(pairInfo.fallbackReason ?? 'git merge-file unavailable')
        if (pairResult.status === 'conflict') pairNames.push(owner)
      }
      const conflictsWith = pairNames.length ? pairNames : [prior[prior.length - 1]]
      for (const r of res.chunks) {
        if (r.ok) { line += r.ok.length; resolvedLines.push(...r.ok); continue }
        const c = r.conflict
        if (!c) continue
        const who = conflictsWith.map(owner => `${owner} and ${person}`).join(', ')
        const sup = supersetSide(c.a, c.b)
        if (sup) {
          const contains = sup === 'a'
            ? conflictsWith.length === 1 && conflictsWith[0] === caller.me.name ? `your version contains ${person}'s change in order` : `the combined version contains ${person}'s change in order`
            : `${person}'s version contains ${conflictsWith.length === 1 && conflictsWith[0] === caller.me.name ? 'your' : 'the combined'} change in order`
          detail.push(`  around line ${line}: conflict between ${who}; ${contains} — resolvable by taking ${sup === 'a' ? 'the combined version' : `${person}'s`}`)
          resolvedLines.push(...(sup === 'a' ? c.a : c.b))
        } else {
          unresolved++
          detail.push(`  around line ${line}: conflict between ${who}; combined tree changed ${c.a.length} line(s), ${person} changed ${c.b.length} line(s) — needs a human or a rewrite`)
          resolvedLines.push('<<<<<<< combined', ...c.a, '=======', ...c.b, `>>>>>>> ${person}`)
        }
        line += c.o.length
      }
      conflictingPaths.set(p, [...new Set([...(conflictingPaths.get(p) ?? []), ...prior, person])])
      conflictCount++
      if (!unresolved) {
        resolvable.push(p)
        const text = resolvedLines.join('\n') + (resolvedLines.length ? '\n' : '')
        merged.set(p, text)
        owners.set(p, [...prior, person])
        if (options.resolve === true) resolvedText.set(p, text)
      } else hardCount++
      // Two different files created at one path share no lines to place a conflict around.
      if (unresolved && b === null) conflicts.push(`${p}: ${andList([...conflictsWith, person])} each created this new file (not in the base) with different contents — needs a human or a rewrite`)
      else conflicts.push(`${p}${unresolved ? '' : ' (resolvable)'}\n${detail.join('\n')}`)
    }
    out.push(`step ${index + 1}: merge ${person} into ${[anchorName, ...contributors.slice(0, index).map(side => side.person)].join(' + ')}${pair && pair.sha !== ancestor ? ` (against ${pair.worker}'s base ${pair.sha.slice(0, 10)})` : ''}`)
    if (onlyOne.length) out.push(`only ${person} changed ${onlyOne.length === 1 ? 'this file' : 'these files'} since its start${pair?.carriedCommit ? ', which already includes your carried edits' : ''}: ${onlyOne.join(', ')}`)
    out.push(...sameChange)
    if (clean.length) out.push(`both changed, merge cleanly: ${clean.join(', ')}`)
    if (conflicts.length) out.push(`CONFLICTS:\n${conflicts.join('\n')}`)
    else out.push('no conflicts')
    if (resolvable.length && options.resolve !== true) out.push(`${resolvable.length} conflict(s) are resolvable because one side built on the other's change: call again with resolve=true to get the resolved file text, then write it to your own clone.`)
  }

  if (anchor) out.unshift(`preview anchor: ${anchorName} (${anchored ? 'published snapshot' : 'local working tree'}); contributors use canonical collection order`)
  out.unshift(`preview merge of your changes with ${people.map(p => `${p}'s`).join(', ')} (common ancestor ${ancestor.slice(0, 10)}; merge algorithm: ${fallbacks.size ? 'fallback' : 'git'}${fallbacks.size ? `; fallback reason: ${[...fallbacks].join('; ')}` : ''}):`)
  const moved = () => {
    const settled = settledWorkers()
    const resumed = [...settledRuns.keys()].filter(person => !settled.has(person))
    const changedLifecycle = lifecycle.filter(captured => {
      const current = registry.read(captured.id)
      const worker = localWorkers(caller.dir, record => record.id === captured.id)[0]
      return !current || current.base !== captured.base || current.seq !== captured.seq
        || [worker?.finishedAt ?? 0, current.tag].join(':') !== captured.key
        || captured.refs.some(([ref, value]) => refStamp(ref) !== value)
    }).map(captured => captured.person)
    return [...new Set([...(headStamp() !== capturedHead || refStamp('packed-refs') !== packedStamp ? [caller.me.name] : []), ...resumed, ...changedLifecycle, ...movedSince(state, [...snapshots].filter(([person]) => !settledRuns.has(person)).map(([person, { session, snap }]) => ({ person, session, snap })))])]
  }
  const isCurrent = () => moved().length === 0
  // Keep provenance from this build, never from a later publication during a command.
  // Disk inputs are authoritative local bytes, so an overlay revision would mislabel them.
  const snapshotInputs = bases.map(({ person, base }) => {
    const snap = snapshots.get(person)?.snap
    const source = person === caller.me.name ? 'local working tree'
      : diskWorkers.has(person) ? 'disk worktree snapshot'
        : snap ? `rev ${snap.head.rev}` : 'no manifest record'
    return `${person} (${source}, base ${base.slice(0, 10)})`
  })
  return { ancestor, deltaBases, includedParticipants, snapshotInputs, callerBase: bases[0].base, paths, callerOnly, initial, merged, owners, conflictingPaths, hardCount, conflictCount, resolvedText, out, ignoredNotes, scratch: scratchBy, roots, diskWorkers, gaps, complete: gaps.length === 0, current: isCurrent(), isCurrent, moved, settledWorkers }
}
/** 'a' if b's lines appear in order inside a (a built on b), 'b' if the reverse, else undefined. */
export function supersetSide(a: string[], b: string[]): 'a' | 'b' | undefined {
  const contains = (outer: string[], inner: string[]) => {
    if (!inner.length || inner.length > outer.length) return false
    let i = 0
    for (const line of outer) if (line === inner[i]) i++
    return i === inner.length
  }
  if (a.length > b.length && contains(a, b)) return 'a'
  if (b.length > a.length && contains(b, a)) return 'b'
  return undefined
}
