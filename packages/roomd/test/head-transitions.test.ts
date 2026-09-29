import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import { claimDigest } from '../src/reanchor.js'

const probe = vi.hoisted(() => ({ failTracked: false }))
vi.mock('../src/git.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/git.js')>()
  return { ...actual, gitTracked: async (dir: string) => {
    if (probe.failTracked) { probe.failTracked = false; throw new Error('injected git ls-files failure') }
    return actual.gitTracked(dir)
  } }
})
import { startRoomd, type Roomd } from '../src/index.js'

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
const provider = (doc: Y.Doc) => {
  let local: unknown = null
  return { synced: true, awareness: { setLocalState(value: unknown) { local = value }, getLocalState: () => local, getStates: () => new Map([[doc.clientID, local]]) }, on() {}, off() {}, destroy() {} } as unknown as WebsocketProvider
}
let dir: string | undefined
let daemon: Roomd | undefined
afterEach(async () => {
  probe.failTracked = false
  await daemon?.stop()
  daemon = undefined
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

async function movedHead() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-head-retry-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  const original = 'first\nclaimed\nlast\n'
  fs.writeFileSync(path.join(dir, 'app.txt'), original)
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base')
  const retries: Array<() => void> = []
  daemon = await startRoomd({ dir, room: 'ws://memory/head-retry', name: 'Alice', providerFactory: (_s, _n, doc) => provider(doc),
    basePollMs: 60_000, trackedRefreshMs: 60_000, log: () => {}, retrySchedule: run => { retries.push(run); return () => {} } })
  ;(daemon as Roomd & { watcher: { removeAllListeners(event: string): void } }).watcher.removeAllListeners('all')
  const oldHead = daemon.base
  const claim = daemon.roomDoc.addClaim({ path: 'app.txt', from: 2, to: 2, by: 'Alice', byKind: 'agent', intent: 'edit', claimedHash: claimDigest(original, 2, 2) })
  fs.writeFileSync(path.join(dir, 'app.txt'), 'added\n' + original)
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'move block')
  return { oldHead, newHead: git(dir, 'rev-parse', 'HEAD'), claim, retries }
}

it('retries an injected Git failure through the whole HEAD transition', async () => {
  const { oldHead, newHead, claim, retries } = await movedHead()
  probe.failTracked = true
  await daemon!.reconcileGitChanges()
  expect(daemon!.base).toBe(newHead)
  expect(daemon!.roomDoc.baseOf('Alice')).toBe(oldHead)
  expect(retries).toHaveLength(1)
  retries.shift()!()
  await daemon!.reconcileGitChanges()
  expect(daemon!.base).toBe(newHead)
  expect(daemon!.roomDoc.baseOf('Alice')).toBe(newHead)
  expect(daemon!.roomDoc.claims.get(claim.id)).toMatchObject({ from: 3, to: 3 })
})

it('keeps the new baseline after publishing a dirty overlay', async () => {
  const { newHead } = await movedHead()
  fs.writeFileSync(path.join(dir!, 'app.txt'), 'dirty after commit\n')
  await daemon!.reconcileGitChanges()
  expect(daemon!.roomDoc.baseOf('Alice')).toBe(newHead)
  expect(daemon!.roomDoc.overlayText('Alice', 'app.txt')?.toString()).toBe('dirty after commit\n')
  expect(daemon!.roomDoc.baseText('Alice', newHead, 'app.txt')).toBe('added\nfirst\nclaimed\nlast\n')
})

it('retries after publication and claim re-anchoring without losing the baseline or moving claims twice', async () => {
  const { newHead, claim, retries } = await movedHead()
  fs.writeFileSync(path.join(dir!, 'app.txt'), 'added\nfirst\nclaimed\nlast\ndirty\n')
  const internal = daemon as Roomd & { reanchorOwnClaims(head: string, claims: unknown[]): Promise<void>; markIntegratedBaseNotices(notices: unknown[]): void; appliedHead: string }
  const reanchor = internal.reanchorOwnClaims.bind(internal)
  const markNotices = internal.markIntegratedBaseNotices.bind(internal)
  let notices = 0
  internal.markIntegratedBaseNotices = messages => { notices++; markNotices(messages) }
  let fail = true
  internal.reanchorOwnClaims = async (head, claims) => {
    await reanchor(head, claims)
    if (fail) { fail = false; throw new Error('injected post-publication failure') }
  }
  await daemon!.reconcileGitChanges()
  expect(internal.appliedHead).not.toBe(newHead)
  expect(daemon!.roomDoc.baseOf('Alice')).toBe(newHead)
  expect(daemon!.roomDoc.overlayText('Alice', 'app.txt')?.toString()).toContain('dirty')
  expect(daemon!.roomDoc.baseText('Alice', newHead, 'app.txt')).toBeDefined()
  expect(notices).toBe(0)
  expect(retries).toHaveLength(1)
  retries.shift()!()
  await daemon!.reconcileGitChanges()
  expect(internal.appliedHead).toBe(newHead)
  expect(daemon!.roomDoc.claims.get(claim.id)).toMatchObject({ from: 3, to: 3 })
  expect(daemon!.roomDoc.overlayText('Alice', 'app.txt')?.toString()).toContain('dirty')
  expect(daemon!.roomDoc.baseText('Alice', newHead, 'app.txt')).toBeDefined()
  expect(notices).toBe(1)
})

it('retries when HEAD moves during publication', async () => {
  const { newHead, retries } = await movedHead()
  fs.writeFileSync(path.join(dir!, 'app.txt'), 'dirty before next commit\n')
  const internal = daemon as Roomd & { beforePublishWrite: (path: string) => Promise<void>; appliedHead: string }
  let moved = false
  internal.beforePublishWrite = async () => {
    if (moved) return
    moved = true
    git(dir!, 'add', '-A'); git(dir!, 'commit', '-qm', 'move again')
    fs.writeFileSync(path.join(dir!, 'app.txt'), 'dirty after next commit\n')
  }
  await daemon!.reconcileGitChanges()
  expect(internal.appliedHead).not.toBe(newHead)
  expect(retries).toHaveLength(1)
  retries.shift()!()
  await daemon!.reconcileGitChanges()
  const finalHead = git(dir!, 'rev-parse', 'HEAD')
  expect(internal.appliedHead).toBe(finalHead)
  expect(daemon!.roomDoc.baseOf('Alice')).toBe(finalHead)
  expect(daemon!.roomDoc.overlayText('Alice', 'app.txt')?.toString()).toBe('dirty after next commit\n')
  expect(daemon!.roomDoc.baseText('Alice', finalHead, 'app.txt')).toBe('dirty before next commit\n')
})

it('does not apply an earlier line shift twice when HEAD moves after re-anchoring', async () => {
  const { claim } = await movedHead()
  const internal = daemon as Roomd & { reanchorOwnClaims(head: string, claims: unknown[]): Promise<void> }
  const reanchor = internal.reanchorOwnClaims.bind(internal)
  let advanced = false
  internal.reanchorOwnClaims = async (head, claims) => {
    await reanchor(head, claims)
    if (advanced) return
    advanced = true
    fs.writeFileSync(path.join(dir!, 'app.txt'), 'more\nadded\nfirst\nclaimed\nlast\n')
    git(dir!, 'add', '-A'); git(dir!, 'commit', '-qm', 'move block again')
  }
  await daemon!.reconcileGitChanges()
  await daemon!.reconcileGitChanges()
  expect(daemon!.roomDoc.claims.get(claim.id)).toMatchObject({ from: 4, to: 4 })
})

it('retries when Git operation markers remain past the deadline', async () => {
  const { newHead } = await movedHead()
  for (const name of ['index.lock', 'MERGE_AUTOSTASH', 'MERGE_HEAD', 'REBASE_HEAD', 'rebase-apply', 'rebase-merge/autostash']) {
    const marker = path.join(dir!, '.git', name)
    fs.mkdirSync(path.dirname(marker), { recursive: true })
    fs.writeFileSync(marker, newHead + '\n')
    let tick = 0
    const now = vi.spyOn(Date, 'now').mockImplementation(() => ++tick * 1_000)
    try {
      await expect((daemon as Roomd & { waitForGitOperation(head: string): Promise<void> }).waitForGitOperation(newHead))
        .rejects.toThrow('Git operation or worktree is still changing')
    } finally { now.mockRestore(); fs.rmSync(marker, { force: true }); if (name.includes('/')) fs.rmSync(path.dirname(marker), { recursive: true, force: true }) }
  }
})

it('proceeds after the deadline when only claimed file content keeps changing', async () => {
  const { newHead } = await movedHead()
  let tick = 0
  const now = vi.spyOn(Date, 'now').mockImplementation(() => ++tick * 1_000)
  let writes = 0
  const timer = setInterval(() => fs.writeFileSync(path.join(dir!, 'app.txt'), `busy ${++writes}\n`), 10)
  try {
    await expect((daemon as Roomd & { waitForGitOperation(head: string): Promise<void> }).waitForGitOperation(newHead))
      .resolves.toBeUndefined()
    expect(writes).toBeGreaterThan(0)
  } finally { clearInterval(timer); now.mockRestore() }
})
