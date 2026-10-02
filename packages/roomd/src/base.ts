/**
 * Each participant's base (reporooms §B3): in a team room, the newest ancestor of HEAD on a
 * remote-tracking ref of the room's remote (a worker: its spawn base when that is better, see workerAnchor);
 * in a local room, HEAD (a worker: its carried commit).
 * Nothing here throws for a missing anchor or commit: those read "cannot compare".
 */
import { execFile } from 'node:child_process'
import { BASE_CATCH_UP, canonicalRepo, type ParticipantGit } from '@room/shared'
import { git, gitCountBetween, gitPathsBetween, gitSubject, isGitTimeout, normalizeGitOrigin } from './git.js'

interface BaseRef { name: string; sha: string }
export interface BaseRefs {
  remote?: string
  /** Remote-tracking refs on the room's remote, in preference order: my upstream, <remote>/<branch>, <remote>/HEAD. */
  candidates: BaseRef[]
  /** My own upstream on any remote; own status is relative to it only. */
  upstream?: BaseRef
}
export interface BaseInputs { head: string; branch: string; refs: BaseRefs }
export interface ResolvedBase {
  base: string
  anchored: boolean
  remote?: string
  /** The ref whose candidate became the base. */
  upstream?: string
  ahead?: number
  behind?: number
  status: string
}

async function isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
  try { await git(dir, ['merge-base', '--is-ancestor', ancestor, descendant]); return true }
  catch (error) { if (isGitTimeout(error)) throw error; return false }
}

async function mergeBase(dir: string, a: string, b: string): Promise<string | undefined> {
  try { return (await git(dir, ['merge-base', a, b])).trim() || undefined }
  catch (error) { if (isGitTimeout(error)) throw error; return undefined }
}

/**
 * The remote whose URL canonicalizes to the room name (a legacy branch-room name has it as a prefix until
 * the cutover); with none, `origin` for an explicitly named room.
 */
export async function roomRemote(dir: string, roomName: string): Promise<string | undefined> {
  const remotes = (await git(dir, ['remote'])).split('\n').map(line => line.trim()).filter(Boolean)
  let best: { remote: string; length: number } | undefined
  for (const remote of remotes) {
    let repo: string | undefined
    try { repo = normalizeGitOrigin(await git(dir, ['remote', 'get-url', remote])) } catch (error) { if (isGitTimeout(error)) throw error }
    if (!repo) continue
    repo = canonicalRepo(repo)
    if (roomName !== repo && !roomName.startsWith(`${repo}/`)) continue
    if (!best || repo.length > best.length || (repo.length === best.length && remote === 'origin')) best = { remote, length: repo.length }
  }
  return best?.remote ?? (remotes.includes('origin') ? 'origin' : undefined)
}

const short = (ref: string) => ref.replace(/^refs\/remotes\//, '')

/** Cheap enough for every HEAD poll: two Git calls. Compare `refsKey` to notice a fetch or force-push. */
export async function readBaseRefs(dir: string, remote: string | undefined, branch: string): Promise<BaseRefs> {
  let upstreamRef: string | undefined
  if (branch) {
    try { upstreamRef = (await git(dir, ['rev-parse', '--symbolic-full-name', '@{upstream}'])).trim() || undefined }
    catch (error) { if (isGitTimeout(error)) throw error }
  }
  const wanted = [
    ...(upstreamRef?.startsWith('refs/remotes/') ? [upstreamRef] : []),
    ...(remote && branch ? [`refs/remotes/${remote}/${branch}`] : []),
    ...(remote ? [`refs/remotes/${remote}/HEAD`] : []),
  ]
  const shas = new Map<string, string>()
  if (wanted.length) {
    for (const line of (await git(dir, ['for-each-ref', '--format=%(objectname) %(refname)', ...wanted])).split('\n')) {
      const split = line.indexOf(' ')
      if (split > 0) shas.set(line.slice(split + 1), line.slice(0, split))
    }
  }
  const candidates: BaseRef[] = []
  for (const ref of new Set(wanted)) {
    const sha = shas.get(ref)
    if (sha && (!remote || ref.startsWith(`refs/remotes/${remote}/`))) candidates.push({ name: short(ref), sha })
  }
  const upstreamSha = upstreamRef && shas.get(upstreamRef)
  return { ...(remote ? { remote } : {}), candidates, ...(upstreamRef && upstreamSha ? { upstream: { name: short(upstreamRef), sha: upstreamSha } } : {}) }
}

export const refsKey = (inputs: BaseInputs): string => JSON.stringify([inputs.head, inputs.branch, inputs.refs])

async function anchor(dir: string, head: string, refs: BaseRefs): Promise<{ base: string; anchored: boolean; upstream?: string }> {
  for (const ref of refs.candidates) if (await isAncestor(dir, head, ref.sha)) return { base: head, anchored: true, upstream: ref.name }
  const found: { ref: BaseRef; base: string }[] = []
  for (const ref of refs.candidates) {
    const base = await mergeBase(dir, head, ref.sha)
    if (base) found.push({ ref, base })
  }
  if (!found.length) return { base: head, anchored: false }
  for (const candidate of found) {
    let dominates = true
    for (const other of found) if (other.base !== candidate.base && !await isAncestor(dir, other.base, candidate.base)) { dominates = false; break }
    if (dominates) return { base: candidate.base, anchored: true, upstream: candidate.ref.name }
  }
  const chosen = found.find(c => c.ref.name === refs.upstream?.name) ?? found[0]
  return { base: chosen.base, anchored: true, upstream: chosen.ref.name }
}

/** A remote-tracking ref of the room's remote holds `sha`: teammates can fetch it. */
async function onRemote(dir: string, remote: string | undefined, sha: string): Promise<boolean> {
  if (!remote) return false
  try { return (await git(dir, ['for-each-ref', '--count=1', '--contains', sha, '--format=%(refname)', `refs/remotes/${remote}/`])).trim() !== '' }
  catch (error) { if (isGitTimeout(error)) throw error; return false }
}

/**
 * A team-room worker's base: its branch (room/<tag>) has no remote ref, so the remote anchor is <remote>/HEAD's
 * merge-base or, in a single-branch clone, nothing. Its registry-pinned spawn base is the better base while HEAD
 * descends from it: with no remote anchor at all, or when it is newer than the remote anchor and on the remote.
 */
async function workerAnchor(dir: string, head: string, refs: BaseRefs, found: { base: string; anchored: boolean; upstream?: string }, pinned: string): Promise<{ base: string; anchored: boolean; upstream?: string }> {
  if (pinned === found.base) return { ...found, anchored: true }
  if (!await isAncestor(dir, pinned, head)) return found
  if (!found.anchored) return { base: pinned, anchored: true }
  return await isAncestor(dir, found.base, pinned) && await onRemote(dir, refs.remote, pinned) ? { base: pinned, anchored: true } : found
}

/** `options.carried`: a worker's registry-pinned base for its worktree lifetime (its base in a local room). */
export async function resolveBase(dir: string, inputs: BaseInputs, options: { local?: boolean; carried?: string; knownUpstream?: { name: string; sha: string; by: string } } = {}): Promise<ResolvedBase> {
  const { head, branch, refs } = inputs
  const remoteAnchor = options.local ? undefined : await anchor(dir, head, refs)
  const found = !remoteAnchor
    ? { base: options.carried ?? head, anchored: true }
    : options.carried ? await workerAnchor(dir, head, refs, remoteAnchor, options.carried) : remoteAnchor
  let ahead: number | undefined, behind: number | undefined
  if (refs.upstream) {
    const counts = (await git(dir, ['rev-list', '--left-right', '--count', `${head}...${refs.upstream.sha}`])).trim().split(/\s+/).map(Number)
    ;[ahead, behind] = counts
  }
  const u = refs.upstream?.name
  let known = options.knownUpstream && options.knownUpstream.name === u && options.knownUpstream.sha !== refs.upstream?.sha ? options.knownUpstream : undefined
  // A fetched tracking ref can later overtake the notice; never compare against an older bus head.
  if (known && refs.upstream && await ensureCommit(dir, refs.remote, known.sha) && await isAncestor(dir, known.sha, refs.upstream.sha)) known = undefined
  if (known) {
    if (await ensureCommit(dir, refs.remote, known.sha)) {
      try {
        const counts = (await git(dir, ['rev-list', '--left-right', '--count', `${head}...${known.sha}`])).trim().split(/\s+/).map(Number)
        ;[ahead, behind] = counts
      } catch (error) { if (isGitTimeout(error)) throw error; ahead = behind = undefined }
    } else ahead = behind = undefined
  }
  const status = !found.anchored ? `no anchor on ${refs.remote ?? 'any remote'}: teammates cannot compare with you`
    : !branch ? `detached at ${head.slice(0, 10)}`
    : !u ? 'no upstream'
    : ahead && behind ? `diverged from ${u}: stop and tell your human`
    : behind ? known ? `behind ${u} by ${behind} (pushed by ${known.by}; not yet pulled)` : `behind ${u} by ${behind}: ${BASE_CATCH_UP}`
    : known && behind === undefined ? `behind (remote moved to ${known.sha.slice(0, 10)})`
    : ahead ? `${ahead} unpushed`
    : `synced with ${u}`
  return {
    ...found, ...(refs.remote && !options.local ? { remote: refs.remote } : {}),
    ...(ahead !== undefined ? { ahead, behind } : {}), status,
  }
}

/** This clone's own push moved the tracking ref to `sha`: Git logs it as "update by push", a fetch never does. */
async function pushedFromHere(dir: string, ref: string, sha: string): Promise<boolean> {
  try { return (await git(dir, ['reflog', 'show', '--format=%H %gs', '-n', '50', `refs/remotes/${ref}`])).split('\n').includes(`${sha} update by push`) }
  catch (error) { if (isGitTimeout(error)) throw error; return false }
}

/**
 * §B4: the anchor moved forward over commits this participant already had: they were its HEAD before, or
 * its own push put them there (a commit and its push seen in one poll). A pull of others' commits fails
 * both, a reset the strict-ancestor test, and a branch switch the first.
 */
export async function pushedRange(dir: string, prev: ParticipantGit, next: Pick<ParticipantGit, 'branch' | 'base' | 'anchored' | 'upstream'>): Promise<boolean> {
  let currentUpstream: string | undefined
  if (next.upstream) {
    try { currentUpstream = (await git(dir, ['rev-parse', `refs/remotes/${next.upstream}`])).trim() }
    catch (error) { if (isGitTimeout(error)) throw error }
  }
  return prev.branch === next.branch && prev.anchored && next.anchored && prev.base !== next.base
    && (await isAncestor(dir, prev.base, next.base) && await isAncestor(dir, next.base, prev.head)
      || !!next.upstream && currentUpstream === next.base && await pushedFromHere(dir, next.upstream, next.base))
}

/** Compare the previous known upstream head with the newly pushed head. Unknown is never given ff-only advice. */
export async function pushHistory(dir: string, remote: string | undefined, oldSha: string, newSha: string): Promise<'forward' | 'yes' | 'unknown'> {
  if (!await ensureCommit(dir, remote, oldSha) || !await ensureCommit(dir, remote, newSha)) return 'unknown'
  return new Promise(resolve => {
    execFile('git', ['merge-base', '--is-ancestor', oldSha, newSha], { cwd: dir, timeout: 30_000 }, error => {
      resolve(!error ? 'forward' : (error as NodeJS.ErrnoException & { code?: number }).code === 1 ? 'yes' : 'unknown')
    })
  })
}

export async function pushedFacts(dir: string, fromSha: string, toSha: string): Promise<{ commits: number; paths: string[]; summary: string }> {
  const [commits, paths, summary] = await Promise.all([gitCountBetween(dir, fromSha, toSha), gitPathsBetween(dir, fromSha, toSha), gitSubject(dir, toSha)])
  return { commits, paths, summary }
}

const FETCH_TIMEOUT_MS = 20_000
const FETCH_RETRY_MS = 5 * 60_000
const fetchAttempts = new Map<string, number>()

const hasCommit = async (dir: string, sha: string) => {
  try { await git(dir, ['cat-file', '-e', `${sha}^{commit}`]); return true } catch { return false }
}

/**
 * Make `sha` present in this clone: objects only (no ref, FETCH_HEAD or file change), from the reader's
 * remote for this room, never prompting, at most once per sha per 5 minutes. `ROOM_AUTO_FETCH=0` turns
 * the fetch off (reporooms risk 4). A host may refuse commits no ref reaches, e.g. after a force-push.
 */
export async function ensureCommit(dir: string, remote: string | undefined, sha: string): Promise<boolean> {
  if (await hasCommit(dir, sha)) return true
  if (!remote || process.env.ROOM_AUTO_FETCH === '0' || !/^[0-9a-f]{40,64}$/.test(sha)) return false
  const key = `${dir}\0${sha}`
  const last = fetchAttempts.get(key)
  if (last !== undefined && Date.now() - last < FETCH_RETRY_MS) return false
  fetchAttempts.set(key, Date.now())
  await new Promise<void>(resolve => {
    execFile('git', ['-c', 'credential.interactive=never', 'fetch', '--no-tags', '--no-write-fetch-head', remote, sha],
      { cwd: dir, timeout: FETCH_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, () => resolve())
  })
  return hasCommit(dir, sha)
}

/** A pair is compared at merge-base(a.base, b.base); anything else is "cannot compare" for that pair only. */
export async function comparePair(dir: string, remote: string | undefined, a: ParticipantGit, b: ParticipantGit): Promise<{ mergeBase: string } | { cannotCompare: string }> {
  if (!a.anchored || !b.anchored) return { cannotCompare: 'unknown: no anchor' }
  for (const sha of [a.base, b.base]) if (!await ensureCommit(dir, remote, sha)) return { cannotCompare: `unknown: missing ${sha}` }
  const base = await mergeBase(dir, a.base, b.base)
  return base ? { mergeBase: base } : { cannotCompare: 'unknown: unrelated histories' }
}
