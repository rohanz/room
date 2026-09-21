import { createTwoFilesPatch } from 'diff'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { describeClaim, withLineNumbers, type NoteMsg } from '@room/shared'
import { git, gitShow } from '@room/roomd/git'
import type { Session } from '../session.js'
import { gitMergeFile } from '../merge.js'
import { workerOwnedPaths } from '../workers.js'
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
      // Local worktrees are authoritative even before the daemon publishes a new file.
      const previewWorker = (s: Session, person: string) => {
        const w = s.local ? s.room.workerOf(person) : undefined
        return w?.lead === s.me.name && fs.existsSync(w.dir) ? w : diskWorker(s, person)
      }
      const previewText = async (s: Session, p: string, person: string) => {
        const w = previewWorker(s, person)
        const dir = w?.dir ?? (person === caller.me.name && s === caller ? caller.dir : undefined)
        if (!dir || (!w && (s.room.text(p, person) !== undefined || s.room.deleted.get(person)?.has(p)))) return liveText(s, p, person)
        if (path.isAbsolute(p) || p.split(/[\\/]/).includes('..')) throw new Error('unsafe preview path: ' + p)
        const root = fs.realpathSync(dir)
        try {
          const file = fs.realpathSync(path.join(root, p))
          if (!file.startsWith(root + path.sep)) throw new Error('unsafe preview symlink: ' + p)
          return fs.readFileSync(file, 'utf8')
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw e
        }
      }
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
      const bases = [{ person: caller.me.name, base: baseFor(caller, caller.me.name) }, ...participants.map(({ person, session }) => ({ person, base: baseFor(session, person) }))]
      let ancestor = bases[0].base
      for (const item of bases.slice(1)) {
        if (item.base === ancestor) continue
        try { ancestor = (await git(caller.dir, ['merge-base', ancestor, item.base])).trim() }
        catch { return `error: ${item.person}'s HEAD ${item.base.slice(0, 10)} is not in this clone; git fetch, then retry` }
      }
      const pathSet = new Set<string>()
      const ignoredNotes: string[] = []
      for (const item of [{ person: caller.me.name, session: caller }, ...participants]) {
        const worker = previewWorker(item.session, item.person)
        const dir = worker?.dir ?? (item.person === caller.me.name ? caller.dir : undefined)
        const ignored = dir ? (await git(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])).split('\0').filter(Boolean) : []
        const visibleIgnored = ignored.filter(p => !/(^|\/)(?:\.venv|venv|__pycache__|node_modules|\.room|\.git|\.cache|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.nox)(?:\/|$)|(^|\/)\.room\.json$|\.tsbuildinfo$|\.py[co]$/.test(p))
        if (visibleIgnored.length) ignoredNotes.push('NOT previewed (gitignored, ' + item.person + '): ' + visibleIgnored.join(', '))
        for (const p of item.session.room.changedPaths(item.person)) if (!ignored.some(i => p === i || (i.endsWith('/') && p.startsWith(i)))) pathSet.add(p)
        if (dir) {
          for (const p of (await git(dir, ['diff', '--name-only', '-z', ancestor, '--'])).split('\0').filter(Boolean)) pathSet.add(p)
          for (const p of (await git(dir, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)) pathSet.add(p)
        }
        if (baseFor(item.session, item.person) !== ancestor) {
          for (const p of (await git(caller.dir, ['diff', '--name-only', ancestor, baseFor(item.session, item.person)])).split('\n').filter(Boolean)) pathSet.add(p)
        }
      }
      // ls-files represents nested repositories/submodules as directory entries.
      // They are not file text and cannot participate in a file merge preview.
      for (const p of pathSet) {
        let excluded = false
        for (const { session, person } of [{ session: caller, person: caller.me.name }, ...participants]) {
          const worker = previewWorker(session, person)
          const dir = worker?.dir ?? (session === caller && person === caller.me.name ? caller.dir : undefined)
          let reason = workerOwnedPaths(session.room.workerOf(person)).includes(p) ? 'linked input' : undefined
          if (!reason && dir) {
            const root = fs.realpathSync(dir)
            try {
              const target = fs.realpathSync(path.join(root, p))
              if (target !== root && !target.startsWith(root + path.sep)) reason = 'symlink leaving the worktree'
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
              try { if (fs.lstatSync(path.join(root, p)).isSymbolicLink()) reason = 'dangling symlink' } catch { /* absent path */ }
            }
          }
          if (reason) {
            ignoredNotes.push(`NOT previewed (${reason}, ${person}): ${p}`)
            excluded = true
          }
        }
        if (excluded) { pathSet.delete(p); continue }
        const dirs = [caller.dir, ...participants.map(({ session, person }) => previewWorker(session, person)?.dir).filter((dir): dir is string => !!dir)]
        if (dirs.some(dir => { try { return fs.lstatSync(path.join(dir, p)).isDirectory() } catch { return false } })) {
          pathSet.delete(p)
          ignoredNotes.push('NOT previewed (directory or nested repository): ' + p)
        }
      }
      const paths = Array.from(pathSet).sort()
      if (!paths.length && ignoredNotes.length) return ['no mergeable changes', ...ignoredNotes].join('\n')
      if (!paths.length) return [`none of you (${[caller.me.name, ...people].join(', ')}) has changes relative to ${ancestor.slice(0, 10)}`, skippedNote].filter(Boolean).join('\n')
      const baseTexts = new Map<string, string | null>()
      const merged = new Map<string, string | null>()
      const owners = new Map<string, string[]>()
      for (const p of paths) {
        const b = (await gitShow(caller.dir, ancestor, p)) ?? null
        baseTexts.set(p, b)
        const mine = await previewText(caller, p, caller.me.name)
        const text = mine === undefined ? b : mine
        merged.set(p, text)
        if (text !== b) owners.set(p, [caller.me.name])
      }
      const out = [`preview merge of your changes with ${people.map(p => `${p}'s`).join(', ')} in order (common ancestor ${ancestor.slice(0, 10)}; merge algorithm: git):`]
      if (skippedNote) out.push(skippedNote)
      out.push(...ignoredNotes)
      let hardCount = 0
      let conflictCount = 0
      const resolvedText = new Map<string, string>()
      for (const [index, { person, session }] of participants.entries()) {
        const declaredNote = shareOf(session, person) === 'declared' ? `note: ${person} shares declared paths only; their changes outside their scope are not in this preview` : ''
        const clean: string[] = [], conflicts: string[] = [], onlyOne: string[] = [], resolvable: string[] = []
        for (const p of paths) {
          const b = baseTexts.get(p)!
          const mine = merged.get(p)
          const theirsRaw = await previewText(session, p, person)
          const mineT = mine ?? '', theirs = theirsRaw === undefined ? b : theirsRaw
          if (theirs === b) continue
          if (mine === b || mine === theirs) {
            onlyOne.push(`${p} (${person} only)`)
            merged.set(p, theirs)
            owners.set(p, [...(owners.get(p) ?? []), person])
            continue
          }
          const res = await gitMergeFile(b ?? '', mineT, theirs ?? '', { ours: 'combined', base: 'base', theirs: person })
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
            if ((await gitMergeFile(b ?? '', ownerText ?? '', theirs ?? '', { ours: owner, base: 'base', theirs: person })).status === 'conflict') pairNames.push(owner)
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
          conflictCount++
          if (!unresolved) {
            resolvable.push(p)
            const text = resolvedLines.join('\n') + (resolvedLines.length ? '\n' : '')
            merged.set(p, text)
            owners.set(p, [...prior, person])
            if (a.resolve === true) resolvedText.set(p, text)
          } else hardCount++
          conflicts.push(`${p}${unresolved ? '' : ' (resolvable)'}\n${detail.join('\n')}`)
        }
        out.push(`step ${index + 1}: merge ${person} into ${[caller.me.name, ...people.slice(0, index)].join(' + ')}`)
        if (declaredNote) out.push(declaredNote)
        if (onlyOne.length) out.push(`touched by one side only (merge trivially): ${onlyOne.join(', ')}`)
        if (clean.length) out.push(`both changed, merge cleanly: ${clean.join(', ')}`)
        if (conflicts.length) out.push(`CONFLICTS:\n${conflicts.join('\n')}`)
        else out.push('no conflicts')
        if (resolvable.length && a.resolve !== true) out.push(`${resolvable.length} conflict(s) are resolvable because one side built on the other's change: call again with resolve=true to get the resolved file text, then write it to your own clone.`)
      }
      for (const [p, text] of resolvedText) out.push(`--- resolved ${p} (write this to your clone) ---\n${text}--- end ${p} ---`)
      out.push(`final combined tree: ${merged.size} path(s) applied over ${ancestor.slice(0, 10)} from ${[caller.me.name, ...people].join(', ')}${hardCount ? `; excludes ${hardCount} unresolved conflict(s)` : ''}`)
      const run = typeof a.run === 'string' && a.run.trim() ? a.run.trim() : ''
      let ranOk = !run
      if (run) {
        if (hardCount) out.push(`not running "${run}": ${hardCount} conflict(s) need a human first`)
        else { const r = await runInMergedTree(caller, ancestor, merged, run); out.push(r); ranOk = /: exit 0\n/.test(r) }
      }
      caller.lastPreview = { clean: hardCount === 0, ...(run ? { testsPassed: hardCount === 0 && ranOk } : {}) }
      // A passing preview is part of the branch's story (room_pr_note lists them); a failing one is not.
      if (!hardCount && ranOk) caller.room.post<NoteMsg>(caller.me, { type: 'note', text: `merge preview with ${people.join(', ')}: ${conflictCount ? `${conflictCount} resolvable conflict(s)` : 'no conflicts'} across ${paths.length} path(s)${run ? `; "${run}" passed` : ''}`, priority: 'fyi' })
      return out.join('\n')
    }
  }
  return handlers
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
  fs.mkdirSync(dst, { recursive: true })
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

/** Runner summaries plus an authoritative exit verdict; at most six lines total. */
export function testVerdict(output: string, code: number | null): string {
  const lines = stripVTControlCharacters(output).split(/\r?\n/).map(line => line.trim())
  const summaries = lines.filter(line => /^(?:Test Files\s+|Tests(?:\s+|:))/.test(line)
    || /^=+ .*(?:passed|failed|error|skipped|deselected|no tests ran).* =+$/i.test(line))
  return [...summaries.slice(-5), `tests: ${code === 0 ? 'PASSED' : 'FAILED'} (exit ${code ?? 'unknown'})`].join('\n')
}

/** Materialise ancestor + merged files in a scratch dir (sharing .venv/node_modules from my clone) and run a command there. */
async function runInMergedTree(s: Session, ancestor: string, merged: Map<string, string | null>, cmd: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-merge-'))
  try {
    await new Promise<void>((resolve, reject) => {
      const p = execFile('sh', ['-c', `git -C "${s.dir}" archive ${ancestor} | tar -x -C "${dir}"`], { timeout: 60_000 }, err => err ? reject(err) : resolve())
      p.unref?.()
    })
    for (const [rel, text] of merged) {
      const abs = path.resolve(dir, rel)
      if (!abs.startsWith(dir)) continue
      if (text === null) { fs.rmSync(abs, { force: true }); continue }
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, text)
    }
    linkSharedDirs(s.dir, dir)
    const result = await new Promise<{ code: number | null; out: string }>(resolve => {
      execFile('sh', ['-c', cmd], { cwd: dir, timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ROOM_MERGED_TREE: dir } }, (err, stdout, stderr) => {
        const raw = err ? (err as { code?: unknown }).code : 0
        resolve({ code: typeof raw === 'number' ? raw : err ? 1 : 0, out: `${stdout}${stderr}` })
      })
    })
    const tail = stripVTControlCharacters(result.out).trim().split('\n').slice(-25).join('\n')
    return `ran "${cmd}" in the merged tree (${merged.size} file(s) applied over ${ancestor.slice(0, 10)}): exit ${result.code}\n${tail}\n${testVerdict(result.out, result.code)}`
  } catch (e) {
    return `could not run in merged tree: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
