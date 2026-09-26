import fs from 'node:fs'
import path from 'node:path'
import { git } from '@room/roomd/git'
import { DISK_READ_PATH, containedRepoPath, validRepoPath } from '@room/roomd'
import type { Session } from '../session.js'
import { gitMergeFile } from '../merge.js'
import { workerOwnedPaths } from '../workers.js'
import { decidePreview, workerRealState } from '../worker-state.js'
import { baselineText, checkoutText, MissingBaseBlob, pairBaseline, type Baseline } from '@room/roomd/baseline'
import { diskWorker, type HandlerState } from './context.js'

/** The ordered combined-tree engine shared by preview and collection. Never writes a clone. */
export async function buildCombinedTree(state: HandlerState, caller: Session, participants: { person: string; session: Session }[], options: { resolve?: boolean; diskOnly?: boolean; diskWorkers?: ReadonlySet<string>; encoding?: BufferEncoding; skipCallerOnly?: boolean; roots?: ReadonlyMap<string, string> } = {}) {
  const { rooms, liveText, baseFor, shareOf } = state
  const people = participants.map(p => p.person)
  // Local worktrees, plus collection's already-verified workers, are authoritative before daemon publication.
  const previewWorkers = new WeakMap<Session, Map<string, ReturnType<typeof diskWorker>>>()
  for (const { session: s, person } of [{ session: caller, person: caller.me.name }, ...participants]) {
    let byPerson = previewWorkers.get(s)
    if (!byPerson) { byPerson = new Map(); previewWorkers.set(s, byPerson) }
    if (byPerson.has(person)) continue
    const w = s.local || options.diskWorkers?.has(person) ? s.room.workerOf(person) : undefined
    const candidate = w?.lead === s.me.name ? w : diskWorker(s, person)
    const worker = candidate && decidePreview(await workerRealState(s.dir, candidate), true) === 'disk' ? candidate : undefined
    byPerson.set(person, worker)
  }
  const previewWorker = (s: Session, person: string) => previewWorkers.get(s)?.get(person)
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
    const root = roots.get(path.resolve(dir))
    if (!root) throw new Error('uncaptured preview root: ' + dir)
    return root
  }
  for (const dir of previewDirs) rootOf(dir)
  const previewText = async (s: Session, p: string, person: string) => {
    const w = previewWorker(s, person)
    const dir = w?.dir ?? (person === caller.me.name && s === caller ? caller.dir : undefined)
    if (!dir || (!options.diskOnly && !w && (s.room.text(p, person) !== undefined || s.room.deleted.get(person)?.has(p)))) {
      const live = await liveText(s, p, person)
      return options.encoding === 'latin1' && typeof live === 'string' ? Buffer.from(live, 'utf8').toString('latin1') : live
    }
    if (!validRepoPath(p, { ...DISK_READ_PATH, blank: 'allow' })) throw new Error('unsafe preview path: ' + p)
    const root = rootOf(dir)
    try {
      const result = containedRepoPath(root, path.join(root, p), { leaf: 'read-contained-link' })
      if (!result.ok) throw new Error('unsafe preview symlink: ' + p)
      const file = result.path
      return fs.readFileSync(file, options.encoding ?? 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }
  const bases = [{ person: caller.me.name, base: baseFor(caller, caller.me.name) }, ...participants.map(({ person, session }) => ({ person, base: baseFor(session, person) }))]
  let ancestor = bases[0].base
  for (const item of bases.slice(1)) {
    if (item.base === ancestor) continue
    try { ancestor = (await git(caller.dir, ['merge-base', ancestor, item.base])).trim() }
    catch { throw new Error(`${item.person}'s HEAD ${item.base.slice(0, 10)} is not in this clone; git fetch, then retry`) }
  }
  // A worker's own changes are its tree against its baseline (baseline.ts), whichever side calls:
  // a shared merge-base would count the lead's carried work as the worker's.
  const descends = (from: string, sha: string) => git(caller.dir, ['merge-base', '--is-ancestor', from, sha]).then(() => true, () => false)
  const callerWorker = caller.room.workerOf(caller.me.name)
  const callerBaseline = await pairBaseline(callerWorker, undefined, ancestor, descends)
  const pairs = new Map<string, Baseline | undefined>()
  for (const { person, session } of participants) pairs.set(person, await pairBaseline(callerWorker, session.room.workerOf(person), ancestor, descends))
  const deltaBases = new Map([...pairs].map(([person, pair]) => [person, pair?.sha ?? ancestor]))
  const pathSet = new Set<string>()
  /** Paths a participant may have changed; the rest only the caller changed. */
  const theirPaths = new Set<string>()
  const ignoredNotes: string[] = []
  for (const [index, item] of [{ person: caller.me.name, session: caller }, ...participants].entries()) {
    const add = (p: string) => { pathSet.add(p); if (index > 0) theirPaths.add(p) }
    const worker = previewWorker(item.session, item.person)
    const dir = worker?.dir ?? (item.person === caller.me.name ? caller.dir : undefined)
    const ignored = dir ? (await git(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])).split('\0').filter(Boolean) : []
    const visibleIgnored = ignored.filter(p => !/(^|\/)(?:\.venv|venv|__pycache__|node_modules|\.room|\.git|\.cache|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.nox)(?:\/|$)|(^|\/)\.room\.json$|\.tsbuildinfo$|\.py[co]$/.test(p))
    if (visibleIgnored.length) ignoredNotes.push('NOT previewed (gitignored, ' + item.person + '): ' + visibleIgnored.join(', '))
    if (!options.diskOnly) for (const p of item.session.room.changedPaths(item.person)) if (!ignored.some(i => p === i || (i.endsWith('/') && p.startsWith(i)))) add(p)
    if (dir) {
      for (const p of (await git(dir, ['diff', '--name-only', '-z', ancestor, '--'])).split('\0').filter(Boolean)) add(p)
      for (const p of (await git(dir, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)) add(p)
    }
    for (const base of new Set([baseFor(item.session, item.person), deltaBases.get(item.person) ?? callerBaseline?.sha ?? ancestor])) {
      if (base !== ancestor) for (const p of (await git(caller.dir, ['diff', '--name-only', '-z', ancestor, base])).split('\0').filter(Boolean)) add(p)
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
        const root = rootOf(dir)
        try {
          if (!containedRepoPath(root, path.join(root, p), { leaf: 'read-contained-link', allowRoot: true }).ok) reason = 'symlink leaving the worktree'
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
  // A path only the caller changed cannot conflict and keeps the caller's text. Skipping it avoids reading
  // gigabytes of a lead's untracked art when only the participants' changes matter (collect, preview without a run).
  let callerOnly = 0
  if (options.skipCallerOnly) for (const p of pathSet) if (!theirPaths.has(p)) { pathSet.delete(p); callerOnly++ }
  const baseTexts = new Map<string, string | null>()
  const textAt = async (sha: string, p: string) => {
    const key = sha + ':' + p
    if (!baseTexts.has(key)) baseTexts.set(key, (await checkoutText(caller.dir, `${sha}:${p}`, p, options.encoding)) ?? null)
    return baseTexts.get(key)!
  }
  const baseAt = async (pair: Baseline | undefined, p: string) => pair ? (await baselineText(pair, p, textAt, options.encoding)) ?? null : textAt(ancestor, p)
  for (const pair of new Set([callerBaseline, ...pairs.values()])) for (const p of pair?.untracked.keys() ?? []) {
    if (pathSet.has(p)) await baseAt(pair, p).catch(error => {
      if (!(error instanceof MissingBaseBlob)) throw error
      pathSet.delete(p)
      ignoredNotes.push(error.message)
    })
  }
  const paths = Array.from(pathSet).sort()
  const merged = new Map<string, string | null>()
  const owners = new Map<string, string[]>()
  for (const p of paths) {
    const mine = await previewText(caller, p, caller.me.name)
    const text = mine === undefined ? await textAt(ancestor, p) : mine
    merged.set(p, text)
    if (text !== await baseAt(callerBaseline, p)) owners.set(p, [caller.me.name])
  }
  const initial = new Map(merged)
  const out: string[] = []
  const fallbacks = new Set<string>()

  out.push(...ignoredNotes)
  let hardCount = 0
  let conflictCount = 0
  const resolvedText = new Map<string, string>()
  const conflictingPaths = new Map<string, string[]>()
  for (const [index, { person, session }] of participants.entries()) {
    const declaredNote = shareOf(session, person) === 'declared' ? `note: ${person} shares declared paths only; their changes outside their scope are not in this preview` : ''
    const clean: string[] = [], conflicts: string[] = [], onlyOne: string[] = [], resolvable: string[] = []
    const pair = pairs.get(person)
    for (const p of paths) {
      const mine = merged.get(p)
      const theirsRaw = await previewText(session, p, person)
      const b = await baseAt(pair, p)
      const mineT = mine ?? '', theirs = theirsRaw === undefined ? b : theirsRaw
      if (theirs === b) continue
      if (mine === b || mine === theirs) {
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
      conflicts.push(`${p}${unresolved ? '' : ' (resolvable)'}\n${detail.join('\n')}`)
    }
    out.push(`step ${index + 1}: merge ${person} into ${[caller.me.name, ...people.slice(0, index)].join(' + ')}${pair && pair.sha !== ancestor ? ` (against ${pair.worker}'s base ${pair.sha.slice(0, 10)})` : ''}`)
    if (declaredNote) out.push(declaredNote)
    if (onlyOne.length) out.push(pair?.carriedCommit
      ? `touched by one side only since ${person}'s base ${pair.sha.slice(0, 10)} (merge trivially; the lead's carried edits are in that base): ${onlyOne.join(', ')}`
      : `touched by one side only (merge trivially): ${onlyOne.join(', ')}`)
    if (clean.length) out.push(`both changed, merge cleanly: ${clean.join(', ')}`)
    if (conflicts.length) out.push(`CONFLICTS:\n${conflicts.join('\n')}`)
    else out.push('no conflicts')
    if (resolvable.length && options.resolve !== true) out.push(`${resolvable.length} conflict(s) are resolvable because one side built on the other's change: call again with resolve=true to get the resolved file text, then write it to your own clone.`)
  }

  out.unshift(`preview merge of your changes with ${people.map(p => `${p}'s`).join(', ')} in order (common ancestor ${ancestor.slice(0, 10)}; merge algorithm: ${fallbacks.size ? 'fallback' : 'git'}${fallbacks.size ? `; fallback reason: ${[...fallbacks].join('; ')}` : ''}):`)
  return { ancestor, deltaBases, paths, callerOnly, initial, merged, owners, conflictingPaths, hardCount, conflictCount, resolvedText, out, ignoredNotes, roots, diskWorkers }
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
