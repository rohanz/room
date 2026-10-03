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

const probe = vi.hoisted(() => ({ failTracked: false, blobChecks: [] as string[][], blobReads: [] as string[][], headHook: undefined as undefined | (() => void) }))
vi.mock('../src/git.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/git.js')>()
  return { ...actual, gitHead: async (dir: string) => {
    const head = await actual.gitHead(dir)
    if (probe.headHook) await new Promise<void>(resolve => setImmediate(() => {
      const hook = probe.headHook
      probe.headHook = undefined
      hook?.()
      resolve()
    }))
    return head
  }, gitBlobInfoMany: async (dir: string, base: string, paths: Iterable<string>) => {
    const list = [...paths]
    probe.blobChecks.push(list)
    return actual.gitBlobInfoMany(dir, base, list)
  }, gitShowMany: async (dir: string, base: string, paths: Iterable<string>) => {
    const list = [...paths]
    probe.blobReads.push(list)
    return actual.gitShowMany(dir, base, list)
  }, gitTracked: async (dir: string) => {
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
  probe.blobChecks.length = 0
  probe.blobReads.length = 0
  probe.headHook = undefined
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
  ;(daemon as Roomd & { watcher: { suspend(): void } }).watcher.suspend()
  const oldHead = daemon.base
  const claim = daemon.roomDoc.addClaim({ path: 'app.txt', from: 2, to: 2, by: 'Alice', byKind: 'agent', intent: 'edit', claimedHash: claimDigest(original, 2, 2) })
  fs.writeFileSync(path.join(dir, 'app.txt'), 'added\n' + original)
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'move block')
  return { oldHead, newHead: git(dir, 'rev-parse', 'HEAD'), claim }
}

it.each([
  { name: 'moves a uniquely cut-and-pasted block', after: 'a\nb\nc\nd\ne\nf\nclaimed one\nclaimed two\n', range: [7, 8] as const },
  { name: 'releases a block duplicated after the commit', after: 'new\na\nclaimed one\nclaimed two\nb\nclaimed one\nclaimed two\n', range: undefined },
])('$name with previous text available on a real HEAD transition', async ({ after, range }) => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-head-identity-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  const before = 'a\nclaimed one\nclaimed two\nb\nc\nd\ne\nf\n'
  fs.writeFileSync(path.join(dir, 'app.txt'), before)
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base')
  daemon = await startRoomd({ policy: policyFromLevel('full'), dir, room: 'ws://memory/head-identity', name: 'Alice', providerFactory: (_s, _n, doc) => provider(doc),
    basePollMs: 60_000, trackedRefreshMs: 60_000, log: () => {} })
  ;(daemon as Roomd & { watcher: { suspend(): void } }).watcher.suspend()
  const claim = daemon.roomDoc.addClaim({ path: 'app.txt', from: 2, to: 3, by: 'Alice', byKind: 'agent', intent: 'edit', claimedHash: claimDigest(before, 2, 3) })
  fs.writeFileSync(path.join(dir, 'app.txt'), after)
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'change claimed block')
  await daemon.reconcileGitChanges()
  expect(participantRecord(daemon.roomDoc, 'Alice')?.git?.base).toBe(git(dir, 'rev-parse', 'HEAD'))
  expect((daemon as Roomd & { pendingClaimValidation?: unknown }).pendingClaimValidation).toBeUndefined()
  if (range) expect(daemon.roomDoc.claims.get(claim.id)).toMatchObject({ from: range[0], to: range[1] })
  else expect(daemon.roomDoc.claims.has(claim.id)).toBe(false)
})

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

it('finishes budget-limited claim validation on later ticks after a real HEAD transition', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-head-many-claims-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  const before = 'old\n' + 'filler\n'.repeat(35_000)
  fs.writeFileSync(path.join(dir, 'app.txt'), before)
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base')
  daemon = await startRoomd({ policy: policyFromLevel('full'), dir, room: 'ws://memory/head-many', name: 'Alice', providerFactory: (_s, _n, doc) => provider(doc),
    basePollMs: 60_000, trackedRefreshMs: 60_000, log: () => {} })
  ;(daemon as Roomd & { watcher: { suspend(): void } }).watcher.suspend()
  const claims = Array.from({ length: 20 }, () => daemon!.roomDoc.addClaim({ path: 'app.txt', from: 1, to: 1, by: 'Alice', byKind: 'agent', intent: 'edit', claimedHash: claimDigest(before, 1, 1) }))
  fs.writeFileSync(path.join(dir, 'app.txt'), before.replace(/^old/, 'new'))
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'replace claimed block')
  await daemon.reconcileGitChanges()
  expect(daemon.roomDoc.claims.size).toBeGreaterThan(0)
  expect(daemon.roomDoc.manifestHead.get('Alice')?.complete).toBe(false)
  for (let tick = 0; tick < 20 && daemon.roomDoc.claims.size; tick++) await daemon.reconcileGitChanges()
  expect(claims.every(claim => !daemon!.roomDoc.claims.has(claim.id))).toBe(true)
  expect((daemon as Roomd & { pendingClaimValidation?: unknown }).pendingClaimValidation).toBeUndefined()
})

async function pendingWideClaim(count = 1) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-head-wide-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  const before = 'old\n' + 'filler\n'.repeat(35_000)
  fs.writeFileSync(path.join(dir, 'app.txt'), before)
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base')
  daemon = await startRoomd({ policy: policyFromLevel('full'), dir, room: 'ws://memory/head-wide', name: 'Alice', providerFactory: (_s, _n, doc) => provider(doc),
    basePollMs: 60_000, trackedRefreshMs: 60_000, log: () => {} })
  ;(daemon as Roomd & { watcher: { suspend(): void } }).watcher.suspend()
  const claims = Array.from({ length: count }, () => daemon!.roomDoc.addClaim({ path: 'app.txt', from: 1, to: count === 1 ? 2000 : 1, by: 'Alice', byKind: 'agent', intent: 'edit', claimedHash: claimDigest(before, 1, count === 1 ? 2000 : 1) }))
  fs.writeFileSync(path.join(dir, 'app.txt'), before.replace(/^old/, 'new'))
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'replace claimed line')
  await daemon.reconcileGitChanges()
  return claims[claims.length - 1]
}

it('finishes a wide readable claim after a bounded number of retry ticks', async () => {
  const claim = await pendingWideClaim()
  for (let tick = 0; tick < 12 && daemon!.roomDoc.claims.has(claim.id); tick++) await daemon!.reconcileGitChanges()
  expect(daemon!.roomDoc.claims.has(claim.id)).toBe(false)
  expect((daemon as Roomd & { pendingClaimValidation?: unknown }).pendingClaimValidation).toBeUndefined()
})

it('keeps pending originals across an unrelated later HEAD transition', async () => {
  const claim = await pendingWideClaim(20)
  expect(daemon!.roomDoc.claims.has(claim.id)).toBe(true)
  fs.writeFileSync(path.join(dir!, 'unrelated.txt'), 'new\n')
  git(dir!, 'add', '-A'); git(dir!, 'commit', '-qm', 'unrelated change')
  await daemon!.reconcileGitChanges()
  expect(daemon!.roomDoc.manifestHead.get('Alice')?.complete).toBe(false)
  for (let tick = 0; tick < 12 && daemon!.roomDoc.claims.has(claim.id); tick++) await daemon!.reconcileGitChanges()
  expect(daemon!.roomDoc.claims.has(claim.id)).toBe(false)
})

it('keeps pending originals across a refs-only transition', async () => {
  const claim = await pendingWideClaim(20)
  expect(daemon!.roomDoc.claims.has(claim.id)).toBe(true)
  git(dir!, 'remote', 'add', 'origin', dir!)
  git(dir!, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(dir!, 'branch', '--set-upstream-to=origin/main', 'main')
  await daemon!.reconcileGitChanges()
  expect(daemon!.roomDoc.manifestHead.get('Alice')?.complete).toBe(false)
  for (let tick = 0; tick < 12 && daemon!.roomDoc.claims.has(claim.id); tick++) await daemon!.reconcileGitChanges()
  expect(daemon!.roomDoc.claims.has(claim.id)).toBe(false)
})

it.each(['lease', 'inputs'] as const)('does not apply a pending claim after %s changes during the final Git await', async change => {
  await pendingWideClaim(20)
  const internal = daemon as Roomd & { pendingClaimValidation: { head: string; fence: string; claims: Map<string, unknown> };
    retryPendingClaims(head: string, fence: string): Promise<void> }
  const pending = internal.pendingClaimValidation
  expect(pending.claims.size).toBeGreaterThan(0)
  const before = new Map([...pending.claims].map(([id]) => [id, JSON.stringify(daemon!.roomDoc.claims.get(id))]))
  probe.headHook = () => {
    if (change === 'lease') daemon!.setPublicationRejected(true)
    else daemon!.applyInputs({ ...daemon!.inputs, policy: policyFromLevel('full') })
  }
  await internal.retryPendingClaims(pending.head, pending.fence)
  expect([...before].map(([id]) => JSON.stringify(daemon!.roomDoc.claims.get(id)))).toEqual([...before.values()])
  expect(internal.pendingClaimValidation).toBe(pending)
  expect(pending.claims.size).toBe(before.size)
})

it('releases an oversized clean claim and keeps an oversized locally edited claim', async () => {
  const { claim } = await movedHead()
  const oversized = 'other\n'.repeat(120_000)
  fs.writeFileSync(path.join(dir!, 'app.txt'), oversized)
  git(dir!, 'add', '-A'); git(dir!, 'commit', '-qm', 'oversized replacement')
  await daemon!.reconcileGitChanges()
  expect(daemon!.roomDoc.claims.has(claim.id)).toBe(false)

  const edited = daemon!.roomDoc.addClaim({ path: 'app.txt', from: 1, to: 1, by: 'Alice', byKind: 'agent', intent: 'edit', claimedHash: 'missing' })
  fs.writeFileSync(path.join(dir!, 'app.txt'), oversized + 'local edit\n')
  const internal = daemon as Roomd & { reanchorOwnClaims(head: string, claims: unknown[]): Promise<{ releases: unknown[] }> }
  const result = await internal.reanchorOwnClaims(git(dir!, 'rev-parse', 'HEAD'), [edited])
  expect(result.releases).toEqual([])
  expect(daemon!.roomDoc.claims.has(edited.id)).toBe(true)
})

it('keeps an unreadable locally replaced claim until the replacement is committed', async () => {
  const { claim } = await movedHead()
  fs.writeFileSync(path.join(dir!, 'target.txt'), 'replacement\n')
  fs.rmSync(path.join(dir!, 'app.txt'))
  fs.symlinkSync('target.txt', path.join(dir!, 'app.txt'))
  await daemon!.reconcileGitChanges()
  expect(daemon!.roomDoc.claims.has(claim.id)).toBe(true)
  git(dir!, 'add', '-A'); git(dir!, 'commit', '-qm', 'replace claimed file with link')
  await daemon!.reconcileGitChanges()
  expect(daemon!.roomDoc.claims.has(claim.id)).toBe(false)
})

it('does not read an old blob for a claim with a digest or hash an oversized fallback', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-claim-old-blob-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  const old = 'claim\n' + 'large\n'.repeat(120_000)
  fs.writeFileSync(path.join(dir, 'app.txt'), old)
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base')
  daemon = await startRoomd({ policy: policyFromLevel('full'), dir, room: 'ws://memory/old-blob', name: 'Alice', providerFactory: (_s, _n, doc) => provider(doc),
    basePollMs: 60_000, trackedRefreshMs: 60_000, log: () => {} })
  const withDigest = daemon.roomDoc.addClaim({ path: 'app.txt', from: 1, to: 1, by: 'Alice', byKind: 'agent', intent: 'edit', claimedHash: claimDigest('claim\n', 1, 1) })
  const internal = daemon as Roomd & { snapshotOwnClaims(head: string): Promise<Array<{ id: string; claimedHash?: string }>> }
  probe.blobChecks.length = 0
  probe.blobReads.length = 0
  const first = await internal.snapshotOwnClaims(git(dir, 'rev-parse', 'HEAD'))
  expect(first.find(c => c.id === withDigest.id)?.claimedHash).toBe(withDigest.claimedHash)
  expect(probe.blobChecks).toEqual([['app.txt']])
  expect(probe.blobReads).toEqual([])
  daemon.roomDoc.removeClaim(withDigest.id)
  const withoutDigest = daemon.roomDoc.addClaim({ path: 'app.txt', from: 1, to: 1, by: 'Alice', byKind: 'agent', intent: 'edit' })
  probe.blobChecks.length = 0
  probe.blobReads.length = 0
  const second = await internal.snapshotOwnClaims(git(dir, 'rev-parse', 'HEAD'))
  expect(probe.blobChecks).toEqual([['app.txt']])
  expect(probe.blobReads).toEqual([])
  expect(second.find(c => c.id === withoutDigest.id)?.claimedHash).toBeUndefined()
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
