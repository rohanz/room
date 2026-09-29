import { participantRecord } from '@room/shared'
import { incarnationText } from './manifest-assert.js'
import { policyFromLevel } from '../src/policy.js'
import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import { claimDigest } from '../src/reanchor.js'
import { pollHead } from './poll-head.js'

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
  daemon = await startRoomd({ policy: policyFromLevel('full'), dir, room: 'ws://memory/head-retry', name: 'Alice', providerFactory: (_s, _n, doc) => provider(doc),
    basePollMs: 60_000, trackedRefreshMs: 60_000, log: () => {} })
  ;(daemon as Roomd & { watcher: { removeAllListeners(event: string): void } }).watcher.removeAllListeners('all')
  const oldHead = daemon.base
  const claim = daemon.roomDoc.addClaim({ path: 'app.txt', from: 2, to: 2, by: 'Alice', byKind: 'agent', intent: 'edit', claimedHash: claimDigest(original, 2, 2) })
  fs.writeFileSync(path.join(dir, 'app.txt'), 'added\n' + original)
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'move block')
  return { oldHead, newHead: git(dir, 'rev-parse', 'HEAD'), claim }
}

it('retries an injected Git failure through the whole HEAD transition', async () => {
  const { oldHead, newHead, claim } = await movedHead()
  probe.failTracked = true
  await daemon!.reconcileGitChanges()
  expect(daemon!.base).toBe(newHead)
  expect(participantRecord(daemon!.roomDoc, 'Alice')?.git?.base).toBe(oldHead)
  expect(daemon!.roomDoc.manifestHead.get('Alice')?.complete).toBe(false)
  await daemon!.reconcileGitChanges()
  expect(daemon!.base).toBe(newHead)
  expect(participantRecord(daemon!.roomDoc, 'Alice')?.git?.base).toBe(newHead)
  expect(daemon!.roomDoc.claims.get(claim.id)).toMatchObject({ from: 3, to: 3 })
})

it('reanchors a recovered branch-room claim against this checkout and releases a stale one', async () => {
  await movedHead()
  await daemon!.reconcileGitChanges()
  const good = { id: 'legacy-good', path: 'app.txt', from: 2, to: 2, by: 'Alice', byKind: 'agent' as const,
    intent: 'edit', at: 1, claimedHash: claimDigest('first\nclaimed\nlast\n', 2, 2), origin: 'local/repo/main' }
  daemon!.roomDoc.claims.set(good.id, good)
  daemon!.roomDoc.claims.set('legacy-stale', { ...good, id: 'legacy-stale', claimedHash: 'missing' })
  await daemon!.validateMigratedClaims()
  expect(daemon!.roomDoc.claims.get(good.id)).toMatchObject({ from: 3, to: 3 })
  expect(daemon!.roomDoc.claims.has('legacy-stale')).toBe(false)
})

it('leaves migrated claims intact if the name fence lapses during validation', async () => {
  await movedHead()
  const stale = { id: 'legacy-stale', path: 'app.txt', from: 2, to: 2, by: 'Alice', byKind: 'agent' as const,
    intent: 'edit', at: 1, claimedHash: 'missing', origin: 'local/repo/main' }
  daemon!.roomDoc.claims.set(stale.id, stale)
  const internal = daemon as Roomd & { reanchorOwnClaims(head: string, claims: unknown[]): Promise<unknown> }
  const original = internal.reanchorOwnClaims.bind(internal)
  let fence = '22'
  ;(daemon as Roomd & { lease: () => string | undefined }).lease = () => fence
  internal.reanchorOwnClaims = async (head, claims) => { const result = await original(head, claims); fence = undefined as unknown as string; return result }
  await daemon!.validateMigratedClaims()
  expect(daemon!.roomDoc.claims.get(stale.id)).toEqual(stale)
})

it('keeps a claim uncertain when its disk file exceeds the publication size cap', async () => {
  const { newHead, claim } = await movedHead()
  fs.writeFileSync(path.join(dir!, 'app.txt'), 'other\n'.repeat(120_000))
  const internal = daemon as Roomd & { reanchorOwnClaims(head: string, claims: unknown[]): Promise<{ moves: unknown[]; releases: unknown[] }> }
  const result = await internal.reanchorOwnClaims(newHead, [claim])
  expect(result.moves).toEqual([])
  expect(result.releases).toEqual([])
  expect(daemon!.roomDoc.claims.get(claim.id)).toEqual(claim)
})

it('refuses a prepared claim move when the claim changes before the final transaction', async () => {
  const { claim } = await movedHead()
  const internal = daemon as Roomd & { reanchorOwnClaims(head: string, claims: unknown[]): Promise<unknown> }
  const original = internal.reanchorOwnClaims.bind(internal)
  internal.reanchorOwnClaims = async (head, claims) => {
    const changes = await original(head, claims)
    daemon!.roomDoc.claims.set(claim.id, { ...claim, from: 1, to: 1, claimedHash: 'replacement' })
    return changes
  }
  await daemon!.reconcileGitChanges()
  expect(daemon!.roomDoc.claims.get(claim.id)).toMatchObject({ from: 1, to: 1, claimedHash: 'replacement' })
  expect(daemon!.roomDoc.manifestHead.get('Alice')?.complete).toBe(false)
})

it('keeps the new baseline after publishing a dirty overlay', async () => {
  const { newHead } = await movedHead()
  fs.writeFileSync(path.join(dir!, 'app.txt'), 'dirty after commit\n')
  await daemon!.reconcileGitChanges()
  expect(participantRecord(daemon!.roomDoc, 'Alice')?.git?.base).toBe(newHead)
  expect(incarnationText(daemon!.roomDoc, 'Alice', 'app.txt')?.toString()).toBe('dirty after commit\n')
  expect(daemon!.roomDoc.baseText('Alice', newHead, 'app.txt')).toBe('added\nfirst\nclaimed\nlast\n')
})

it('retries after publication and claim re-anchoring without losing the baseline or moving claims twice', async () => {
  const { oldHead, newHead, claim } = await movedHead()
  fs.writeFileSync(path.join(dir!, 'app.txt'), 'added\nfirst\nclaimed\nlast\ndirty\n')
  const internal = daemon as Roomd & { reanchorOwnClaims(head: string, claims: unknown[]): Promise<unknown>; appliedHead: string }
  const reanchor = internal.reanchorOwnClaims.bind(internal)
  let fail = true
  internal.reanchorOwnClaims = async (head, claims) => {
    const changes = await reanchor(head, claims)
    if (fail) { fail = false; throw new Error('injected post-publication failure') }
    return changes
  }
  await daemon!.reconcileGitChanges()
  expect(internal.appliedHead).not.toBe(newHead)
  expect(participantRecord(daemon!.roomDoc, 'Alice')?.git?.base).toBe(oldHead)
  expect(incarnationText(daemon!.roomDoc, 'Alice', 'app.txt')).toBeUndefined()
  expect(daemon!.roomDoc.baseText('Alice', newHead, 'app.txt')).toBeUndefined()
  await daemon!.reconcileGitChanges()
  expect(internal.appliedHead).toBe(newHead)
  expect(daemon!.roomDoc.claims.get(claim.id)).toMatchObject({ from: 3, to: 3 })
  expect(incarnationText(daemon!.roomDoc, 'Alice', 'app.txt')?.toString()).toContain('dirty')
  expect(daemon!.roomDoc.baseText('Alice', newHead, 'app.txt')).toBeDefined()
})

it('retries when HEAD moves during publication', async () => {
  const { newHead } = await movedHead()
  fs.writeFileSync(path.join(dir!, 'app.txt'), 'dirty before next commit\n')
  const internal = daemon as Roomd & { beforeBaseRead: (path: string) => Promise<void>; appliedHead: string }
  let moved = false
  internal.beforeBaseRead = async () => {
    if (moved) return
    moved = true
    git(dir!, 'add', '-A'); git(dir!, 'commit', '-qm', 'move again')
    fs.writeFileSync(path.join(dir!, 'app.txt'), 'dirty after next commit\n')
  }
  await daemon!.reconcileGitChanges()
  expect(internal.appliedHead).not.toBe(newHead)
  await daemon!.reconcileGitChanges()
  const finalHead = git(dir!, 'rev-parse', 'HEAD')
  expect(internal.appliedHead).toBe(finalHead)
  expect(participantRecord(daemon!.roomDoc, 'Alice')?.git?.base).toBe(finalHead)
  expect(incarnationText(daemon!.roomDoc, 'Alice', 'app.txt')?.toString()).toBe('dirty after next commit\n')
  expect(daemon!.roomDoc.baseText('Alice', finalHead, 'app.txt')).toBe('dirty before next commit\n')
})

it('does not apply an earlier line shift twice when HEAD moves after re-anchoring', async () => {
  const { claim } = await movedHead()
  const internal = daemon as Roomd & { reanchorOwnClaims(head: string, claims: unknown[]): Promise<unknown> }
  const reanchor = internal.reanchorOwnClaims.bind(internal)
  let advanced = false
  internal.reanchorOwnClaims = async (head, claims) => {
    const changes = await reanchor(head, claims)
    if (advanced) return changes
    advanced = true
    fs.writeFileSync(path.join(dir!, 'app.txt'), 'more\nadded\nfirst\nclaimed\nlast\n')
    git(dir!, 'add', '-A'); git(dir!, 'commit', '-qm', 'move block again')
    return changes
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

it('invalidates complete coverage before a held autostash wait and keeps it incomplete on busy timeout', async () => {
  await movedHead()
  const marker = path.join(dir!, '.git', 'MERGE_AUTOSTASH')
  fs.writeFileSync(marker, 'busy\n')
  const oldInputs = daemon!.inputs
  let entered!: () => void
  const atWait = new Promise<void>(resolve => { entered = resolve })
  let resume!: () => void
  const gate = new Promise<void>(resolve => { resume = resolve })
  const internal = daemon as Roomd & { waitForGitOperation(head: string): Promise<void> }
  const original = internal.waitForGitOperation.bind(internal)
  internal.waitForGitOperation = async head => { entered(); await gate; await original(head) }
  const pending = pollHead(daemon!)
  await atWait
  expect(daemon!.inputs).not.toBe(oldInputs)
  expect(daemon!.roomDoc.manifestHead.get('Alice')).toMatchObject({ complete: false, coverage: { kind: 'none', reason: 'starting' } })
  let tick = 0
  const now = vi.spyOn(Date, 'now').mockImplementation(() => ++tick * 1_000)
  resume()
  try { await expect(pending).rejects.toThrow('Git operation or worktree is still changing') }
  finally { now.mockRestore(); fs.rmSync(marker) }
  expect(daemon!.roomDoc.manifestHead.get('Alice')?.complete).toBe(false)
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
