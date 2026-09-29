import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { BASE_CATCH_UP, type ParticipantGit } from '@room/shared'
import { comparePair, ensureCommit, pushedRange, readBaseRefs, resolveBase, roomRemote, type BaseInputs } from '../src/base.js'

const sh = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
const roots: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

/** A bare `origin.git` with one commit on main, and clones that track it: room name `local/origin`. */
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-anchor-'))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  sh(root, 'init', '--bare', '-q', '-b', 'main', origin)
  const clone = (name: string) => {
    const dir = path.join(root, name)
    sh(root, 'clone', '-q', origin, dir)
    sh(dir, 'config', 'user.email', 'test@example.com')
    sh(dir, 'config', 'user.name', 'Test')
    sh(dir, 'config', 'pull.ff', 'only')
    return dir
  }
  const seed = clone('seed')
  commit(seed, 'app.txt', 'base\n')
  sh(seed, 'push', '-q', 'origin', 'HEAD:main')
  return { root, origin, clone, room: 'local/origin' }
}
function commit(dir: string, file: string, text: string, message = file): string {
  fs.writeFileSync(path.join(dir, file), text)
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', message)
  return sh(dir, 'rev-parse', 'HEAD')
}
async function resolve(dir: string, room: string, local = false) {
  const head = sh(dir, 'rev-parse', 'HEAD')
  const abbrev = sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD')
  const branch = abbrev === 'HEAD' ? '' : abbrev
  const remote = await roomRemote(dir, room)
  const inputs: BaseInputs = { head, branch, refs: await readBaseRefs(dir, remote, branch) }
  return resolveBase(dir, inputs, local ? { local: true } : {})
}

describe('resolveBase (reporooms §B3): the newest ancestor of HEAD on the room remote', () => {
  it('reports a newer pushed head when the tracking ref is stale', async () => {
    const w = world()
    const a = w.clone('a'), b = w.clone('b')
    const pushed = commit(b, 'new.txt', 'new\n')
    sh(b, 'push', '-q', 'origin', 'HEAD:main')
    const head = sh(a, 'rev-parse', 'HEAD')
    const refs = await readBaseRefs(a, 'origin', 'main')
    expect((await resolveBase(a, { head, branch: 'main', refs }, { knownUpstream: { name: 'origin/main', sha: pushed, by: 'Ben' } })).status)
      .toBe('behind origin/main by 1 (pushed by Ben; not yet pulled)')
  })
  it('synced, unpushed, behind and diverged read against my own upstream; the anchor never throws', async () => {
    const w = world()
    const a = w.clone('a'), b = w.clone('b')
    const start = sh(a, 'rev-parse', 'HEAD')
    expect(await resolve(a, w.room)).toMatchObject({ base: start, anchored: true, remote: 'origin', upstream: 'origin/main', ahead: 0, behind: 0, status: 'synced with origin/main' })

    const unpushed = commit(a, 'a.txt', 'a\n')
    expect(await resolve(a, w.room)).toMatchObject({ base: start, anchored: true, ahead: 1, behind: 0, status: '1 unpushed' })
    expect(unpushed).not.toBe(start)

    const theirs = commit(b, 'b.txt', 'b\n')
    sh(b, 'push', '-q', 'origin', 'HEAD:main')
    sh(a, 'fetch', '-q')
    expect(await resolve(a, w.room)).toMatchObject({ base: start, anchored: true, ahead: 1, behind: 1, status: 'diverged from origin/main: stop and tell your human' })

    const c = w.clone('c')
    sh(c, 'reset', '-q', '--hard', start)
    expect(await resolve(c, w.room)).toMatchObject({ base: start, anchored: true, ahead: 0, behind: 1, status: `behind origin/main by 1: ${BASE_CATCH_UP}` })
    expect(theirs).toBe(sh(c, 'rev-parse', 'origin/main'))
  })

  it('orphan history has no anchor: base is HEAD, anchored false, and the status says teammates cannot compare', async () => {
    const w = world()
    const a = w.clone('a')
    sh(a, 'checkout', '-q', '--orphan', 'fresh')
    const orphan = commit(a, 'new.txt', 'new\n')
    expect(await resolve(a, w.room)).toMatchObject({ base: orphan, anchored: false, status: 'no anchor on origin: teammates cannot compare with you' })
  })

  it('a detached HEAD is anchored through <remote>/HEAD and says so', async () => {
    const w = world()
    const a = w.clone('a')
    const start = sh(a, 'rev-parse', 'HEAD')
    commit(a, 'a.txt', 'a\n')
    sh(a, 'checkout', '-q', '--detach')
    const head = sh(a, 'rev-parse', 'HEAD')
    expect(await resolve(a, w.room)).toMatchObject({ base: start, anchored: true, upstream: 'origin/HEAD', status: `detached at ${head.slice(0, 10)}` })
  })

  it('uses the remote whose URL names the room, not an assumed origin, and falls back to origin for explicit room names', async () => {
    const w = world()
    const fork = path.join(w.root, 'fork.git')
    sh(w.root, 'clone', '-q', '--bare', w.origin, fork)
    const a = w.clone('a')
    sh(a, 'remote', 'rename', 'origin', 'upstream')
    sh(a, 'remote', 'add', 'origin', fork)
    sh(a, 'fetch', '-q', 'origin')
    const start = sh(a, 'rev-parse', 'HEAD')
    // The fork gets a commit the room's remote does not have.
    const forked = w.clone('forked')
    sh(forked, 'remote', 'set-url', 'origin', fork)
    sh(forked, 'fetch', '-q'); sh(forked, 'reset', '-q', '--hard', 'origin/main')
    commit(forked, 'fork.txt', 'fork\n'); sh(forked, 'push', '-q', 'origin', 'HEAD:main')
    sh(a, 'fetch', '-q', 'origin'); sh(a, 'reset', '-q', '--hard', 'origin/main')
    expect(await roomRemote(a, w.room)).toBe('upstream')
    expect(await resolve(a, w.room)).toMatchObject({ base: start, anchored: true, remote: 'upstream' })
    expect(await roomRemote(a, 'team-room')).toBe('origin')
    expect(await roomRemote(a, 'local/origin/some-branch')).toBe('upstream') // a legacy branch-room name until the cutover
  })

  it('an upstream on the room remote wins when no candidate dominates', async () => {
    const w = world()
    const a = w.clone('a')
    sh(a, 'checkout', '-q', '-b', 'feat')
    const onFeat = commit(a, 'feat.txt', 'feat\n')
    sh(a, 'push', '-q', '-u', 'origin', 'feat')
    const b = w.clone('b')
    commit(b, 'main.txt', 'main\n'); sh(b, 'push', '-q', 'origin', 'HEAD:main')
    sh(a, 'fetch', '-q')
    sh(a, 'merge', '-q', '--no-edit', '--no-ff', 'origin/main')
    // Candidates: merge-base with origin/feat (onFeat) and with origin/HEAD (b's main); neither contains the other.
    sh(a, 'remote', 'set-head', 'origin', 'main')
    expect(await resolve(a, w.room)).toMatchObject({ base: onFeat, anchored: true, upstream: 'origin/feat', status: '2 unpushed' })
  })

  it('a local room anchors at HEAD', async () => {
    const w = world()
    const a = w.clone('a')
    const head = commit(a, 'a.txt', 'a\n')
    expect(await resolve(a, w.room, true)).toMatchObject({ base: head, anchored: true })
  })
})

describe('pairs (reporooms invariant 5): merge-base of two bases, or "cannot compare"', () => {
  it('recognizes an own force-push even when the previous head is replaced', async () => {
    const w = world()
    const a = w.clone('a')
    const first = commit(a, 'one.txt', 'one\n')
    sh(a, 'push', '-q', 'origin', 'HEAD:main')
    sh(a, 'reset', '-q', '--hard', 'HEAD~1')
    const replacement = commit(a, 'two.txt', 'two\n')
    sh(a, 'push', '-q', '--force', 'origin', 'HEAD:main')
    expect(await pushedRange(a,
      { branch: 'main', head: first, base: first, anchored: true, upstream: 'origin/main', rev: 1, fence: '' },
      { branch: 'main', base: replacement, anchored: true, upstream: 'origin/main' })).toBe(true)
  })
  const record = (base: string, anchored = true): ParticipantGit => ({ branch: 'main', head: base, base, anchored, rev: 1, fence: '' })

  it('a force-pushed reset leaves the pair unable to compare until the commit arrives, never an error', async () => {
    vi.stubEnv('ROOM_AUTO_FETCH', '0')
    const w = world()
    const a = w.clone('a'), c = w.clone('c')
    const start = sh(a, 'rev-parse', 'HEAD')
    sh(a, 'commit', '--amend', '-qm', 'rewritten')
    const reset = sh(a, 'rev-parse', 'HEAD')
    sh(a, 'push', '-q', '--force', 'origin', 'HEAD:main')
    expect(await comparePair(c, 'origin', record(start), record(reset))).toEqual({ cannotCompare: `unknown: missing ${reset}` })
    sh(c, 'fetch', '-q')
    expect(await comparePair(c, 'origin', record(start), record(reset))).toEqual({ cannotCompare: 'unknown: unrelated histories' })
    const next = commit(a, 'x.txt', 'x\n')
    sh(a, 'push', '-q', 'origin', 'HEAD:main'); sh(c, 'fetch', '-q')
    expect(await comparePair(c, 'origin', record(reset), record(next))).toEqual({ mergeBase: reset })
    expect(await comparePair(c, 'origin', record(reset), record(next, false))).toEqual({ cannotCompare: 'unknown: no anchor' })
  })

  it('ensureCommit fetches a reachable commit by id, objects only, and remembers a failure', async () => {
    const w = world()
    const a = w.clone('a'), c = w.clone('c')
    const pushed = commit(a, 'p.txt', 'p\n')
    sh(a, 'push', '-q', 'origin', 'HEAD:main')
    const refsBefore = sh(c, 'for-each-ref')
    expect(await ensureCommit(c, 'origin', pushed)).toBe(true)
    expect(sh(c, 'cat-file', '-t', pushed)).toBe('commit')
    expect(sh(c, 'for-each-ref')).toBe(refsBefore)
    expect(fs.existsSync(path.join(c, '.git', 'FETCH_HEAD'))).toBe(false)
    const local = commit(a, 'q.txt', 'q\n') // never pushed: nobody can serve it
    expect(await ensureCommit(c, 'origin', local)).toBe(false)
    sh(a, 'push', '-q', 'origin', 'HEAD:main')
    expect(await ensureCommit(c, 'origin', local)).toBe(false) // at most one fetch per sha per 5 minutes
  })
})
