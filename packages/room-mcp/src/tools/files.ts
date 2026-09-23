import { git } from '@room/roomd/git'
import { createTwoFilesPatch } from 'diff'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { describeClaim, withLineNumbers, type NoteMsg, type Worker } from '@room/shared'
import type { Session } from '../session.js'
import { carriedUnchangedPaths, workerBaseline } from '@room/roomd/baseline'
import { workerOwnedPaths } from '../workers.js'
import { buildCombinedTree } from './combined-tree.js'
import { diskWorker, WORKTREE_NOTE, RO, RW, int, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'

export const defs: ToolDef[] = [
  { name: 'room_read', annotations: RO, description: 'Read a live file with claims and history. diff=true compares to base; omit path for all diffs.',
    inputSchema: { type: 'object', properties: { path: str('repo-relative path'), person: str('default you'), diff: { type: 'boolean' } } } },
  { name: 'room_impact', annotations: RO, description: 'Find symbol consumers or file dependencies before changing an interface.',
    inputSchema: { type: 'object', properties: { symbol: str('function/class/variable name'), path: str('repo-relative path') } } },
  { name: 'room_preview_merge', annotations: RO, description: 'Preview combined live changes without editing clones. Optionally run tests in the combined scratch tree.',
    inputSchema: { type: 'object', properties: { people: strs('participants in merge order; default all'), person: str('one participant'), includeOffline: { type: 'boolean', description: 'include offline overlays' }, run: str('test command'), resolve: { type: 'boolean', description: 'resolve superset conflicts' } } } }
]

export function handlers(state: HandlerState): Record<string, Handler> {
  const { S, rooms, others, presences, withheld, liveText, lines, baseFor, ledgerLines, baseText, shareOf, describeUsers } = state
  const readDiff: Handler = async a => {
      const person = typeof a.person === 'string' && a.person ? a.person : S().me.name
      const s = rooms.holding(person, S())
      const worker = diskWorker(s, person)
      const label = (text: string) => worker ? `${WORKTREE_NOTE}\n${text}` : text
      const one = async (p: string) => {
        const l = await liveText(s, p, person)
        const b = (await baseText(s, p, worker ? person : undefined)) ?? ''
        const live = l === null ? '' : l ?? b
        return live === b ? '' : createTwoFilesPatch(`a/${p}`, `b/${p}`, b, live, 'base', person, { context: 3 })
      }
      const held = withheld(s, person, typeof a.path === 'string' && a.path ? a.path : undefined)
      if (held) return held
      if (typeof a.path === 'string' && a.path) return label((await one(a.path)) || `${a.path}: no difference between base and ${person}'s version`)
      const parts: string[] = []
      const paths = worker ? new Set([
        ...(await git(worker.dir, ['diff', '--name-only', '-z', baseFor(s, person), '--'])).split('\0'),
        ...(await git(worker.dir, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0'),
      ].filter(Boolean)) : s.room.changedPaths(person)
      for (const p of paths) { const d = await one(p); if (d) parts.push(d) }
      const level = shareOf(s, person)
      if (level === 'declared') parts.push(`(${person} shares declared paths only: changes outside their scope are not shared)`)
      return label(parts.length ? parts.join('\n') : `${person} has no uncommitted changes`)
  }
  const handlers: Record<string, Handler> = {
    async room_read(a) {
      if (a.diff === true) return readDiff(a)
      if (typeof a.path !== 'string' || !a.path) return 'error: path is required'
      const p = a.path
      const person = typeof a.person === 'string' && a.person ? a.person : S().me.name
      const s = rooms.holding(person, S()) // a local worker's overlay lives in the workers room, not the team room
      const held = withheld(s, person, p)
      if (held) return held
      const note = diskWorker(s, person) ? ` ${WORKTREE_NOTE}` : ''
      const t = await liveText(s, p, person)
      if (t === null) return `${p}: deleted by ${person} (uncommitted)${note}`
      if (t === undefined) return `error: ${p} exists neither at base nor in ${person}'s changes${note}`
      const out = [`${p} as ${person} sees it (${lines(t)} lines${s.room.text(p, person) !== undefined ? ', uncommitted edits' : diskWorker(s, person) ? ', worktree file' : ', unchanged'} on their HEAD ${baseFor(s, person).slice(0, 10)})${note}`]
      const who = s.room.whoChanged(p).filter(x => x !== person)
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
      const alias = typeof a.person === 'string' && a.person.trim() ? a.person.trim() : ''
      if (a.people !== undefined && !Array.isArray(a.people)) return 'error: people must be an array of names'
      if (Array.isArray(a.people) && a.people.some(p => typeof p !== 'string' || !p.trim())) return 'error: people must contain non-empty names'
      if (Array.isArray(a.people) && alias) return 'error: pass people or person, not both'
      if (a.includeOffline !== undefined && typeof a.includeOffline !== 'boolean') return 'error: includeOffline must be a boolean'
      const explicit = Array.isArray(a.people) || !!alias
      const allSessions = rooms.all()
      const presentSession = (person: string) => allSessions.find(s => presences(s).some(p => p.user.name === person))
      const present = Array.from(new Set(allSessions.flatMap(s => presences(s).map(p => p.user.name)))).filter(p => p !== caller.me.name)
      const available = Array.from(new Set(allSessions.flatMap(s => others(s)))).filter(p => p !== caller.me.name)
      const people = Array.from(new Set(explicit
        ? Array.isArray(a.people) ? (a.people as string[]).map(p => p.trim()) : [alias]
        : (a.includeOffline === true ? available : present).sort()))
      if (people.includes(caller.me.name)) return 'error: people must contain one or more people other than you'
      const offlineWithOverlays = available.filter(person => !present.includes(person) && rooms.holding(person, caller).room.changedPaths(person).length > 0)
      const skipped = !explicit && a.includeOffline !== true ? offlineWithOverlays : []
      const skippedNote = skipped.length
        ? `skipped ${skipped.length} offline participant${skipped.length === 1 ? '' : 's'} with overlays: ${skipped.join(', ')}; include with people: [${skipped.map(p => JSON.stringify(p)).join(', ')}] or includeOffline: true`
        : ''
      if (!people.length) return ['no present participants to merge', skippedNote].filter(Boolean).join('\n')
      const participants = people.map(person => ({ person, session: presentSession(person) ?? rooms.holding(person, caller) }))
      for (const { person, session } of participants) {
        const held = withheld(session, person)
        if (held) return held
      }
      const run = typeof a.run === 'string' && a.run.trim() ? a.run.trim() : ''
      const result = await buildCombinedTree(state, caller, participants, { resolve: a.resolve === true, ...(run ? { encoding: 'latin1' as const } : {}) })
      const { ancestor, paths, merged, hardCount, conflictCount, resolvedText, out } = result
      if (!paths.length && result.ignoredNotes.length) return ['no mergeable changes', ...result.ignoredNotes].join('\n')
      if (!paths.length) return [`none of you (${[caller.me.name, ...people].join(', ')}) has changes relative to ${ancestor.slice(0, 10)}`, skippedNote].filter(Boolean).join('\n')
      if (skippedNote) out.push(skippedNote)
      for (const [p, text] of resolvedText) out.push(`--- resolved ${p} (write this to your clone) ---\n${text}--- end ${p} ---`)
      out.push(`final combined tree: ${merged.size} path(s) applied over ${ancestor.slice(0, 10)} from ${[caller.me.name, ...people].join(', ')}${hardCount ? `; excludes ${hardCount} unresolved conflict(s)` : ''}`)
      let ranOk = !run
      if (run) {
        if (hardCount) out.push(`not running "${run}": ${hardCount} conflict(s) need a human first`)
        else {
          const modeParticipants = (await Promise.all(participants.map(async ({ person, session }) => {
            const w = session.room.workerOf(person)
            return w && fs.existsSync(w.dir) ? { dir: w.dir, baseModes: addCarriedUntrackedModes(await gitTreeModes(caller.dir, result.deltaBases.get(person)!), w), ownedPaths: workerOwnedPaths(w), unchangedCarried: carriedUnchangedPaths(workerBaseline(w)), carriedPaths: new Set(w.carriedUntracked?.map(entry => entry.path) ?? []) } : undefined
          }))).filter((x): x is NonNullable<typeof x> => !!x)
          const modes = new Map<string, number>()
          for (const p of merged.keys()) {
            let leadMode = 0o644
            try { const stat = fs.lstatSync(path.join(caller.dir, p)); if (stat.isFile()) leadMode = stat.mode & 0o777 } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
            modes.set(p, mergedFileMode(p, leadMode, modeParticipants))
          }
          const verdict = await runInMergedTree(caller, ancestor, merged, run, modes); out.push(verdict.text); ranOk = verdict.passed
        }
      }
      caller.lastPreview = { clean: hardCount === 0, ...(run ? { testsPassed: hardCount === 0 && ranOk, testsCommand: run } : {}) }
      // A passing preview is part of the branch's story (room_pr_note lists them); a failing one is not.
      if (!hardCount && ranOk) caller.room.post<NoteMsg>(caller.me, { type: 'note', text: `merge preview with ${people.join(', ')}: ${conflictCount ? `${conflictCount} resolvable conflict(s)` : 'no conflicts'} across ${paths.length} path(s)${run ? `; "${run}" passed` : ''}`, priority: 'fyi' })
      return out.join('\n')
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
export function linkSharedDirs(cloneDir: string, scratchDir: string): void {
  const venv = path.join(cloneDir, '.venv')
  if (fs.existsSync(venv) && !fs.existsSync(path.join(scratchDir, '.venv'))) fs.symlinkSync(venv, path.join(scratchDir, '.venv'))
  const candidates = ['node_modules']
  for (const top of ['packages', 'apps', 'libs']) {
    const d = path.join(cloneDir, top)
    if (!fs.existsSync(d)) continue
    for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) candidates.push(path.join(top, e.name, 'node_modules'))
  }
  for (const rel of candidates) {
    const src = path.join(cloneDir, rel), dst = path.join(scratchDir, rel)
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue
    mirrorLinks(cloneDir, scratchDir, src, dst)
  }
}
function mirrorLinks(cloneDir: string, scratchDir: string, src: string, dst: string): void {
  ensureMergedDirectory(scratchDir, path.relative(scratchDir, dst))
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name), to = path.join(dst, e.name)
    if (e.isSymbolicLink()) {
      const target = path.resolve(src, fs.readlinkSync(from))
      const inside = path.relative(cloneDir, target)
      const isWorkspace = inside && !inside.startsWith('..') && !inside.split(path.sep).includes('node_modules')
      fs.symlinkSync(isWorkspace ? path.join(scratchDir, inside) : target, to)
    } else if (e.isDirectory() && e.name.startsWith('@')) {
      mirrorLinks(cloneDir, scratchDir, from, to) // scoped packages: one level deeper
    } else {
      fs.symlinkSync(from, to)
    }
  }
}

export interface TestResult { text: string; passed: boolean }

function ensureMergedDirectory(root: string, rel: string): string {
  const canonicalRoot = fs.realpathSync(root)
  if (!rel) return canonicalRoot
  if (path.isAbsolute(rel) || rel.includes('\\') || rel.includes('\0') || rel.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('unsafe merged path: ' + rel)
  let at = canonicalRoot
  for (const part of rel.split('/')) {
    at = path.join(at, part)
    let stat: fs.Stats | undefined
    try { stat = fs.lstatSync(at) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) throw new Error('unsafe merged ancestor: ' + rel)
    if (!stat) fs.mkdirSync(at)
    const real = fs.realpathSync(at)
    if (real !== canonicalRoot && !real.startsWith(canonicalRoot + path.sep)) throw new Error('merged path escapes scratch tree: ' + rel)
  }
  return at
}

export async function gitTreeModes(dir: string, ref: string): Promise<Map<string, number>> {
  const entries = (await git(dir, ['ls-tree', '-rz', ref])).split('\0').filter(Boolean)
  return new Map(entries.map(entry => { const [meta, rel] = entry.split('\t'); return [rel, parseInt(meta.split(' ')[0], 8) & 0o777] }))
}

export function addCarriedUntrackedModes(modes: Map<string, number>, worker: Worker): Map<string, number> {
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
      const root = fs.realpathSync(participant.dir), real = fs.realpathSync(src)
      if (real !== root && !real.startsWith(root + path.sep)) throw new Error('unsafe worker mode path: ' + rel)
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
  if (!rel || path.isAbsolute(rel) || rel.includes('\\') || rel.includes('\0') || rel.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('unsafe merged path: ' + rel)
  const canonicalRoot = fs.realpathSync(root)
  const parts = rel.split('/')
  const parent = ensureMergedDirectory(canonicalRoot, parts.slice(0, -1).join('/'))
  const file = path.join(parent, parts.at(-1)!)
  let stat: fs.Stats | undefined
  try { stat = fs.lstatSync(file) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
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

/** Materialise ancestor + merged files in a scratch dir (sharing .venv/node_modules from my clone) and run a command there. */
async function runInMergedTree(s: Session, ancestor: string, merged: Map<string, string | null>, cmd: string, modes: ReadonlyMap<string, number> = new Map()): Promise<TestResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-merge-'))
  try {
    await materializeGitTree(s.dir, ancestor, dir)
    for (const [rel, text] of merged) materializeMergedFile(dir, rel, text === null ? null : Buffer.from(text, 'latin1'), modes.get(rel) ?? 0o644)
    linkSharedDirs(s.dir, dir)
    const bash = ['/bin/bash', '/usr/bin/bash'].find(candidate => fs.existsSync(candidate))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ROOM_')))
    env.ROOM_MERGED_TREE = dir
    const result = await new Promise<{ code: number | null; out: string }>(resolve => {
      execFile(bash ?? 'sh', bash ? ['-o', 'pipefail', '-c', cmd] : ['-c', cmd], { cwd: dir, timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) => {
        const raw = err ? (err as { code?: unknown }).code : 0
        resolve({ code: typeof raw === 'number' ? raw : err ? 1 : 0, out: `${stdout}${stderr}` })
      })
    })
    const tail = stripVTControlCharacters(result.out).trim().split('\n').slice(-25).join('\n')
    const verdict = testVerdict(result.out, result.code)
    return { passed: verdict.passed, text: `ran "${cmd}" in the merged tree (${merged.size} file(s) applied over ${ancestor.slice(0, 10)}): exit ${result.code}\n${tail}\n${verdict.text}` }
  } catch (e) {
    return { passed: false, text: `could not run in merged tree: ${e instanceof Error ? e.message : String(e)}` }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Extract one verified commit without placing a clone path or ref in a shell program. */
async function materializeGitTree(cloneDir: string, ref: string, destination: string): Promise<void> {
  if (!/^[0-9a-f]{40,64}$/i.test(ref)) throw new Error(`invalid merge ancestor: ${JSON.stringify(ref)}`)
  await git(cloneDir, ['cat-file', '-e', `${ref}^{commit}`])
  await new Promise<void>((resolve, reject) => {
    const archive = spawn('git', ['-C', cloneDir, 'archive', '--format=tar', ref], { stdio: ['ignore', 'pipe', 'pipe'] })
    const extract = spawn('tar', ['-x', '-C', destination], { stdio: ['pipe', 'ignore', 'pipe'] })
    let archiveError = '', extractError = '', archiveCode: number | null | undefined, extractCode: number | null | undefined
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      archive.kill(); extract.kill()
      reject(error)
    }
    const finish = () => {
      if (settled || archiveCode === undefined || extractCode === undefined) return
      settled = true; clearTimeout(timer)
      if (archiveCode === 0 && extractCode === 0) resolve()
      else reject(new Error(`could not materialize ${ref.slice(0, 10)} (git ${archiveCode ?? 'signal'}${archiveError.trim() ? `: ${archiveError.trim()}` : ''}; tar ${extractCode ?? 'signal'}${extractError.trim() ? `: ${extractError.trim()}` : ''})`))
    }
    const timer = setTimeout(() => fail(new Error('git archive/tar extraction timed out after 60000ms')), 60_000)
    timer.unref?.()
    archive.stderr.setEncoding('utf8'); archive.stderr.on('data', chunk => { archiveError += String(chunk).slice(0, 4096) })
    extract.stderr.setEncoding('utf8'); extract.stderr.on('data', chunk => { extractError += String(chunk).slice(0, 4096) })
    archive.on('error', fail); extract.on('error', fail)
    archive.on('close', code => { archiveCode = code; finish() })
    extract.on('close', code => { extractCode = code; finish() })
    archive.stdout.pipe(extract.stdin)
  })
}
