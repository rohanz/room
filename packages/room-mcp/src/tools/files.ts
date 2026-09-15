import { createTwoFilesPatch } from 'diff'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { diff3Merge } from 'node-diff3'
import { describeClaim, withLineNumbers, type NoteMsg } from '@room/shared'
import { git, gitShow } from '@room/roomd/git'
import type { Session } from '../session.js'
import { RO, RW, int, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'

export const defs: ToolDef[] = [
  { name: 'room_read', annotations: RO, description: 'A file as a person sees it right now: base commit + their uncommitted edits (default: you). With line numbers, claims in the file, and the file ledger (recent changes by others, open plans).',
    inputSchema: { type: 'object', properties: { path: str('repo-relative path'), person: str('whose live version (default you)') }, required: ['path'] } },
  { name: 'room_diff', annotations: RO, description: 'Unified diff from the base commit to a person\'s live version, for one path or all their changed paths.',
    inputSchema: { type: 'object', properties: { path: str('optional path'), person: str('default you') } } },
  { name: 'room_impact', annotations: RO, description: 'Dependency graph query. symbol: who defines it and which files use it, with who owns those files (scope, claims, uncommitted changes). path: what the file depends on (symbols defined elsewhere) and what depends on it. Use before renaming or changing a signature, and to see what you are waiting on.',
    inputSchema: { type: 'object', properties: { symbol: str('function/class/variable name'), path: str('repo-relative path') } } },
  { name: 'room_preview_merge', annotations: RO, description: 'Would your uncommitted changes and another person\'s combine cleanly? Three-way merge against the common base; nothing in any clone is written. Reports clean paths and conflicting hunks. With `run`, materialises the merged tree in a scratch directory and runs that command there (e.g. the tests), so you can verify code that depends on their unmerged work.',
    inputSchema: { type: 'object', properties: { person: str('the other person'), run: str('optional shell command to run in the merged tree, e.g. "uv run pytest -q"'), resolve: { type: 'boolean', description: 'when a conflicting region on one side contains the other side\'s lines in order (you built on their change), take the larger side and return the resolved file text so you can write it to your own clone' } }, required: ['person'] } }
]

export function handlers(state: HandlerState): Record<string, Handler> {
  const { S, rooms, withheld, liveText, lines, baseFor, ledgerLines, baseText, shareOf, describeUsers } = state
  const handlers: Record<string, Handler> = {
    async room_read(a) {
      if (typeof a.path !== 'string' || !a.path) return 'error: path is required'
      const p = a.path
      const person = typeof a.person === 'string' && a.person ? a.person : S().me.name
      const s = rooms.holding(person, S()) // a local worker's overlay lives in the workers room, not the team room
      const held = withheld(s, person, p)
      if (held) return held
      const t = await liveText(s, p, person)
      if (t === null) return `${p}: deleted by ${person} (uncommitted)`
      if (t === undefined) return `error: ${p} exists neither at base nor in ${person}'s changes`
      const out = [`${p} as ${person} sees it (${lines(t)} lines${s.room.text(p, person) !== undefined ? ', uncommitted edits' : ', unchanged'} on their HEAD ${baseFor(s, person).slice(0, 10)})`]
      const who = s.room.whoChanged(p).filter(x => x !== person)
      if (who.length) out.push(`! also changed (uncommitted) by: ${who.join(', ')} — room_read with person= to see theirs`)
      for (const c of s.room.claimsFor(p)) out.push(`! claim ${c.id}: ${describeClaim(c)}`)
      out.push(withLineNumbers(t))
      out.push(...ledgerLines(s, { path: p, limit: 10 }, p))
      return out.join('\n')
    },
    async room_diff(a) {
      const person = typeof a.person === 'string' && a.person ? a.person : S().me.name
      const s = rooms.holding(person, S())
      const one = async (p: string) => {
        const b = (await baseText(s, p)) ?? ''
        const l = await liveText(s, p, person)
        const live = l === null ? '' : l ?? b
        return live === b ? '' : createTwoFilesPatch(`a/${p}`, `b/${p}`, b, live, 'base', person, { context: 3 })
      }
      const held = withheld(s, person, typeof a.path === 'string' && a.path ? a.path : undefined)
      if (held) return held
      if (typeof a.path === 'string' && a.path) return (await one(a.path)) || `${a.path}: no difference between base and ${person}'s version`
      const parts: string[] = []
      for (const p of s.room.changedPaths(person)) { const d = await one(p); if (d) parts.push(d) }
      const level = shareOf(s, person)
      if (level === 'declared') parts.push(`(${person} shares declared paths only: changes outside their scope are not shared)`)
      return parts.length ? parts.join('\n') : `${person} has no uncommitted changes`
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
      const person = typeof a.person === 'string' && a.person ? a.person : ''
      if (!person || person === S().me.name) return 'error: person is required (someone other than you)'
      const s = rooms.holding(person, S()) // my own overlay is in both rooms; a local worker's only in the workers room
      const held = withheld(s, person)
      if (held) return held
      const declaredNote = shareOf(s, person) === 'declared' ? `note: ${person} shares declared paths only; their changes outside their scope are not in this preview` : ''
      const myBase = baseFor(s, s.me.name), theirBase = baseFor(s, person)
      let ancestor = myBase
      if (theirBase !== myBase) {
        try { ancestor = (await git(s.dir, ['merge-base', myBase, theirBase])).trim() }
        catch { return `error: ${person}'s HEAD ${theirBase.slice(0, 10)} is not in this clone; git fetch, then retry` }
      }
      const committedBetween = theirBase === myBase ? [] : (await git(s.dir, ['diff', '--name-only', ancestor, theirBase])).split('\n').filter(Boolean)
      const paths = Array.from(new Set([...s.room.changedPaths(s.me.name), ...s.room.changedPaths(person), ...committedBetween])).sort()
      if (!paths.length) return `neither you nor ${person} has changes relative to ${ancestor.slice(0, 10)}`
      const clean: string[] = [], conflicts: string[] = [], onlyOne: string[] = [], resolvable: string[] = []
      const resolvedText = new Map<string, string>()
      const merged = new Map<string, string | null>() // path -> merged text, null = deleted
      for (const p of paths) {
        const b = (await gitShow(s.dir, ancestor, p)) ?? ''
        const m = await liveText(s, p, s.me.name), t = await liveText(s, p, person)
        const mineT = m === null ? '' : m ?? b, theirs = t === null ? '' : t ?? b
        if (mineT === b || theirs === b) {
          onlyOne.push(`${p} (${mineT === b ? person : 'you'} only)`)
          const side = mineT === b ? t : m
          merged.set(p, side === null ? null : side ?? b)
          continue
        }
        const res = diff3Merge(mineT.split('\n'), b.split('\n'), theirs.split('\n'))
        const hunks = res.filter(r => 'conflict' in r)
        if (!hunks.length) { clean.push(p); merged.set(p, res.flatMap(r => r.ok ?? []).join('\n')); continue }
        let line = 1
        const detail: string[] = []
        const resolvedLines: string[] = []
        let unresolved = 0
        for (const r of res) {
          if (r.ok) { line += r.ok.length; resolvedLines.push(...r.ok); continue }
          const c = r.conflict
          if (!c) continue
          const sup = supersetSide(c.a, c.b)
          if (sup) {
            detail.push(`  around line ${line}: ${sup === 'a' ? 'your' : `${person}'s`} version contains ${sup === 'a' ? `${person}'s` : 'your'} change in order — resolvable by taking ${sup === 'a' ? 'yours' : 'theirs'}`)
            resolvedLines.push(...(sup === 'a' ? c.a : c.b))
          } else {
            unresolved++
            detail.push(`  around line ${line}: you changed ${c.a.length} line(s), ${person} changed ${c.b.length} line(s) — needs a human or a rewrite`)
            resolvedLines.push('<<<<<<< yours', ...c.a, '=======', ...c.b, `>>>>>>> ${person}`)
          }
          line += c.o.length
        }
        if (!unresolved) { resolvable.push(p); merged.set(p, resolvedLines.join('\n') + (resolvedLines.length ? '\n' : '')) }
        conflicts.push(`${p}${unresolved ? '' : ' (resolvable)'}\n${detail.join('\n')}`)
        if (!unresolved && a.resolve === true) resolvedText.set(p, merged.get(p)!)
      }
      const out = [`preview merge of your changes with ${person}'s (common ancestor ${ancestor.slice(0, 10)}${theirBase !== myBase ? `; ${person} is on ${theirBase.slice(0, 10)}, you on ${myBase.slice(0, 10)}` : ''}):`]
      if (declaredNote) out.push(declaredNote)
      if (onlyOne.length) out.push(`touched by one side only (merge trivially): ${onlyOne.join(', ')}`)
      if (clean.length) out.push(`both changed, merge cleanly: ${clean.join(', ')}`)
      const hard = conflicts.filter(c => !c.includes(' (resolvable)'))
      if (conflicts.length) out.push(`CONFLICTS:\n${conflicts.join('\n')}`)
      else out.push('no conflicts')
      if (resolvable.length && a.resolve !== true) out.push(`${resolvable.length} conflict(s) are resolvable because one side built on the other's change: call again with resolve=true to get the resolved file text, then write it to your own clone (only your side changes).`)
      for (const [p, text] of resolvedText) out.push(`--- resolved ${p} (write this to your clone) ---\n${text}--- end ${p} ---`)
      const run = typeof a.run === 'string' && a.run.trim() ? a.run.trim() : ''
      let ranOk = !run
      if (run) {
        if (hard.length) out.push(`not running "${run}": ${hard.length} conflict(s) need a human first`)
        else { const r = await runInMergedTree(s, ancestor, merged, run); out.push(r); ranOk = /: exit 0\n/.test(r) }
      }
      // A passing preview is part of the branch's story (room_pr_note lists them); a failing one is not.
      if (!hard.length && ranOk) s.room.post<NoteMsg>(s.me, { type: 'note', text: `merge preview with ${person}: ${conflicts.length ? `${resolvable.length} resolvable conflict(s)` : 'no conflicts'} across ${paths.length} path(s)${run ? `; "${run}" passed` : ''}`, priority: 'fyi' })
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
    const tail = result.out.trim().split('\n').slice(-25).join('\n')
    return `ran "${cmd}" in the merged tree (${merged.size} file(s) applied over ${ancestor.slice(0, 10)}): exit ${result.code}\n${tail}`
  } catch (e) {
    return `could not run in merged tree: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
