import { git, gitCommitMissing, gitWholeTree, isGitTimeout } from '@room/roomd/git'
import { ensureCommit, gitCommonDir, roomRemote } from '@room/roomd'
import { createTwoFilesPatch, diffLines } from 'diff'
import { execFile, spawn } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { stripVTControlCharacters } from 'node:util'
import { coversPath, describeClaim, manifestChangers, manifestPaths, neighbours, participantsView, snapshot, snapshotStillCurrent, versionOf, withLineNumbers, type NoteMsg, type Version } from '@room/shared'
import { localWorkers } from '../worker-registry.js'
import type { LocalWorker } from '../worker-status.js'
import type { Session } from '../session.js'
import { sameCheckoutSession } from '../company.js'
import { carriedUnchangedPaths, workerBaseline } from '@room/roomd/baseline'
import { DISK_READ_PATH, MATERIALIZED_PATH, containedRepoPath, isInsideRoot, validRepoPath } from '@room/roomd'
import { workerOwnedPaths } from '../worker-git.js'
import { decidePreview, workerRealState } from '../worker-state.js'
import { buildCombinedTree } from './combined-tree.js'
import { knownNames, resolveDisplayedName } from './names.js'
import { HistoricalTextTooLarge, readBoundedCheckoutText, readBoundedDiskText, readBoundedDiskTextSync, readBoundedHistoricalText } from './disk-text.js'
import { previewCheck, previewPhase } from '../timing.js'
import { evictPreviewLru, previewCapBytes, touchPreview, tryPreviewLock, type PreviewUnlock } from '../preview-cache.js'
import { parsePsLstartUtc, pidAlive } from '@room/relay/process'
import { trustedWorker, WORKTREE_NOTE, RO, RW, int, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'

export const defs: ToolDef[] = [
  { name: 'room_read', annotations: RO, description: 'Use to read a teammate’s live file or diff; omit path for all diffs.',
    inputSchema: { type: 'object', properties: { path: str('repo-relative path'), person: str('default you'), diff: { type: 'boolean' } } } },
  { name: 'room_impact', annotations: RO, description: 'Use before changing a public function or file: find who depends on it.',
    inputSchema: { type: 'object', properties: { symbol: str('function/class/variable name'), path: str('repo-relative path') } } },
  { name: 'room_preview_merge', annotations: RO, description: 'Use for "will our changes work together?" or "check for conflicts before I finish"; optionally run tests.',
    inputSchema: { type: 'object', properties: { people: strs('participants in merge order; default all'), person: str('one participant'), includeOffline: { type: 'boolean', description: 'include offline overlays' }, run: str('test command'), resolve: { type: 'boolean', description: 'resolve superset conflicts' } } } }
]

/** Suggest a test command for a preview whose combined tree was not tested. */
export function suggestedTestCommand(files: Readonly<Record<string, string | undefined>>): string {
  try {
    if (files['package.json'] && typeof JSON.parse(files['package.json']).scripts?.test === 'string') return 'npm test'
  } catch { /* An unreadable package manifest offers no suggestion. */ }
  if (files['pyproject.toml'] && /pytest/i.test(files['pyproject.toml'])) return files['uv.lock'] !== undefined ? 'uv run pytest' : 'pytest'
  if (files.Makefile && /^test\s*:/m.test(files.Makefile)) return 'make test'
  return '<your test command>'
}

/** Read only root test manifests; unreadable files offer no command hint. */
export function testCommandFor(dir: string): string {
  const files: Record<string, string | undefined> = {}
  for (const file of ['package.json', 'pyproject.toml', 'uv.lock', 'Makefile']) {
    try { files[file] = readBoundedDiskTextSync(path.join(dir, file), 64 * 1024) }
    catch { files[file] = undefined }
  }
  return suggestedTestCommand(files)
}

async function ownDiskText(dir: string, rel: string): Promise<string | null> {
  if (!validRepoPath(rel, DISK_READ_PATH)) throw new Error('unsafe room path: ' + rel)
  const root = fs.realpathSync(dir)
  const candidate = path.resolve(root, rel)
  if (!isInsideRoot(root, candidate)) throw new Error('unsafe room path: ' + rel)
  try {
    const result = containedRepoPath(root, candidate, { leaf: 'read-contained-link' })
    if (!result.ok) throw new Error('unsafe room symlink: ' + rel)
    const real = result.path
    return await readBoundedDiskText(real, 'utf8', { root, path: candidate })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** A capped line probe keeps jsdiff's patch builder away from distant rewrites. */
export function boundedTwoFilesPatch(p: string, before: string, after: string, person: string): string {
  const a = before ? before.split('\n').length : 0
  const b = after ? after.split('\n').length : 0
  const edits = Math.max(1, Math.min(128, Math.floor(2_000_000 / Math.max(1, a + b))))
  if (diffLines(before, after, { maxEditLength: edits }))
    return createTwoFilesPatch(`a/${p}`, `b/${p}`, before, after, 'base', person, { context: 3 })
  const patchLines = (value: string, prefix: '-' | '+') => {
    if (!value) return ''
    const complete = value.endsWith('\n')
    const body = (complete ? value.slice(0, -1) : value).split('\n').map(line => `${prefix}${line}\n`).join('')
    return complete ? body : body + '\\ No newline at end of file\n'
  }
  const count = (value: string) => value ? value.split('\n').length - Number(value.endsWith('\n')) : 0
  return `===================================================================\n--- a/${p}\tbase\n+++ b/${p}\t${person}\n@@ -${before ? 1 : 0},${count(before)} +${after ? 1 : 0},${count(after)} @@\n${patchLines(before, '-')}${patchLines(after, '+')}`
}

const previewGenerations = new WeakMap<Session, number>()

export function handlers(state: HandlerState): Record<string, Handler> {
  const { S, rooms, others, presences, myWorkers, readVersion, lines, baseFor, ledgerLines, baseText, describeUsers } = state
  const gapLine = (person: string, p: string, version: Version): string => {
    if (version.kind === 'held') {
      const reason = version.entry.held === 'scope' ? 'outside their declared area' : version.entry.held === 'binary' ? 'binary file' : 'worker text not in this room'
      const size = version.entry.size === undefined ? '' : ` (${version.entry.size} bytes)`
      return `${p} changed by ${person}${size}; text not shared: ${reason}`
    }
    if (version.kind === 'excluded') return `${person} changed ${p}; it is excluded by their ignore rules or size limits`
    return `${p}: ${person}'s version is unknown: ${version.kind === 'unknown' ? version.detail : 'unavailable'}`
  }
  const readDiff: Handler = async a => {
      const caller = S()
      const person = typeof a.person === 'string' && a.person ? a.person : caller.me.name
      const s = rooms.holding(person, caller)
      const ownDisk = person === s.me.name
      for (let attempt = 0; attempt < 2; attempt++) {
        // One immutable publication view supplies the base, path set, text and coverage.
        const snap = ownDisk ? undefined : snapshot(s.room, person, participantsView(s.room, s.awareness, Date.now()))
        const callerSnap = !ownDisk ? snapshot(caller.room, caller.me.name, participantsView(caller.room, caller.awareness, Date.now())) : undefined
        const myBase = callerSnap?.head.base ?? baseFor(caller, caller.me.name)
        const worker = await trustedWorker(s, person)
        const theirBase = worker?.base ?? (ownDisk ? baseFor(s, person) : snap?.head.base ?? baseFor(s, person))
        const note = !worker && !ownDisk && theirBase !== myBase
          ? `note: ${person} is on base ${theirBase.slice(0, 10)} and you are on ${myBase.slice(0, 10)}; their files are compared with their own base, so commits only one of you has are not shown as their changes\n`
          : ''
        const label = (text: string) => `${worker ? WORKTREE_NOTE + '\n' : ''}${note}${text}`
        const current = () => ownDisk || !!worker || ((snap
          ? snapshotStillCurrent(s.room, snap, participantsView(s.room, s.awareness, Date.now()))
          : !s.room.manifestHead.has(person)) && (callerSnap
          ? snapshotStillCurrent(caller.room, callerSnap, participantsView(caller.room, caller.awareness, Date.now()))
          : baseFor(caller, caller.me.name) === myBase))
        const reportGitFailure = async (error: unknown): Promise<never> => {
          if (!ownDisk && !worker && await gitCommitMissing(s.dir, theirBase))
            throw new Error(`error: ${person}'s HEAD ${theirBase.slice(0, 10)} is not in this clone; run git fetch, then retry`)
          throw error
        }
        const one = async (p: string) => {
          let version: Version | undefined
          try { version = ownDisk || worker ? undefined : await versionOf(snap, p, {
            gitAt: (sha, relpath) => readBoundedHistoricalText(s.dir, sha, relpath),
            known: hash => readBoundedCheckoutText(s.dir, hash, p, 'utf8', false).catch(() => undefined),
          }) }
          catch (error) { return reportGitFailure(error) }
          if (version?.kind === 'unknown' && version.why === 'fetch') {
            // versionOf cannot retain the Git error in a snapshot; probe this base directly.
            try { await readBoundedHistoricalText(s.dir, theirBase, p) }
            catch (error) { return reportGitFailure(error) }
          }
          if (version && !['text', 'base', 'deleted'].includes(version.kind)) return gapLine(person, p, version)
          const l = ownDisk || worker ? await ownDiskText(worker?.dir ?? s.dir, p)
            : version?.kind === 'text' ? version.text : version?.kind === 'base' ? version.text : null
          let b: string
          try { b = (await readBoundedHistoricalText(worker?.dir ?? s.dir, theirBase, p)) ?? '' }
          catch (error) {
            if (error instanceof HistoricalTextTooLarge) return `${p}: ${person}'s historical text exceeds Room read limit; diff unavailable`
            return reportGitFailure(error)
          }
          const live = l === null ? '' : l ?? b
          return live === b ? '' : boundedTwoFilesPatch(p, b, live, person)
        }
        try {
          let result: string
          if (typeof a.path === 'string' && a.path) result = label((await one(a.path)) || `${a.path}: no difference between base and ${person}'s version`)
          else {
            const parts: string[] = []
            const paths = worker || ownDisk ? new Set([
              ...(await gitWholeTree(worker?.dir ?? s.dir, ['diff', '--name-only', '-z', theirBase, '--'])).split('\0'),
              ...(await gitWholeTree(worker?.dir ?? s.dir, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0'),
            ].filter(Boolean)) : [...snap?.entries.keys() ?? []].sort()
            for (const p of paths) {
              await new Promise<void>(resolve => setImmediate(resolve))
              const d = await one(p)
              if (d) parts.push(d)
            }
            const head = snap?.head
            if (head) parts.push(`${person} coverage: ${head.coverage.kind}${head.coverage.kind === 'none' ? ` (${head.coverage.reason})` : ''}; ${head.excluded.length} changed path(s) excluded (names not shared)`)
            result = label(parts.length ? parts.join('\n') : `${person} has no uncommitted changes`)
          }
          if (current()) return result
        } catch (error) {
          if (current()) throw error
        }
      }
      return `${person}'s changes moved during the diff; re-run`
  }
  const handlers: Record<string, Handler> = {
    async room_read(a) {
      if (a.diff === true) return readDiff(a)
      if (typeof a.path !== 'string' || !a.path) return 'error: path is required'
      const p = a.path
      const person = typeof a.person === 'string' && a.person ? a.person : S().me.name
      const s = rooms.holding(person, S()) // a local worker's overlay lives in the workers room, not the team room
      const worker = await trustedWorker(s, person)
      const note = worker ? ` ${WORKTREE_NOTE}` : ''
      const ownDisk = person === s.me.name
      const version = ownDisk || worker ? undefined : await readVersion(s, p, person)
      if (version && !['text', 'base', 'deleted'].includes(version.kind)) return gapLine(person, p, version)
      const t = ownDisk || worker ? await ownDiskText(worker?.dir ?? s.dir, p)
        : version?.kind === 'text' ? version.text : version?.kind === 'base' ? version.text : null
      if (t === null) {
        if (ownDisk && await baseText(s, p, person) === undefined) return `error: ${p} exists neither at base nor in ${person}'s changes${note}`
        return `${p}: deleted by ${person} (uncommitted)${note}`
      }
      if (t === undefined) return `error: ${p} exists neither at base nor in ${person}'s changes${note}`
      const edited = ownDisk ? t !== await baseText(s, p, person) : !!worker || version?.kind === 'text'
      const out = [`${p} as ${person} sees it (${lines(t)} lines${edited ? ', uncommitted edits' : ', unchanged'} on their base ${baseFor(s, person).slice(0, 10)})${note}`]
      const who = manifestChangers(s.room, p).filter(x => x !== person && !sameCheckoutSession(s, x))
      if (who.length) out.push(`! also changed (uncommitted) by: ${who.join(', ')} — room_read with person= to see theirs`)
      for (const c of s.room.claimsFor(p)) out.push(`! claim ${c.id}: ${describeClaim(c)}`)
      out.push(withLineNumbers(t))
      out.push(...ledgerLines(s, { path: p, limit: 10 }, p))
      return out.join('\n')
    },

    async room_impact(a) {
      const s = S()
      if (!s.graph) return 'error: no symbol graph in this session'
      await s.graph.ready
      const g = s.graph.graph
      const out: string[] = []
      if (typeof a.symbol === 'string' && a.symbol) {
        const i = g.impact(a.symbol)
        out.push(`${a.symbol}: defined in ${i.definedIn.length ? describeUsers(s, i.definedIn) : 'nowhere indexed'}`)
        out.push(i.usedIn.length ? `used in ${i.usedIn.length} file(s): ${describeUsers(s, i.usedIn)}` : 'used by no other indexed file')
        for (const c of s.room.openClaims()) if (c.plans?.some(pl => pl.symbol === a.symbol)) out.push(`open plan: ${describeClaim(c)}`)
      } else if (typeof a.path === 'string' && a.path) {
        if (!g.has(a.path)) return `${a.path} is not in the graph (not a source file, too large, or not at base/overlays)`
        const deps = g.dependenciesOf(a.path), dependents = g.dependentsOf(a.path)
        out.push(`${a.path} depends on ${deps.length} symbol(s) defined elsewhere:`)
        for (const d of deps.slice(0, 40)) out.push(`  - ${d.symbol} from ${describeUsers(s, d.definedIn)}`)
        out.push(`${a.path} defines ${dependents.length} symbol(s) used elsewhere:`)
        for (const d of dependents.slice(0, 40)) out.push(`  - ${d.symbol} used in ${describeUsers(s, d.usedIn)}`)
      } else return 'error: pass symbol or path'
      return out.join('\n')
    },
    async room_preview_merge(a) {
      const caller = S()
      const generation = (previewGenerations.get(caller) ?? 0) + 1
      previewGenerations.set(caller, generation)
      const recordPreview = (value: NonNullable<Session['lastPreview']>) => {
        if (previewGenerations.get(caller) === generation) caller.lastPreview = value
      }
      // A new request replaces the evidence consumed by room_done, including refusals.
      recordPreview({ clean: false, complete: false, testsPassed: false })
      const alias = typeof a.person === 'string' && a.person.trim() ? a.person.trim() : ''
      if (a.people !== undefined && !Array.isArray(a.people)) return 'error: people must be an array of names'
      if (Array.isArray(a.people) && a.people.some(p => typeof p !== 'string' || !p.trim())) return 'error: people must contain non-empty names'
      if (Array.isArray(a.people) && alias) return 'error: pass people or person, not both'
      if (a.includeOffline !== undefined && typeof a.includeOffline !== 'boolean') return 'error: includeOffline must be a boolean'
      const explicit = Array.isArray(a.people) || !!alias
      const allSessions = rooms.all()
      const nameContext = { all: () => allSessions, presences, myWorkers: (s: Session) => [...myWorkers(s), ...localWorkers(s.dir)] }
      const presentSession = (person: string) => allSessions.find(s => presences(s).some(p => p.user.name === person))
      const present = Array.from(new Set(allSessions.flatMap(s => neighbours(participantsView(s.room, s.awareness, Date.now()), caller.me.name).names().filter(name => presences(s).some(p => p.user.name === name)))))
      const available = Array.from(new Set(allSessions.flatMap(s => others(s)))).filter(p => p !== caller.me.name)
      const myPaths = [...manifestPaths(caller.room, caller.me.name), ...(caller.room.scope(caller.me.name)?.paths ?? [])]
      const unavailable: string[] = []
      const overlaps = async (person: string) => {
        const session = rooms.holding(person, caller)
        const worker = session.room.acceptedWorkerViewOf(person)
        if (worker?.lead === caller.me.name && worker.status === 'running') return true
        const theirs = manifestPaths(session.room, person)
        try {
          const mineBase = baseFor(caller, caller.me.name), theirBase = baseFor(session, person)
          const remote = await roomRemote(caller.dir, caller.roomName)
          if (!await ensureCommit(caller.dir, remote, mineBase) || !await ensureCommit(caller.dir, remote, theirBase)) throw new Error('anchor commit unavailable')
          const ancestor = (await git(caller.dir, ['merge-base', mineBase, theirBase])).trim()
          const changed = async (base: string) => base === ancestor ? [] : [...new Set((await gitWholeTree(caller.dir, ['diff', '--name-only', '-z', ancestor, base])).split('\0').filter(Boolean))]
          const mineCommitted = await changed(mineBase), theirCommitted = await changed(theirBase)
          const overBound = mineCommitted.length > 2000 || theirCommitted.length > 2000
          if (overBound) unavailable.push(`${person}: committed path enumeration exceeds 2000; selecting from manifest paths only`)
          const mine = [...new Set([...myPaths, ...(!overBound ? mineCommitted : [])])]
          const peer = [...new Set([...theirs, ...(!overBound ? theirCommitted : [])])]
          return peer.some(p => mine.some(path => coversPath(p, path)))
        } catch (error) {
          unavailable.push(`${person}: committed changes unavailable (${error instanceof Error ? error.message : String(error)})`)
          return false
        }
      }
      const runningWorkers = allSessions.flatMap(s => myWorkers(s).filter(w => w.lead === caller.me.name && w.status === 'running').map(w => w.name))
      const overlapping = explicit || a.includeOffline === true ? [] : (await Promise.all(available.filter(p => present.includes(p)).map(async p => ({ person: p, yes: await overlaps(p) })))).filter(p => p.yes).map(p => p.person)
      const dropped: string[] = []
      const requested = explicit ? Array.isArray(a.people) ? (a.people as string[]).map(p => p.trim()) : [alias] : []
      const resolved: string[] = []
      for (const name of requested) {
        const result = resolveDisplayedName(name, nameContext, caller)
        if (result.ambiguous) return `error: ${name} is ambiguous; use a full name: ${result.ambiguous.join(', ')}`
        if (!result.name) {
          const known = [...new Set(allSessions.flatMap(s => [...knownNames(s, presences)]))].sort()
          return `error: nobody called ${name} is or was in this room; known names: ${known.join(', ')}`
        }
        if (result.name === caller.me.name) dropped.push(`you are always included; dropped ${name}`)
        else resolved.push(result.name)
      }
      const people = Array.from(new Set(explicit ? resolved : [...(a.includeOffline === true ? available : overlapping), ...runningWorkers].sort())).filter(p => p !== caller.me.name)
      const offlineWithFacts = available.filter(person => !present.includes(person) && manifestPaths(rooms.holding(person, caller).room, person).length > 0)
      const skipped = !explicit ? offlineWithFacts.filter(person => !people.includes(person)) : []
      const skippedNote = skipped.length
        ? `skipped ${skipped.length} offline participant${skipped.length === 1 ? '' : 's'} with manifest facts: ${skipped.join(', ')}; include with people: [${skipped.map(p => JSON.stringify(p)).join(', ')}] or includeOffline: true`
        : ''
      const recordPartial = async (names: string[], gaps: string[], command = '', ranOk?: boolean, anchors = '', applied = true) => {
        await caller.post<NoteMsg>(caller.me, {
          type: 'note', priority: 'fyi',
          text: `partial preview with ${names.join(', ') || 'no participants'}: ${gaps.join('; ')}${anchors}${command ? applied
            ? `; command "${command}" ${ranOk ? `passed on a PARTIAL tree (excluded: ${gaps.join('; ')})` : 'failed or was not run on a partial tree'}`
            : `; command "${command}" ran on your own tree only; no peer changes applied` : '; tests not run'}; combined work not verified`,
        })
      }
      if (!people.length) {
        if (unavailable.length || skippedNote) {
          recordPreview({ clean: false, complete: false, testsPassed: false })
          await recordPartial([], [...unavailable, ...(skippedNote ? [skippedNote] : [])])
        }
        return [...dropped, 'no present participants to merge', skippedNote, ...(unavailable.length ? [`PARTIAL preview: skipped ${unavailable.join('; ')}`] : [])].filter(Boolean).join('\n')
      }
      const participants = people.map(person => ({ person, session: presentSession(person) ?? rooms.holding(person, caller) }))
      const anchorsFor = async (result: Awaited<ReturnType<typeof buildCombinedTree>>) => (await Promise.all(result.includedParticipants.map(async ({ person, base, gitRecord, liveShared }) => {
        // Only name a commit already published by this participant's accepted git record.
        if (base === result.callerBase || !gitRecord || gitRecord.base !== base) return []
        let pushed = false
        if (gitRecord.upstream && gitRecord.ahead === 0 && gitRecord.head === base) {
          try { pushed = (await git(caller.dir, ['rev-parse', '--verify', `refs/remotes/${gitRecord.upstream}`])).trim() === base }
          catch { /* A starting anchor alone cannot prove this participant pushed it. */ }
        }
        const location = pushed ? ` (pushed to ${gitRecord.upstream})` : ''
        const live = liveShared ? ' + live changes' : ''
        return [`${person} at ${base.slice(0, 10)}${location}${live}`]
      }))).flat()
      const missingNotes: string[] = []
      for (const { person, session } of participants) {
        const ownLocalWorker = session.local && localWorkers(session.dir, record => record.name === person)[0]
        const facts = ownLocalWorker && await workerRealState(session.dir, ownLocalWorker)
        const preview = facts && decidePreview(facts, ownLocalWorker.lead === caller.me.name)
        const missing = !!ownLocalWorker && facts?.worktree === 'vanished' && ownLocalWorker.lead === caller.me.name
        if (missing) missingNotes.push(`${person}'s worktree no longer exists; previewing its shared overlay instead`)
      }
      const run = typeof a.run === 'string' && a.run.trim() ? a.run.trim() : ''
      const noTestsNote = run ? '' : `no tests were run on the combined code; pass run="${testCommandFor(caller.dir)}" to check it`
      try {
        const result = await previewPhase('merge', () => buildCombinedTree(state, caller, participants, { resolve: a.resolve === true, ...(run ? { encoding: 'latin1' as const } : { skipCallerOnly: true }) }))
        const anchors = await anchorsFor(result)
        const anchorNote = anchors.length ? `; included ${anchors.join(', ')}` : ''
        const { ancestor, paths, merged, hardCount, conflictCount, resolvedText, out, gaps } = result
        const complete = result.complete && unavailable.length === 0
        const gapLines = [...gaps.map(gap => gap.path ? `${gap.path}: ${gap.person}'s version not included (${gap.why})` : `${gap.person}: ${gap.why}`), ...unavailable]
        if (!paths.length && !result.callerOnly && !run) {
          recordPreview({ clean: hardCount === 0, complete, testsPassed: false })
          if (!complete) await recordPartial(people, gapLines, '', undefined, anchorNote)
          return [...dropped, ...missingNotes, ...out, complete ? `none of you (${[caller.me.name, ...people].join(', ')}) has changes relative to ${ancestor.slice(0, 10)}` : `PARTIAL preview: no mergeable shared changes; not in the room: ${gapLines.join('; ')}`, ...(anchors.length ? [`included ${anchors.join(', ')}`] : []), skippedNote].filter(Boolean).join('\n')
        }
        out.unshift(...dropped, ...missingNotes)
        if (skippedNote) out.push(skippedNote)
        if (!complete) out.push(`PARTIAL preview: ${gapLines.join('; ')}; the combined code was NOT fully checked`)
        for (const [p, text] of resolvedText) out.push(`--- resolved ${p} (write this to your clone) ---\n${text}--- end ${p} ---`)
        out.push(`final combined tree: ${merged.size} path(s) applied${result.callerOnly ? ` (plus ${result.callerOnly} only you changed)` : ''} over ${ancestor.slice(0, 10)} from ${[caller.me.name, ...people].join(', ')}${hardCount ? `; excludes ${hardCount} unresolved conflict(s)` : ''}`)
        if (anchors.length) out.push(`included ${anchors.join(', ')}`)
        if (noTestsNote) out.push(noTestsNote)
        const appliedFromOthers = [...result.owners.values()].some(owners => owners.some(owner => owner !== caller.me.name))
        let ranOk = !run
        if (run) {
          if (hardCount) out.push(`not running "${run}": ${hardCount} conflict(s) need a human first`)
          else {
            const modeParticipants = (await Promise.all(participants.map(async ({ person }) => {
              const w = result.diskWorkers.get(person)
              if (!w) return undefined
              const dir = result.roots.get(path.resolve(w.dir))
              if (!dir) throw new Error('uncaptured preview root: ' + w.dir)
              return { dir, baseModes: addCarriedUntrackedModes(await gitTreeModes(caller.dir, result.deltaBases.get(person)!), w), ownedPaths: workerOwnedPaths(w), unchangedCarried: carriedUnchangedPaths(workerBaseline(w)), carriedPaths: new Set(w.carriedUntracked?.map(entry => entry.path) ?? []) }
            }))).filter((x): x is NonNullable<typeof x> => !!x)
            const modes = new Map<string, number>()
            let modeCount = 0
            for (const p of merged.keys()) {
              if (modeCount++ % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve))
              let leadMode = 0o644
              try { const stat = fs.lstatSync(path.join(caller.dir, p)); if (stat.isFile()) leadMode = stat.mode & 0o777 } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
              modes.set(p, mergedFileMode(p, leadMode, modeParticipants))
            }
            const verdict = await runInMergedTree(caller, ancestor, merged, run, modes)
            ranOk = verdict.passed
            const qualifier = !complete ? `; passed on a PARTIAL tree (excluded: ${gapLines.join('; ')})`
              : !appliedFromOthers ? '; passed on your own tree only' : ''
            out.push(verdict.passed && qualifier ? verdict.text.replace(/tests: PASSED( \(exit 0\))?/, match => match + qualifier) : verdict.text)
            if (!appliedFromOthers) out.push(`no changes from ${people.join(', ')} to apply; ran the check on your own tree only`)
            if (!complete) out.push('Tests ran on a partial tree; this does not verify the combined work')
          }
        }
        if (!result.isCurrent()) {
          recordPreview({ clean: false, complete: false, testsPassed: false, ...(run ? { testsCommand: run } : {}) })
          return `${people.join(', ')} moved during the preview; re-run. The combined code was NOT fully checked`
        }
        recordPreview({ clean: hardCount === 0, complete, testsPassed: run ? complete && hardCount === 0 && ranOk && appliedFromOthers : false,
          ...(run ? { partialPassed: !complete && hardCount === 0 && ranOk && appliedFromOthers, testsCommand: run } : {}) })
        if (!complete) await recordPartial(people, gapLines, run, ranOk, anchorNote, appliedFromOthers)
        // A passing preview is part of the branch's story (room_pr_note lists them); a failing one is not.
        if (previewGenerations.get(caller) === generation && complete && !hardCount && ranOk && appliedFromOthers) await caller.post<NoteMsg>(caller.me, { type: 'note', text: `merge preview with ${people.join(', ')}: ${conflictCount ? `${conflictCount} resolvable conflict(s)` : 'no conflicts'} across ${paths.length} path(s)${anchorNote}${run ? `; "${run}" passed` : ''}`, priority: 'fyi' })
        return previewPhase('collect', () => out.join('\n'))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!isGitTimeout(error)) throw error
        recordPreview({ clean: false, complete: false })
        return `preview failed: ${message.replace(/ failed: timed out/, ' timed out')}; combined code was NOT checked`
      }
    }
  }
  return handlers
}
export { supersetSide } from './combined-tree.js'

/**
 * Give the scratch tree my clone's dependencies without letting them point back at my clone's sources.
 * `.venv` is linked whole. Each `node_modules` (root, and one level down for workspaces) is rebuilt as a
 * directory of links: third-party packages link to my clone's copies; workspace packages (links into the
 * clone itself) are re-pointed at the same relative path inside the scratch tree, so tests there import
 * the merged sources rather than mine.
 */
export async function linkSharedDirs(cloneDir: string, scratchDir: string): Promise<void> {
  const yieldTurn = () => new Promise<void>(resolve => setImmediate(resolve))
  await yieldTurn()
  ensureMergedDirectory(scratchDir, '')
  const venv = path.join(cloneDir, '.venv')
  const scratchVenv = path.join(scratchDir, '.venv')
  try { if ((await fs.promises.lstat(scratchVenv)).isSymbolicLink()) await fs.promises.unlink(scratchVenv) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (fs.existsSync(venv) && !fs.existsSync(scratchVenv)) fs.symlinkSync(venv, scratchVenv)
  const candidates = new Set(['node_modules'])
  for (const top of ['packages', 'apps', 'libs']) {
    await yieldTurn()
    for (const root of [cloneDir, scratchDir]) {
      const d = path.join(root, top)
      try { if (!(await fs.promises.lstat(d)).isDirectory()) continue }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      let count = 0
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (count++ % 32 === 0) await yieldTurn()
        if (e.isDirectory()) candidates.add(path.join(top, e.name, 'node_modules'))
      }
    }
  }
  for (const [index, rel] of [...candidates].entries()) {
    if (index % 32 === 0) await yieldTurn()
    const src = path.join(cloneDir, rel), dst = path.join(scratchDir, rel)
    if (rel !== 'node_modules') ensureMergedDirectory(scratchDir, path.dirname(rel))
    // These shallow trees contain only links created by Room. Rebuild them each time so
    // npm installs, package additions and workspace relinks are reflected in the check.
    try { await fs.promises.lstat(dst); await fs.promises.rm(dst, { recursive: true, force: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (!fs.existsSync(src)) continue
    await mirrorLinks(cloneDir, scratchDir, src, dst)
  }
}
async function mirrorLinks(cloneDir: string, scratchDir: string, src: string, dst: string): Promise<void> {
  ensureMergedDirectory(scratchDir, path.relative(scratchDir, dst))
  let count = 0
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (count++ % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve))
    // Another task could replace a scratch ancestor during the yield.
    ensureMergedDirectory(scratchDir, path.relative(scratchDir, dst))
    const from = path.join(src, e.name), to = path.join(dst, e.name)
    if (e.isSymbolicLink()) {
      const target = path.resolve(src, fs.readlinkSync(from))
      const inside = path.relative(cloneDir, target)
      const isWorkspace = inside && !inside.startsWith('..') && !inside.split(path.sep).includes('node_modules')
      fs.symlinkSync(isWorkspace ? path.join(scratchDir, inside) : target, to)
    } else if (e.isDirectory() && e.name.startsWith('@')) {
      await mirrorLinks(cloneDir, scratchDir, from, to) // scoped packages: one level deeper
    } else {
      fs.symlinkSync(from, to)
    }
  }
}

export interface TestResult { text: string; passed: boolean }

function ensureMergedDirectory(root: string, rel: string): string {
  const canonicalRoot = path.resolve(root)
  if (!containedRepoPath(canonicalRoot, canonicalRoot, { leaf: 'read-contained-link', allowRoot: true }).ok) throw new Error('merged root is no longer safe')
  if (!rel) return canonicalRoot
  if (!validRepoPath(rel, MATERIALIZED_PATH)) throw new Error('unsafe merged path: ' + rel)
  let at = canonicalRoot
  for (const part of rel.split('/')) {
    at = path.join(at, part)
    let stat: fs.Stats | undefined
    try { stat = fs.lstatSync(at) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) throw new Error('unsafe merged ancestor: ' + rel)
    if (!stat) fs.mkdirSync(at)
    if (!containedRepoPath(canonicalRoot, at, { leaf: 'read-contained-link', allowRoot: true }).ok) throw new Error('merged path escapes scratch tree: ' + rel)
  }
  return at
}

export async function gitTreeModes(dir: string, ref: string): Promise<Map<string, number>> {
  const entries = (await gitWholeTree(dir, ['ls-tree', '-rz', ref])).split('\0').filter(Boolean)
  return new Map(entries.map(entry => { const tab = entry.indexOf('\t'); const meta = entry.slice(0, tab), rel = entry.slice(tab + 1); return [rel, parseInt(meta.split(' ')[0], 8) & 0o777] }))
}

export function addCarriedUntrackedModes(modes: Map<string, number>, worker: Pick<LocalWorker, 'carriedUntracked'>): Map<string, number> {
  for (const entry of worker.carriedUntracked ?? []) if (entry.mode !== undefined) modes.set(entry.path, entry.mode)
  return modes
}

/** A mode change belongs to a worker only when it differs from that worker's carried base; carried files it left unchanged (baseline.ts) supply none. */
export function mergedFileMode(rel: string, initialMode: number, participants: { dir: string; baseModes: ReadonlyMap<string, number>; ownedPaths?: { includes(rel: string): boolean }; unchangedCarried?: ReadonlySet<string>; carriedPaths?: ReadonlySet<string> }[]): number {
  let mode = initialMode
  for (const participant of participants) {
    if (participant.ownedPaths?.includes(rel) || participant.unchangedCarried?.has(rel)) continue
    const src = path.join(participant.dir, rel)
    let stat: fs.Stats
    try {
      const root = path.resolve(participant.dir)
      if (!containedRepoPath(root, path.join(root, rel), { leaf: 'read-contained-link', allowRoot: true }).ok) throw new Error('unsafe worker mode path: ' + rel)
      stat = fs.lstatSync(src)
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e }
    if (!stat.isFile()) continue
    const workerMode = stat.mode & 0o777, baseMode = participant.baseModes.get(rel)
    if (baseMode === undefined && participant.carriedPaths?.has(rel)) continue
    if (workerMode === baseMode) continue
    if (mode !== initialMode && mode !== workerMode) throw new Error('conflicting file modes: ' + rel)
    if (baseMode !== undefined && initialMode !== baseMode && initialMode !== workerMode) throw new Error('conflicting file modes: ' + rel)
    mode = workerMode
  }
  return mode
}

/** Materialize one merged byte image without following links from an archived ancestor. */
export function materializeMergedFile(root: string, rel: string, bytes: Buffer | null, mode = 0o644): void {
  if (!validRepoPath(rel, MATERIALIZED_PATH)) throw new Error('unsafe merged path: ' + rel)
  const canonicalRoot = path.resolve(root)
  if (!containedRepoPath(canonicalRoot, canonicalRoot, { leaf: 'read-contained-link', allowRoot: true }).ok) throw new Error('merged root is no longer safe')
  const parts = rel.split('/')
  const parent = ensureMergedDirectory(canonicalRoot, parts.slice(0, -1).join('/'))
  const file = path.join(parent, parts.at(-1)!)
  let stat: fs.Stats | undefined
  try { stat = fs.lstatSync(file) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  // Replace-link leaf policy: unlink a symlink here, never follow it when writing.
  if (stat?.isSymbolicLink()) fs.unlinkSync(file)
  else if (stat && !stat.isFile()) throw new Error('merged path is not a regular file: ' + rel)
  if (bytes === null) { if (stat && !stat.isSymbolicLink()) fs.rmSync(file); return }
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0), mode)
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode) } finally { fs.closeSync(fd) }
}

/** Runner summaries plus an authoritative verdict; at most six lines total. */
export function testVerdict(output: string, code: number | null): TestResult {
  const lines = stripVTControlCharacters(output).split(/\r?\n/).map(line => line.trim())
  const summaries = lines.filter(line => /^(?:Test Files\s+|Tests(?:\s+|:)|FAIL\b|ok\s|test result:|FAILED\s*\(|OK(?:\s*\(|$))/.test(line)
    || /^=+ .*(?:passed|failed|error|skipped|deselected|no tests ran).* =+$/i.test(line))
  const failed = lines.some(line => /\b[1-9]\d*\s+(?:failed|errors?)\b/i.test(line)
    || /^FAIL(?:\s|\t|$)/.test(line)
    || /^test result:\s*FAILED\b/i.test(line)
    || /^FAILED\s*\(/.test(line))
  const passedSummary = lines.some(line => /\b[1-9]\d*\s+passed\b/i.test(line)
    || /^ok\s+\S+/.test(line)
    || /^test result:\s*ok\b/i.test(line)
    || /^OK(?:\s*\(|$)/.test(line))
  const passed = code === 0 && passedSummary && !failed
  const verdict = code !== 0 || failed
    ? `tests: FAILED (exit ${code ?? 'unknown'})`
    : passed
      ? 'tests: PASSED (exit 0)'
      : 'tests: exit 0 (no test summary recognised)'
  return { passed, text: [...summaries.slice(-5), verdict].join('\n') }
}

function canonicalPreviewClonePath(cloneDir: string): string {
  let existing = path.resolve(cloneDir)
  const missing: string[] = []
  while (!fs.existsSync(existing)) { missing.unshift(path.basename(existing)); existing = path.dirname(existing) }
  return path.join(fs.realpathSync(existing), ...missing)
}

/** Clone-key directories hold shared checkout-policy entries. */
async function previewKeyPath(cloneDir: string, repoDir = cloneDir): Promise<string> {
  const common = await fs.promises.realpath(await gitCommonDir(repoDir))
  const key = createHash('sha256').update(canonicalPreviewClonePath(cloneDir)).digest('hex').slice(0, 20)
  const root = path.join(common, 'room-preview')
  await rejectPreviewLink(root)
  return path.join(root, key)
}

async function rejectPreviewLink(file: string): Promise<void> {
  try { if ((await fs.promises.lstat(file)).isSymbolicLink()) throw new Error('unsafe preview cache link') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}

const SETUP_TIMEOUT_MS = 10 * 60_000
const previewProcesses = new AsyncLocalStorage<{ lock?: PreviewUnlock }>()
const previewProcessGate = 'IFS= read -r permit || exit 1; [ "$permit" = GO ] || exit 1; exec "$@"'

function previewGroupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true }
  catch { return false }
}

function runTrackedProcess(file: string, args: string[], cwd: string, timeout: number, maxBuffer: number, lock?: PreviewUnlock, env = process.env): Promise<{ code: number; stdout: string; stderr: string; stopped: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', previewProcessGate, 'sh', file, ...args], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = [], err: Buffer[] = []
    let bytes = 0, failed: Error | undefined
    let termAt: number | undefined
    let killTimer: NodeJS.Timeout | undefined
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid) { try { process.kill(-child.pid, signal) } catch { /* already exited */ } }
    }
    const terminate = () => {
      if (termAt !== undefined) return
      termAt = Date.now()
      signalGroup('SIGTERM')
      killTimer = setTimeout(() => signalGroup('SIGKILL'), 2000)
    }
    const stop = (error: Error) => {
      if (failed) return
      failed = error
      terminate()
    }
    const timer = setTimeout(() => stop(new Error(`timed out after ${timeout}ms`)), timeout)
    const collect = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxBuffer) { stop(new Error('output exceeded preview buffer')); return }
      if (kind === 'stdout') out.push(chunk)
      else err.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk))
    child.stdin.on('error', stop)
    child.on('error', stop)
    let exited = false
    const closed = new Promise<void>(done => child.once('close', () => done()))
    child.on('close', () => {
      if (!exited) {
        clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        reject(failed ?? new Error('tracked preview process closed without exiting'))
      }
    })
    child.on('exit', code => {
      exited = true
      void (async () => {
        const stopped = !!child.pid && previewGroupAlive(child.pid)
        if (stopped) terminate()
        while (child.pid && previewGroupAlive(child.pid)) {
          if (termAt !== undefined && Date.now() - termAt >= 2000) signalGroup('SIGKILL')
          await new Promise(done => setTimeout(done, 25))
        }
        await closed
        clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        if (failed) reject(failed)
        else resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), stopped })
      })().catch(reject)
    })
    if (child.pid && lock) void lock.trackProcess(child.pid).then(() => child.stdin.end('GO\n'), stop)
    else if (child.pid) child.stdin.end('GO\n')
  })
}

const gitSetup = (dir: string, args: string[]) => {
  const lock = previewProcesses.getStore()?.lock
  if (!lock) return git(dir, args, SETUP_TIMEOUT_MS)
  return runTrackedProcess('git', args, dir, SETUP_TIMEOUT_MS, 64 * 1024 * 1024, lock).then(result => {
    if (result.code) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim() || `exit ${result.code}`}`)
    return result.stdout
  })
}
const PROBE_TIMEOUT_MS = 3000
let processProbeForTests: ((pid: number) => Promise<string | null | undefined>) | undefined
/** Test seam: null means dead, undefined means an uncertain live process. */
export function setPreviewProcessProbeForTests(probe?: (pid: number) => Promise<string | null | undefined>): void {
  processProbeForTests = probe
}

async function boundedProbe<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('process probe timed out')), PROBE_TIMEOUT_MS)
      timer.unref?.()
    })])
  } finally { if (timer) clearTimeout(timer) }
}

async function processCommand(file: string, args: string[]): Promise<string> {
  return boundedProbe(new Promise<string>((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } },
      (error, stdout) => error ? reject(error) : resolve(stdout))
  }))
}

/** Kernel birth marker only; errors and timeouts preserve the owner's slot. */
async function probePreviewStart(pid: number): Promise<string | null | undefined> {
  if (processProbeForTests) return boundedProbe(processProbeForTests(pid)).catch(() => undefined)
  if (!pidAlive(pid)) return null
  try {
    if (process.platform === 'linux') {
      const stat = await boundedProbe(fs.promises.readFile(`/proc/${pid}/stat`, 'utf8'))
      const close = stat.lastIndexOf(')')
      const ticks = close < 0 ? undefined : stat.slice(close + 1).trim().split(/\s+/)[19]
      const boot = await boundedProbe(fs.promises.readFile('/proc/sys/kernel/random/boot_id', 'utf8'))
      if (/^\d+$/.test(ticks ?? '') && boot.trim()) return `linux:${boot.trim()}:${ticks}`
    } else if (process.platform === 'darwin') {
      const seconds = parsePsLstartUtc(await processCommand('ps', ['-o', 'lstart=', '-p', String(pid)]))
      const boot = (await processCommand('sysctl', ['-n', 'kern.boottime'])).match(/sec\s*=\s*(\d+)/)?.[1]
      if (seconds !== undefined && boot) return `darwin:${boot}:${seconds}`
    }
  } catch { /* An unreadable live process is uncertain. */ }
  return undefined
}

function slotOwner(name: string): { pid: number; starts: string[] } | undefined {
  const match = /^([1-9]\d*)-(.+)$/.exec(name)
  if (!match || !Number.isSafeInteger(Number(match[1]))) return undefined
  // Two-part legacy names can themselves end in "-<digits>". Accept either
  // interpretation for liveness, so no live legacy slot is reclaimed.
  try {
    const starts = [decodeURIComponent(match[2])]
    const generation = /^(.*)-(\d+)$/.exec(match[2])
    if (generation) starts.push(decodeURIComponent(generation[1]))
    return { pid: Number(match[1]), starts }
  } catch { return undefined }
}
async function isDeadSlot(name: string): Promise<boolean> {
  const owner = slotOwner(name)
  if (!owner) return false
  const observed = await probePreviewStart(owner.pid)
  return observed === null || (observed !== undefined && !owner.starts.some(start => start.startsWith('opaque:') || start === observed))
}

async function isLegacyTree(key: string): Promise<boolean> {
  try { return (await fs.promises.lstat(path.join(key, '.git'))).isFile() }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

/** An older direct worktree at the key needs a sidecar directory for new entries. */
async function cacheEntryRoot(key: string): Promise<string> {
  await rejectPreviewLink(key)
  if (await isLegacyTree(key)) { await rejectPreviewLink(`${key}.slots`); return `${key}.slots` }
  try { await rejectPreviewLink(`${key}.slots`); await fs.promises.lstat(`${key}.slots`); return `${key}.slots` }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return key
}

export async function previewCachePath(cloneDir: string, repoDir = cloneDir): Promise<string> {
  const key = await previewKeyPath(cloneDir, repoDir)
  const source = fs.existsSync(cloneDir) ? await checkoutSettings(cloneDir) : { fingerprint: '0'.repeat(64) }
  return path.join(await cacheEntryRoot(key), `shared-${source.fingerprint.slice(0, 16)}`)
}

const checkoutConfigKeys = new Set(['core.autocrlf', 'core.eol', 'core.safecrlf', 'core.symlinks', 'core.filemode', 'core.ignorecase', 'core.precomposeunicode', 'core.attributesfile'])

/** Git folds the section and variable, but preserves a subsection such as filter.Upper. */
function checkoutConfigKey(key: string): string {
  const first = key.indexOf('.'), last = key.lastIndexOf('.')
  if (first < 0) return key.toLowerCase()
  if (first === last) return `${key.slice(0, first).toLowerCase()}.${key.slice(first + 1).toLowerCase()}`
  return `${key.slice(0, first).toLowerCase()}.${key.slice(first + 1, last)}.${key.slice(last + 1).toLowerCase()}`
}

async function optionalAttributeFile(file: string): Promise<Buffer> {
  return fs.promises.readFile(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0)
    throw error
  })
}

/** Git's boolean environment values: true/yes/on or a nonzero integer. */
const gitEnvTrue = (value: string | undefined): boolean => /^(true|yes|on)$/i.test(value?.trim() ?? '') || /^[+-]?\d+$/.test(value?.trim() ?? '') && Number(value) !== 0

/** Git prints one value and a newline: drop only that newline, never pathname bytes. */
const gitLine = (output: string): string => output.replace(/\r?\n$/, '')

async function systemAttributePaths(dir: string): Promise<string[]> {
  if (gitEnvTrue(process.env.GIT_ATTR_NOSYSTEM)) return []
  // Only Git knows its system attributes file (git var GIT_ATTR_SYSTEM, Git 2.42+). If it cannot say,
  // the checkout policy is unknown: the caller previews on a fresh tree instead of guessing paths.
  return [gitLine(await gitSetup(dir, ['var', 'GIT_ATTR_SYSTEM']))]
}

async function checkoutSettings(dir: string): Promise<{ fingerprint: string; sparse: boolean }> {
  const output = await gitSetup(dir, ['config', '--null', '--list'])
  const values = new Map<string, string>()
  for (const entry of output.split('\0')) {
    const separator = entry.indexOf('\n')
    if (separator >= 0) values.set(checkoutConfigKey(entry.slice(0, separator)), entry.slice(separator + 1))
  }
  const admin = (await gitSetup(dir, ['rev-parse', '--absolute-git-dir'])).trim()
  const sparseFile = path.join(admin, 'info', 'sparse-checkout')
  const sparse = /^(true|yes|on|1)$/i.test(values.get('core.sparsecheckout') ?? '')
    || await fs.promises.access(sparseFile).then(() => true, () => false)
  const infoAttributes = gitLine(await gitSetup(dir, ['rev-parse', '--path-format=absolute', '--git-path', 'info/attributes']))
  const configured = values.get('core.attributesfile')
  let userAttributes: string
  let userIdentity: string
  if (configured !== undefined) {
    // --path applies Git's ~/ and ~user expansion; a relative path is read from
    // the invoking worktree. Keep that relative spelling in the key so a slot
    // name never enters its own fingerprint.
    const expanded = (await gitSetup(dir, ['config', '--null', '--path', '--get', 'core.attributesFile'])).replace(/\0$/, '')
    userAttributes = path.resolve(dir, expanded)
    userIdentity = path.isAbsolute(expanded) ? expanded : `relative:${expanded}`
  } else {
    const home = process.env.HOME || os.homedir()
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
    userAttributes = path.join(xdg, 'git', 'attributes')
    userIdentity = userAttributes
  }
  const systemAttributes = await systemAttributePaths(dir)
  const relevant = [...values].filter(([key]) => checkoutConfigKeys.has(key) || /^filter\..+\.(smudge|clean|process|required)$/.test(key)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  const hash = createHash('sha256').update(JSON.stringify(relevant)).update('\0')
  for (const [kind, identity, file] of [
    ['info', infoAttributes, infoAttributes],
    ['user', userIdentity, userAttributes],
    ...systemAttributes.map(file => ['system', file, file]),
  ]) {
    const bytes = await optionalAttributeFile(file)
    hash.update(JSON.stringify([kind, identity, bytes.length])).update('\0').update(bytes).update('\0')
  }
  return { fingerprint: hash.digest('hex'), sparse }
}

function slotSettingsFile(slot: string): string { return path.join(path.dirname(slot), `.checkout-${path.basename(slot)}.json`) }

type SlotRegistration = 'valid' | 'missing-git' | 'unregistered' | 'foreign'

/** Authenticate both halves of a registration before mutating it. */
async function slotRegistration(repoDir: string, slot: string): Promise<SlotRegistration> {
  let gitfile: string | undefined
  const gitfilePath = path.join(slot, '.git')
  try {
    if (!(await fs.promises.lstat(gitfilePath)).isFile()) return 'foreign'
    const handle = await fs.promises.open(gitfilePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      if (!(await handle.stat()).isFile()) return 'foreign'
      gitfile = await handle.readFile('utf8')
    } finally { await handle.close() }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'foreign'
  }
  if (gitfile !== undefined) {
    const match = /^gitdir: (.+)\s*$/m.exec(gitfile)
    if (!match) return 'foreign'
    const common = await fs.promises.realpath(await gitCommonDir(repoDir))
    const parent = path.join(common, 'worktrees')
    let admin: string
    try { admin = await fs.promises.realpath(path.resolve(slot, match[1])) }
    catch { return 'foreign' }
    if (path.dirname(admin) !== parent) return 'foreign'
    let backlink: string, ownDir: string
    try {
      backlink = (await fs.promises.readFile(path.join(admin, 'gitdir'), 'utf8')).replace(/\n$/, '')
      ownDir = await fs.promises.realpath(slot)
    }
    catch { return 'foreign' }
    return backlink === path.join(ownDir, '.git') ? 'valid' : 'foreign'
  }
  const listed = await gitSetup(repoDir, ['worktree', 'list', '--porcelain'])
  const same = async (other: string) => {
    try { return await fs.promises.realpath(other) === await fs.promises.realpath(slot) }
    catch { return false }
  }
  for (const line of listed.split(/\n/)) {
    if (line.startsWith('worktree ') && await same(line.slice(9))) return 'missing-git'
  }
  return 'unregistered'
}

/** Git worktree lock prevents Git pruning; OS locks provide exclusive use. */
async function lockPreviewEntry(repoDir: string, entry: string): Promise<void> {
  try { await gitSetup(repoDir, ['worktree', 'lock', '--reason', 'room preview cache', entry]) }
  catch (error) {
    if (await slotRegistration(repoDir, entry) !== 'valid') throw error
    const gitfile = await fs.promises.readFile(path.join(entry, '.git'), 'utf8')
    const match = /^gitdir: (.+)\s*$/m.exec(gitfile)
    if (!match || !await fs.promises.stat(path.join(path.resolve(entry, match[1]), 'locked')).catch(() => undefined)) throw error
  }
}

const warnedEntries = new Set<string>()
function warnEntry(entry: string, reason: string): void {
  if (warnedEntries.has(entry)) return
  warnedEntries.add(entry)
  console.warn(`room preview: leaving ${entry}: ${reason}`)
}

/** Remove a registered worktree through Git; a failed first checkout may have only a partial directory. */
async function removePreviewEntry(repoDir: string, entry: string, partial = false): Promise<boolean> {
  const root = path.join(await fs.promises.realpath(await gitCommonDir(repoDir)), 'room-preview')
  const relative = path.relative(root, entry)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe preview cache path')
  await rejectPreviewLink(root)
  await rejectPreviewLink(path.dirname(entry))
  try {
    const state = await slotRegistration(repoDir, entry)
    if (state === 'valid') {
      try { await gitSetup(repoDir, ['worktree', 'unlock', entry]) }
      catch { if (await slotRegistration(repoDir, entry) !== 'valid') throw new Error('registration changed during unlock') }
      if (await slotRegistration(repoDir, entry) !== 'valid') throw new Error('registration changed before removal')
      await gitSetup(repoDir, ['worktree', 'remove', '--force', entry])
      await gitSetup(repoDir, ['worktree', 'prune'])
    } else if (state === 'unregistered' && partial) {
      const stat = await fs.promises.lstat(entry).catch(() => undefined)
      if (stat?.isSymbolicLink()) throw new Error('unsafe preview cache link')
      if (stat) await fs.promises.rm(entry, { recursive: true, force: true })
    } else {
      warnEntry(entry, `registration is ${state}; manual inspection required`)
      return false
    }
    await fs.promises.rm(slotSettingsFile(entry), { force: true })
    await fs.promises.rm(`${entry}.meta.json`, { force: true })
    return true
  } catch (error) {
    warnEntry(entry, error instanceof Error ? error.message : String(error))
    return false
  }
}

/** Old claim files are evidence of another reclaimer; leave uncertain/live owners alone. */
async function legacyClaimDead(slot: string): Promise<boolean> {
  let claim: { pid?: unknown; start?: unknown }
  try {
    const stat = await fs.promises.lstat(`${slot}.claim`)
    if (!stat.isFile()) return false
    claim = JSON.parse(await fs.promises.readFile(`${slot}.claim`, 'utf8')) as typeof claim
  }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
  if (!Number.isSafeInteger(claim.pid) || typeof claim.start !== 'string') return false
  return isDeadSlot(`${claim.pid}-${encodeURIComponent(claim.start)}`)
}

const previewMigrations = new Set<Promise<void>>()
const previewEvictions = new Set<Promise<void>>()

/** Earlier 0.17 process slots are removed only after both slot and claim owners die. */
async function migrateLegacySlots(cloneDir: string, repoDir = cloneDir): Promise<void> {
  const base = path.dirname(await previewKeyPath(cloneDir, repoDir))
  const roots = (await fs.promises.readdir(base).catch(() => [] as string[]))
    .filter(name => /^[a-f0-9]{20}(?:\.slots)?$/.test(name)).map(name => path.join(base, name))
  for (const root of roots) {
    await rejectPreviewLink(root)
    if (await isLegacyTree(root)) continue
    for (const name of await fs.promises.readdir(root).catch(() => [] as string[])) {
      if (/\.(?:lock|meta\.json|claim|settings.*)$/.test(name)) continue
      const slot = path.join(root, name)
      if (!(await fs.promises.lstat(slot).catch(() => undefined))?.isDirectory()) continue
      if (!slotOwner(name) || !await isDeadSlot(name)) continue
      if (!await legacyClaimDead(slot)) continue
      const release = await tryPreviewLock(slot).catch(() => undefined)
      if (!release) continue
      try {
        if (!await isDeadSlot(name) || !await legacyClaimDead(slot)) continue
        if (await removePreviewEntry(repoDir, slot)) await fs.promises.rm(`${slot}.claim`, { force: true })
      } finally { await release() }
    }
  }
}

/** Worker cleanup starts migration without waiting on a directory scan. */
export async function removePreviewCache(cloneDir: string, repoDir = cloneDir): Promise<void> {
  const migration = migrateLegacySlots(cloneDir, repoDir).catch(error => console.warn('room preview migration:', error))
  previewMigrations.add(migration)
  void migration.finally(() => previewMigrations.delete(migration))
}

export async function waitForPreviewSweepForTests(): Promise<void> {
  for (let n = 0; n < 1000; n++) {
    if (!previewMigrations.size && !previewEvictions.size) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('preview cache maintenance did not finish')
}

/** Prepare one shared fingerprint entry. Migration never adopts a previous process's slot. */
async function preparePreviewEntry(cloneDir: string, entry: string): Promise<void> {
  const root = path.dirname(entry)
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 })
  await rejectPreviewLink(root)
  await fs.promises.writeFile(path.join(root, 'clone.json'), JSON.stringify({ path: canonicalPreviewClonePath(cloneDir) }))
  await migrateLegacySlots(cloneDir)
}

async function resetPreviewTree(repoDir: string, dir: string, ancestor: string): Promise<void> {
  if (await slotRegistration(repoDir, dir) !== 'valid') throw new Error('preview slot registration is not reciprocal before reset')
  await gitSetup(dir, ['reset', '--hard', '--quiet', ancestor])
  // -fd removes test-created untracked paths. Ignored build caches (target/, etc.) remain warm.
  if (await slotRegistration(repoDir, dir) !== 'valid') throw new Error('preview slot registration is not reciprocal before clean')
  await gitSetup(dir, ['clean', '-fd', '-q'])
}

async function preparePreviewCache(cloneDir: string, dir: string, ancestor: string, source: Awaited<ReturnType<typeof checkoutSettings>>, observe?: { baseMaterialized?(): void }): Promise<boolean> {
  let stat: fs.Stats | undefined
  try { stat = await fs.promises.lstat(dir) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (stat?.isSymbolicLink()) throw new Error('unsafe preview cache link')
  if (stat) {
    const registration = await slotRegistration(cloneDir, dir)
    if (registration === 'foreign') throw new Error('preview slot registration points outside this slot')
    // A killed first checkout can leave a partial directory.
    if (registration === 'valid') {
      const top = (await gitSetup(dir, ['rev-parse', '--show-toplevel'])).trim()
      if (path.resolve(top) !== dir) throw new Error('preview cache is not its own worktree')
    } else {
      if (!await removePreviewEntry(cloneDir, dir, true)) throw new Error('preview cache is malformed and could not be safely removed')
      stat = undefined
    }
  }
  if (!stat) {
    observe?.baseMaterialized?.()
    await gitSetup(cloneDir, ['worktree', 'add', '--detach', '--quiet', dir, ancestor])
  }
  if (await slotRegistration(cloneDir, dir) !== 'valid') throw new Error('preview slot registration is not reciprocal')
  await lockPreviewEntry(cloneDir, dir)
  const slotSettings = await checkoutSettings(dir)
  if (slotSettings.sparse) throw new Error('preview slot uses sparse checkout')
  const saved = await fs.promises.readFile(slotSettingsFile(dir), 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (saved !== undefined && saved !== source.fingerprint) throw new Error('preview checkout settings changed')
  if (slotSettings.fingerprint !== source.fingerprint) throw new Error('preview checkout settings differ from source')
  // Also recovers changes left by a crashed or killed preview before applying this one.
  await resetPreviewTree(cloneDir, dir, ancestor)
  if (saved === undefined) await fs.promises.writeFile(slotSettingsFile(dir), source.fingerprint, { flag: 'wx', mode: 0o600 })
  return !!stat
}

/** Run against a whole ancestor tree with only merged paths changed. A slot is exclusive within this process. */
export async function runInMergedTree(s: Session, ancestor: string, merged: Map<string, string | null>, cmd: string, modes: ReadonlyMap<string, number> = new Map(), observe?: { baseMaterialized?(): void; mergedWrite?(path: string): void }): Promise<TestResult> {
  return previewProcesses.run({}, () => runInMergedTreeAttempt(s, ancestor, merged, cmd, modes, observe))
}

async function runInMergedTreeAttempt(s: Session, ancestor: string, merged: Map<string, string | null>, cmd: string, modes: ReadonlyMap<string, number>, observe: { baseMaterialized?(): void; mergedWrite?(path: string): void } | undefined): Promise<TestResult> {
  let dir: string | undefined
  let release: (() => Promise<void>) | undefined
  let cached = false
  let reused = false
  let cacheReady = false
  let setupMs = 0
  let checkMs = 0
  let cacheFailure = false
  let completed: TestResult | undefined
  let stage: 'setup' | 'check' = 'setup'
  const setupStart = performance.now()
  try {
    await previewPhase('setup', async () => {
      let cache: string | undefined
      let source: Awaited<ReturnType<typeof checkoutSettings>> | undefined
      try {
        source = await checkoutSettings(s.dir)
        if (!source.sparse) cache = await previewCachePath(s.dir)
      } catch { /* Uncertain checkout policy or identity uses a fresh tree. */ }
      if (cache && previewCapBytes() > 0) {
        const unlock = await tryPreviewLock(cache).catch(() => undefined)
        if (unlock) {
          release = unlock
          previewProcesses.getStore()!.lock = unlock
        }
      }
      cached = !!release
      if (cached) {
        dir = cache!
        try {
          await preparePreviewEntry(s.dir, dir)
          reused = await preparePreviewCache(s.dir, dir, ancestor, source!, observe)
          cacheReady = true
        } catch (error) {
          await removePreviewEntry(s.dir, dir, true)
          console.warn(`room preview: abandoning ${dir}: ${error instanceof Error ? error.message : String(error)}`)
          cached = false
          cacheFailure = true
          dir = undefined // A failed scratch allocation must not clean the abandoned slot.
        }
      }
      if (!cached) {
        dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'room-merge-'))
        dir = await fs.promises.realpath(dir)
        observe?.baseMaterialized?.()
        await materializeGitTree(s.dir, ancestor, dir)
      }
      for (const [rel, value] of merged) {
        await new Promise<void>(resolve => setImmediate(resolve))
        materializeMergedFile(dir!, rel, value === null ? null : Buffer.from(value, 'latin1'), modes.get(rel) ?? 0o644)
        observe?.mergedWrite?.(rel)
      }
      await linkSharedDirs(s.dir, dir!)
    })
    setupMs = performance.now() - setupStart
    stage = 'check'
    const bash = ['/bin/bash', '/usr/bin/bash'].find(candidate => fs.existsSync(candidate))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ROOM_')))
    env.ROOM_MERGED_TREE = dir!
    const checkStart = performance.now()
    const result = await previewCheck(async () => {
      const command = bash ?? 'sh'
      const args = bash ? ['-o', 'pipefail', '-c', cmd] : ['-c', cmd]
      // Windows has no process groups to signal (and never caches): its check keeps execFile's own deadline.
      if (process.platform === 'win32') return new Promise<{ code: number; out: string; stopped: boolean }>(resolve => {
        execFile(command, args, { cwd: dir!, timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) => {
          const raw = err ? (err as { code?: unknown }).code : 0
          resolve({ code: typeof raw === 'number' ? raw : err ? 1 : 0, out: `${stdout}${stderr}`, stopped: false })
        })
      })
      const tracked = await runTrackedProcess(command, args, dir!, 5 * 60_000, 4 * 1024 * 1024, previewProcesses.getStore()?.lock, env)
      return { code: tracked.code, out: tracked.stdout + tracked.stderr, stopped: tracked.stopped }
    })
    checkMs = performance.now() - checkStart
    completed = await previewPhase('collect', () => {
      const tail = stripVTControlCharacters(result.out).trim().split('\n').slice(-25).join('\n')
      const verdict = testVerdict(result.out, result.code)
      return { passed: verdict.passed, text: `ran "${cmd}" in the merged tree (${merged.size} file(s) applied over ${ancestor.slice(0, 10)}): exit ${result.code}; setup ${Math.round(setupMs)}ms (${reused ? 'cached base' : cacheFailure ? 'fresh base after cache failure' : 'fresh base'}), check ${Math.round(checkMs)}ms\n${tail}\n${verdict.text}${result.stopped ? '\nstopped leftover processes from the check' : ''}` }
    })
    return completed
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { passed: false, text: stage === 'setup' ? `merged-tree setup failed after ${Math.round(performance.now() - setupStart)}ms: ${detail}; check was not run` : `merged-tree check failed: ${detail}` }
  } finally {
    try {
      if (dir) {
        if (cached && cacheReady) {
          try { await resetPreviewTree(s.dir, dir, ancestor) }
          catch (error) {
            await removePreviewEntry(s.dir, dir, true)
            cacheReady = false
            console.warn(`room preview: abandoning ${dir}: ${error instanceof Error ? error.message : String(error)}`)
            if (completed) completed.text += '\nwarning: preview cache abandoned after the check; next preview uses a new cache'
          }
        }
        else if (!cached) await fs.promises.rm(dir, { recursive: true, force: true })
        if (cached && cacheReady) await touchPreview(dir, previewCapBytes())
      }
    } catch (error) {
      console.warn(`room preview cleanup: ${error instanceof Error ? error.message : String(error)}`)
      if (completed) completed.text += '\nwarning: preview cache abandoned after the check; next preview uses a new cache'
    } finally {
      await release?.()
      if (release) previewProcesses.getStore()!.lock = undefined
      // Maintenance never delays the preview reply and is bounded per pass.
      if (cached || previewCapBytes() === 0) {
        const key = await previewKeyPath(s.dir).catch(() => undefined)
        if (key) {
          const eviction = evictPreviewLru(path.dirname(key), previewCapBytes(), async (entry, used) => {
            const unlock = await tryPreviewLock(entry)
            if (!unlock) return false
            try {
              let currentUsed = 0
              try {
                const read = (JSON.parse(await fs.promises.readFile(`${entry}.meta.json`, 'utf8')) as { used: number }).used
                if (Number.isFinite(read)) currentUsed = read
              }
              catch { /* Missing or malformed metadata was ranked oldest. */ }
              return currentUsed === used && await slotRegistration(s.dir, entry) === 'valid' && await removePreviewEntry(s.dir, entry)
            } catch { return false }
            finally { await unlock() }
          }).catch(error => console.warn('room preview eviction:', error))
          previewEvictions.add(eviction)
          void eviction.finally(() => previewEvictions.delete(eviction))
        }
      }
    }
  }
}

/** Materialize the committed checkout through a private index, without worktree registration. */
export async function materializeGitTree(cloneDir: string, ref: string, destination: string): Promise<void> {
  if (!/^[0-9a-f]{40,64}$/i.test(ref)) throw new Error(`invalid merge ancestor: ${JSON.stringify(ref)}`)
  const index = path.join(destination, `.room-preview-index-${randomUUID()}`)
  const env = { ...process.env, GIT_INDEX_FILE: index }
  const deadline = performance.now() + SETUP_TIMEOUT_MS
  const run = (args: string[]) => new Promise<void>((resolve, reject) => {
    const remaining = Math.max(1, Math.ceil(deadline - performance.now()))
    execFile('git', ['-C', cloneDir, '-c', 'core.sparseCheckout=false', '-c', 'core.sparseCheckoutCone=false', ...args], { env, timeout: remaining, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`could not materialize ${ref.slice(0, 10)} (git ${args[0]}: ${String(stderr || error.message).trim()})`))
      else resolve()
    })
  })
  try {
    await run(['cat-file', '-e', `${ref}^{commit}`])
    await run(['read-tree', ref])
    await run([`--work-tree=${destination}`, 'checkout-index', '-a', '-f'])
  } finally {
    await fs.promises.rm(index, { force: true })
  }
}
