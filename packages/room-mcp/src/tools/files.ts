import { git, gitCommitMissing, gitWholeTree, isGitTimeout } from '@room/roomd/git'
import { ensureCommit, gitCommonDir, roomRemote } from '@room/roomd'
import { createTwoFilesPatch, diffLines } from 'diff'
import { execFile } from 'node:child_process'
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
import { parsePsLstartUtc, pidAlive } from '@room/relay/process'
import { trustedWorker, WORKTREE_NOTE, RO, RW, int, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'

export const defs: ToolDef[] = [
  { name: 'room_read', annotations: RO, description: 'Read a live file with claims and history. diff=true compares to base; omit path for all diffs.',
    inputSchema: { type: 'object', properties: { path: str('repo-relative path'), person: str('default you'), diff: { type: 'boolean' } } } },
  { name: 'room_impact', annotations: RO, description: 'Find symbol consumers or file dependencies before changing an interface.',
    inputSchema: { type: 'object', properties: { symbol: str('function/class/variable name'), path: str('repo-relative path') } } },
  { name: 'room_preview_merge', annotations: RO, description: 'Preview combined live changes without editing clones. Optionally run tests in the combined scratch tree.',
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

/** Private per-process worktree slots live beneath a clone-key directory. */
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
const gitSetup = (dir: string, args: string[]) => git(dir, args, SETUP_TIMEOUT_MS)
const PROBE_TIMEOUT_MS = 3000
let ownStartPromise: Promise<string | undefined> | undefined
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

function ownPreviewStart(): Promise<string | undefined> {
  // A private marker still distinguishes our own slot when the host hides ps/sysctl.
  // Other processes treat that marker as uncertain while its PID lives.
  return ownStartPromise ??= probePreviewStart(process.pid).then(start => start ?? `opaque:${randomUUID()}`)
}

const ownSlotGenerations = new Map<string, number>()
function slotName(pid: number, start: string, generation: number): string { return `${pid}-${encodeURIComponent(start)}-${generation}` }
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

/** Legacy clients can reacquire their tree at any time; slots always use its sidecar. */
async function slotRoot(key: string): Promise<string> {
  await rejectPreviewLink(key)
  if (await isLegacyTree(key)) { await rejectPreviewLink(`${key}.slots`); return `${key}.slots` }
  try { await rejectPreviewLink(`${key}.slots`); await fs.promises.lstat(`${key}.slots`); return `${key}.slots` }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return key
}

export async function previewCachePath(cloneDir: string, repoDir = cloneDir): Promise<string> {
  const start = await ownPreviewStart()
  if (!start) throw new Error('preview process identity is unavailable')
  const key = await previewKeyPath(cloneDir, repoDir)
  return path.join(await slotRoot(key), slotName(process.pid, start, ownSlotGenerations.get(key) ?? 0))
}

function abandonPreviewSlot(cloneDir: string, slot: string): void {
  const key = path.dirname(slot).endsWith('.slots') ? path.dirname(slot).slice(0, -6) : path.dirname(slot)
  ownSlotGenerations.set(key, (ownSlotGenerations.get(key) ?? 0) + 1)
  abandonedOwnSlots.set(slot, cloneDir)
}

const checkoutConfigKeys = new Set(['core.autocrlf', 'core.eol', 'core.safecrlf', 'core.symlinks', 'core.filemode', 'core.ignorecase', 'core.precomposeunicode'])
async function checkoutSettings(dir: string): Promise<{ fingerprint: string; sparse: boolean; attributes: Buffer }> {
  const output = await gitSetup(dir, ['config', '--null', '--list'])
  const values = new Map<string, string>()
  for (const entry of output.split('\0')) {
    const separator = entry.indexOf('\n')
    if (separator >= 0) values.set(entry.slice(0, separator).toLowerCase(), entry.slice(separator + 1))
  }
  const admin = (await gitSetup(dir, ['rev-parse', '--absolute-git-dir'])).trim()
  const sparseFile = path.join(admin, 'info', 'sparse-checkout')
  const sparse = /^(true|yes|on|1)$/i.test(values.get('core.sparsecheckout') ?? '')
    || await fs.promises.access(sparseFile).then(() => true, () => false)
  const attributes = await fs.promises.readFile(path.join(admin, 'info', 'attributes')).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0)
    throw error
  })
  const relevant = [...values].filter(([key]) => checkoutConfigKeys.has(key) || /^filter\..+\.(smudge|clean|process|required)$/.test(key)).sort(([a], [b]) => a.localeCompare(b))
  const fingerprint = createHash('sha256').update(JSON.stringify(relevant)).update('\0').update(attributes).digest('hex')
  return { fingerprint, sparse, attributes }
}

function slotSettingsFile(slot: string): string { return path.join(path.dirname(slot), `.checkout-${path.basename(slot)}.json`) }

type SlotRegistration = 'valid' | 'missing-git' | 'unregistered' | 'foreign'

/** The link publishes the entire token at once. No process ever steals a stale claim. */
async function claimPreviewSlot(slot: string): Promise<(() => Promise<void>) | undefined> {
  const claim = `${slot}.claim`
  const temporary = `${claim}.${randomUUID()}.tmp`
  const token = JSON.stringify({ pid: process.pid, start: await ownPreviewStart(), nonce: randomUUID() })
  await fs.promises.writeFile(temporary, token, { flag: 'wx', mode: 0o600 })
  try {
    try { await fs.promises.link(temporary, claim) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined
      throw error
    }
  } finally { await fs.promises.rm(temporary, { force: true }) }
  return async () => {
    try {
      if (await fs.promises.readFile(claim, 'utf8') === token) await fs.promises.unlink(claim)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}

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

/** A missing .git may be rebuilt only from a registration pointing at this exact slot. */
async function registeredAdmin(repoDir: string, slot: string): Promise<string | undefined> {
  const parent = path.join(await fs.promises.realpath(await gitCommonDir(repoDir)), 'worktrees')
  const own = await fs.promises.realpath(slot)
  const names = await fs.promises.readdir(parent).catch(() => [] as string[])
  let found: string | undefined
  for (const name of names) {
    const admin = path.join(parent, name)
    try {
      const link = (await fs.promises.readFile(path.join(admin, 'gitdir'), 'utf8')).trim()
      if (path.basename(link) === '.git' && await fs.promises.realpath(path.dirname(link)) === own) {
        if (found) return undefined // Multiple registrations for one path are ambiguous.
        found = admin
      }
    } catch { /* An unrelated or broken registration is not authority. */ }
  }
  return found
}

async function lockPreviewSlot(repoDir: string, slot: string): Promise<void> {
  try { await gitSetup(repoDir, ['worktree', 'lock', '--reason', 'room preview slot', slot]) }
  catch (error) {
    if (await slotRegistration(repoDir, slot) !== 'valid') throw error
    const gitfile = await fs.promises.readFile(path.join(slot, '.git'), 'utf8')
    const match = /^gitdir: (.+)\s*$/m.exec(gitfile)
    if (!match || !await fs.promises.stat(path.join(path.resolve(slot, match[1]), 'locked')).catch(() => undefined)) throw error
  }
}

const warnedSlots = new Set<string>()
function warnSlot(slot: string, reason: string): void {
  if (warnedSlots.has(slot)) return
  warnedSlots.add(slot)
  console.warn(`room preview: leaving ${slot}: ${reason}`)
}

/** Git removes registrations by their original slot path; no admin path is ever deleted directly. */
async function deletePreviewSlot(repoDir: string, slot: string, retryOwnFailure = false): Promise<boolean> {
  const release = await claimPreviewSlot(slot)
  if (!release) return false
  let complete = false
  try {
    const state = await slotRegistration(repoDir, slot)
    if (state === 'foreign') {
      warnSlot(slot, 'registration pointer does not point back to this slot; manual inspection required')
      return false
    }
    if (state === 'missing-git') {
      const admin = await registeredAdmin(repoDir, slot)
      if (!admin) throw new Error('missing .git has no reciprocal registration')
      await fs.promises.writeFile(path.join(slot, '.git'), `gitdir: ${admin}\n`, { flag: 'wx' })
      if (await slotRegistration(repoDir, slot) !== 'valid') throw new Error('rebuilt .git is not reciprocal')
      await gitSetup(repoDir, ['worktree', 'repair', slot])
      if (await slotRegistration(repoDir, slot) !== 'valid') throw new Error('repair did not restore reciprocal registration')
    }
    if (state === 'valid' || state === 'missing-git') {
      if (await slotRegistration(repoDir, slot) !== 'valid') throw new Error('registration changed before unlock')
      try { await gitSetup(repoDir, ['worktree', 'unlock', slot]) }
      catch {
        if (await slotRegistration(repoDir, slot) !== 'valid') throw new Error('registration changed during unlock')
      }
      if (await slotRegistration(repoDir, slot) !== 'valid') throw new Error('registration changed before removal')
      await gitSetup(repoDir, ['worktree', 'remove', '--force', slot])
    } else {
      const stat = await fs.promises.lstat(slot).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (stat?.isSymbolicLink()) throw new Error('unsafe preview slot link')
      await fs.promises.rm(slot, { recursive: true, force: true })
    }
    complete = true
    await fs.promises.rm(slotSettingsFile(slot), { force: true })
    return true
  } catch (error) {
    warnSlot(slot, error instanceof Error ? error.message : String(error))
    return false
  } finally {
    if (complete || retryOwnFailure) await release()
  }
}

/** Only this process may reclaim its superseded generations while its PID is live. */
const abandonedOwnSlots = new Map<string, string>()
let ownCleanup = Promise.resolve()
function queueOwnAbandonedCleanup(): void {
  ownCleanup = ownCleanup.then(async () => {
    await new Promise<void>(resolve => setImmediate(resolve))
    for (const [slot, repoDir] of [...abandonedOwnSlots].slice(0, 2)) {
      if (previewSlotTurns.has(slot)) continue
      abandonedOwnSlots.delete(slot)
      // The clone can disappear during worker collection. No slot remains to reclaim.
      if (!await fs.promises.access(path.dirname(slot)).then(() => true, () => false)) continue
      try {
        if (!await deletePreviewSlot(repoDir, slot, true)) abandonedOwnSlots.set(slot, repoDir)
      } catch (error) {
        console.warn(`room preview own-slot cleanup: ${error instanceof Error ? error.message : String(error)}`)
        abandonedOwnSlots.set(slot, repoDir)
      }
    }
  }).catch(error => { console.warn('room preview own-slot cleanup:', error) })
}

const PREVIEW_SWEEP_LIMIT = 4
const PREVIEW_PROBE_LIMIT = 8
const PREVIEW_SCAN_LIMIT = 64
const PREVIEW_KEY_SCAN_LIMIT = 16
const PREVIEW_SWEEP_MS = 2000
type SweepCandidate = { slot: string; key: string; retainSpare: boolean }
type SweepState = { running: boolean; pending: boolean; preferred: Set<string>; queue: SweepCandidate[]; keyCursor: number; entryCursor: Map<string, number> }
const previewSweeps = new Map<string, SweepState>()

/** One bounded pass. A gathered queue is drained before source slices rotate again. */
async function sweepPreviewCache(repoDir: string, base: string, state: SweepState): Promise<void> {
  const began = performance.now()
  if (!state.queue.length) {
    const preferred = new Set(state.preferred)
    state.preferred.clear()
    const names = await fs.promises.readdir(base).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]
      throw error
    })
    const keys = [...new Set(names.filter(name => /^[a-f0-9]{20}(?:\.slots)?$/.test(name)).map(name => name.slice(0, 20)))].sort()
    const candidates: SweepCandidate[] = []
    const keyStart = keys.length ? state.keyCursor % keys.length : 0
    let scannedKeys = 0
    let scannedSlots = 0
    for (const keyName of [...keys.slice(keyStart), ...keys.slice(0, keyStart)]) {
      if (performance.now() - began >= PREVIEW_SWEEP_MS || scannedSlots >= PREVIEW_SCAN_LIMIT) break
      scannedKeys++
      const key = path.join(base, keyName)
      const entries: { slot: string; mtime: number }[] = []
      let clone: string | undefined
      let keySlots = 0
      for (const root of [key, `${key}.slots`]) {
        if (performance.now() - began >= PREVIEW_SWEEP_MS || scannedSlots >= PREVIEW_SCAN_LIMIT || keySlots >= PREVIEW_KEY_SCAN_LIMIT) break
        await rejectPreviewLink(root)
        if (await isLegacyTree(root)) continue
        const children = await fs.promises.readdir(root).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]
          throw error
        })
        try {
          const parsed = JSON.parse(await fs.promises.readFile(path.join(root, 'clone.json'), 'utf8')) as { path?: unknown }
          if (typeof parsed.path === 'string' && path.isAbsolute(parsed.path)) clone = parsed.path
        } catch { /* Old caches have no metadata. */ }
        const start = children.length ? (state.entryCursor.get(root) ?? 0) % children.length : 0
        let scannedHere = 0
        let rootSlots = 0
        for (const name of [...children.slice(start), ...children.slice(0, start)]) {
          if (performance.now() - began >= PREVIEW_SWEEP_MS || scannedSlots >= PREVIEW_SCAN_LIMIT || keySlots >= PREVIEW_KEY_SCAN_LIMIT || rootSlots >= PREVIEW_KEY_SCAN_LIMIT / 2) break
          scannedHere++
          if (!slotOwner(name)) continue
          scannedSlots++
          keySlots++
          rootSlots++
          const slot = path.join(root, name)
          const stat = await fs.promises.lstat(slot).catch(() => undefined)
          if (stat?.isDirectory()) entries.push({ slot, mtime: stat.mtimeMs })
        }
        if (children.length) state.entryCursor.set(root, (start + scannedHere) % children.length)
      }
      entries.sort((a, b) => b.mtime - a.mtime)
      const vanished = clone !== undefined && !await fs.promises.access(clone).then(() => true, () => false)
      candidates.push(...entries.map(entry => ({ slot: entry.slot, key, retainSpare: !vanished && !preferred.has(key) })))
      preferred.delete(key)
    }
    for (const key of preferred) state.preferred.add(key)
    if (keys.length) state.keyCursor = (keyStart + scannedKeys) % keys.length
    state.queue.push(...candidates)
  }
  if (!state.queue.length) return
  let probes = 0, removed = 0
  const spared = new Set<string>()
  while (state.queue.length && probes < PREVIEW_PROBE_LIMIT && removed < PREVIEW_SWEEP_LIMIT && performance.now() - began < PREVIEW_SWEEP_MS) {
    const { slot, key, retainSpare } = state.queue.shift()!
    probes++
    const remaining = PREVIEW_SWEEP_MS - (performance.now() - began)
    let deadline: NodeJS.Timeout | undefined
    const dead = await Promise.race([
      isDeadSlot(path.basename(slot)),
      new Promise<false>(resolve => { deadline = setTimeout(() => resolve(false), Math.max(1, remaining)) }),
    ]).finally(() => { if (deadline) clearTimeout(deadline) })
    if (!dead) continue
    if (retainSpare && !state.preferred.has(key) && !spared.has(key) && await slotRegistration(repoDir, slot) === 'valid') {
      spared.add(key)
      continue
    }
    if (await deletePreviewSlot(repoDir, slot)) removed++
  }
}

/** Requests during a pass collapse into one follow-up pass for this common directory. */
function queuePreviewSweep(repoDir: string, base: string, preferred?: string): void {
  let state = previewSweeps.get(base)
  if (!state) {
    state = { running: false, pending: false, preferred: new Set(), queue: [], keyCursor: 0, entryCursor: new Map() }
    previewSweeps.set(base, state)
  }
  if (preferred) state.preferred.add(preferred)
  if (state.running) { state.pending = true; return }
  state.running = true
  setImmediate(() => {
    void (async () => {
      do {
        state!.pending = false
        try { await sweepPreviewCache(repoDir, base, state!) }
        catch (error) { console.warn('room preview sweep:', error) }
      } while (state!.pending)
      state!.running = false
    })()
  })
}

/** Worker cleanup schedules maintenance without waiting for a common-directory scan. */
export async function removePreviewCache(cloneDir: string, repoDir = cloneDir): Promise<void> {
  const key = await previewKeyPath(cloneDir, repoDir)
  queuePreviewSweep(repoDir, path.dirname(key), key)
}

/** Test seam for observing asynchronous maintenance without making worker cleanup wait. */
export async function waitForPreviewSweepForTests(): Promise<void> {
  for (let n = 0; n < 1000; n++) {
    await ownCleanup
    if (![...previewSweeps.values()].some(state => state.running)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('preview sweep did not finish')
}

const previewSlotTurns = new Map<string, Promise<void>>()

/** Adopt only a dead, reciprocally registered checkout whose claim we own. */
async function preparePreviewSlot(cloneDir: string, slot: string): Promise<void> {
  const key = await previewKeyPath(cloneDir)
  const root = path.dirname(slot)
  await fs.promises.mkdir(root === key ? path.dirname(key) : root, { recursive: true, mode: 0o700 })
  await rejectPreviewLink(root)
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 })
  await fs.promises.writeFile(path.join(root, 'clone.json'), JSON.stringify({ path: canonicalPreviewClonePath(cloneDir) }))
  try { await fs.promises.lstat(slot); return }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  for (const name of await fs.promises.readdir(root)) {
    if (name === path.basename(slot) || !slotOwner(name)) continue
    const old = path.join(root, name)
    if (!await isDeadSlot(name)) continue
    const oldStat = await fs.promises.lstat(old).catch(() => undefined)
    if (!oldStat?.isDirectory()) continue
    const release = await claimPreviewSlot(old)
    if (!release) continue
    let complete = false
    try {
      const registration = await slotRegistration(cloneDir, old)
      if (registration !== 'valid') {
        if (registration === 'foreign') {
          warnSlot(old, 'registration pointer does not point back to this slot; manual inspection required')
          continue
        }
        complete = true // Incomplete slots are swept; they cannot block a fresh preview.
        continue
      }
      await lockPreviewSlot(cloneDir, old) // Protect the registration during the rename/repair gap.
      if (!await isDeadSlot(name)) { complete = true; continue }
      try { await fs.promises.rename(old, slot) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { complete = true; continue }
        throw error
      }
      await gitSetup(cloneDir, ['worktree', 'repair', slot])
      if (await slotRegistration(cloneDir, slot) !== 'valid') throw new Error('adopted slot registration is not reciprocal')
      await lockPreviewSlot(cloneDir, slot)
      try { await fs.promises.rename(slotSettingsFile(old), slotSettingsFile(slot)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      complete = true
      return
    } finally {
      if (complete) await release()
    }
  }
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
      if (!await deletePreviewSlot(cloneDir, dir)) throw new Error('preview cache is malformed and could not be safely removed')
      stat = undefined
    }
  }
  if (!stat) {
    observe?.baseMaterialized?.()
    await gitSetup(cloneDir, ['worktree', 'add', '--detach', '--quiet', dir, ancestor])
    // info/attributes belongs to each worktree's admin directory. Mirror the
    // source's checkout policy only inside our new worktree, never in the repo.
    const admin = (await gitSetup(dir, ['rev-parse', '--absolute-git-dir'])).trim()
    if (source.attributes.length) {
      await fs.promises.mkdir(path.join(admin, 'info'), { recursive: true })
      await fs.promises.writeFile(path.join(admin, 'info', 'attributes'), source.attributes)
      await gitSetup(dir, ['checkout-index', '-a', '-f'])
    }
  }
  if (await slotRegistration(cloneDir, dir) !== 'valid') throw new Error('preview slot registration is not reciprocal')
  await lockPreviewSlot(cloneDir, dir)
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
  return runInMergedTreeAttempt(s, ancestor, merged, cmd, modes, observe)
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
      if (cache && !previewSlotTurns.has(cache)) {
        let finish!: () => void
        const turn = new Promise<void>(resolve => { finish = resolve })
        previewSlotTurns.set(cache, turn)
        release = async () => {
          if (previewSlotTurns.get(cache!) === turn) previewSlotTurns.delete(cache!)
          finish()
        }
      }
      cached = !!release
      if (cached) {
        dir = cache!
        try {
          await preparePreviewSlot(s.dir, dir)
          reused = await preparePreviewCache(s.dir, dir, ancestor, source!, observe)
          cacheReady = true
        } catch (error) {
          abandonPreviewSlot(s.dir, dir)
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
    const result = await previewCheck(() => new Promise<{ code: number | null; out: string }>(resolve => {
      execFile(bash ?? 'sh', bash ? ['-o', 'pipefail', '-c', cmd] : ['-c', cmd], { cwd: dir!, timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) => {
        const raw = err ? (err as { code?: unknown }).code : 0
        resolve({ code: typeof raw === 'number' ? raw : err ? 1 : 0, out: `${stdout}${stderr}` })
      })
    }))
    checkMs = performance.now() - checkStart
    completed = await previewPhase('collect', () => {
      const tail = stripVTControlCharacters(result.out).trim().split('\n').slice(-25).join('\n')
      const verdict = testVerdict(result.out, result.code)
      return { passed: verdict.passed, text: `ran "${cmd}" in the merged tree (${merged.size} file(s) applied over ${ancestor.slice(0, 10)}): exit ${result.code}; setup ${Math.round(setupMs)}ms (${reused ? 'cached base' : cacheFailure ? 'fresh base after cache failure' : 'fresh base'}), check ${Math.round(checkMs)}ms\n${tail}\n${verdict.text}` }
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
            abandonPreviewSlot(s.dir, dir)
            console.warn(`room preview: abandoning ${dir}: ${error instanceof Error ? error.message : String(error)}`)
            if (completed) completed.text += '\nwarning: preview cache abandoned after the check; next preview uses a new cache'
          }
        }
        else await fs.promises.rm(dir, { recursive: true, force: true })
      }
    } catch (error) {
      console.warn(`room preview cleanup: ${error instanceof Error ? error.message : String(error)}`)
      if (completed) completed.text += '\nwarning: preview cache abandoned after the check; next preview uses a new cache'
    } finally {
      await release?.()
      if (abandonedOwnSlots.size) queueOwnAbandonedCleanup()
      // Maintenance never delays the preview reply and is bounded per pass.
      if (cached) {
        const key = await previewKeyPath(s.dir).catch(() => undefined)
        if (key) queuePreviewSweep(s.dir, path.dirname(key))
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
