import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd, type Roomd } from '../src/index.js'
import { claimDigest } from '../src/reanchor.js'

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
let root: string | undefined
let daemon: Roomd | undefined
afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = undefined
})

function provider(doc: Y.Doc): WebsocketProvider {
  let local: unknown = null
  const states = new Map<number, unknown>()
  return {
    synced: true,
    awareness: {
      setLocalState(state: unknown) { local = state; if (state) states.set(doc.clientID, state); else states.delete(doc.clientID) },
      getLocalState: () => local,
      getStates: () => states,
    },
    on() {}, off() {}, destroy() {},
  } as unknown as WebsocketProvider
}

it('revalidates only its own claims when HEAD moves, retaining a moved block and notifying for a deleted one', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-head-claims-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  const file = path.join(root, 'app.txt')
  const before = 'first\nclaimed one\nclaimed two\nlast\n'
  fs.writeFileSync(file, before)
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'base')
  daemon = await startRoomd({ dir: root, room: 'ws://memory/claims', name: 'Alice', kind: 'agent',
    providerFactory: (_server, _name, doc) => provider(doc), basePollMs: 60_000, trackedRefreshMs: 60_000, log: () => {},
  })
  const doc = daemon.roomDoc
  const claimedHash = claimDigest(before, 2, 3)
  const own = doc.addClaim({ path: 'app.txt', from: 2, to: 3, by: 'Alice', byKind: 'agent', intent: 'edit', claimedHash })
  const other = doc.addClaim({ path: 'app.txt', from: 2, to: 3, by: 'Bob', byKind: 'agent', intent: 'edit', claimedHash })
  const mirror = doc.addClaim({ path: 'app.txt', from: 2, to: 3, by: 'Alice', byKind: 'agent', intent: '[worker] edit', mirrorOf: 'worker', claimedHash })
  expect(own.claimedHash).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(own)).not.toContain('claimed one')

  fs.writeFileSync(file, 'added\n'.repeat(5) + before)
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'move block')
  await (daemon as unknown as { pollHead(): Promise<void> }).pollHead()
  expect(doc.claims.get(own.id)).toMatchObject({ from: 7, to: 8 })
  expect(doc.claims.get(other.id)).toEqual(other)
  expect(doc.claims.get(mirror.id)).toEqual(mirror)

  fs.writeFileSync(file, 'first\nlast\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'delete block')
  const commit = git(root, 'rev-parse', '--short=10', 'HEAD')
  await (daemon as unknown as { pollHead(): Promise<void> }).pollHead()
  expect(doc.claims.get(own.id)).toBeUndefined()
  expect(doc.claims.get(other.id)).toEqual(other)
  expect(doc.claims.get(mirror.id)).toEqual(mirror)
  expect(doc.messages()).toContainEqual(expect.objectContaining({
    type: 'note', from: 'room', to: 'Alice', priority: 'notify',
    text: `released your claim on app.txt:7-8: that code changed in ${commit}`,
  }))
})

it('keeps the claim-time digest when a later overlay has unrelated lines at an unanchored claim', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-claim-digest-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  const file = path.join(root, 'app.txt')
  const before = Array.from({ length: 18 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  fs.writeFileSync(file, before)
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base')
  daemon = await startRoomd({ dir: root, room: 'ws://memory/digest', name: 'Alice', kind: 'agent',
    providerFactory: (_server, _name, doc) => provider(doc), basePollMs: 60_000, trackedRefreshMs: 60_000, log: () => {},
  })
  const doc = daemon.roomDoc
  const digest = claimDigest(before, 10, 12)!
  const claim = doc.addClaim({ path: 'app.txt', from: 10, to: 12, by: 'Alice', byKind: 'agent', intent: 'edit', claimedHash: digest })
  expect(claim.anchor).toBeUndefined()
  const after = 'inserted\n'.repeat(5) + before
  doc.setOverlay('Alice', 'app.txt', after)
  expect(doc.claimRange(claim)).toEqual({ from: 10, to: 12 })
  fs.writeFileSync(file, after)
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'insert above claim')
  await (daemon as unknown as { pollHead(): Promise<void> }).pollHead()
  expect(doc.claims.get(claim.id)).toMatchObject({ from: 15, to: 17, claimedHash: digest })
})

for (const addedAbove of [0, 5]) {
  it(`releases an edited claim after commit with ${addedAbove} lines inserted above`, async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-head-edit-'))
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'config', 'user.email', 'test@example.com')
    git(root, 'config', 'user.name', 'Test')
    const file = path.join(root, 'app.txt')
    const before = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    fs.writeFileSync(file, before)
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'base')
    daemon = await startRoomd({ dir: root, room: 'ws://memory/claim-edit', name: 'Alice', kind: 'agent',
      providerFactory: (_server, _name, doc) => provider(doc), basePollMs: 60_000, trackedRefreshMs: 60_000, log: () => {},
    })
    const doc = daemon.roomDoc
    doc.setOverlay('Alice', 'app.txt', before)
    const claim = doc.addClaim({ path: 'app.txt', from: 10, to: 12, by: 'Alice', byKind: 'agent', intent: 'edit', claimedHash: claimDigest(before, 10, 12) })
    const edited = before.replace('line 11\n', 'line 11 edited\n')
    const after = 'new line\n'.repeat(addedAbove) + edited
    doc.setOverlay('Alice', 'app.txt', after)
    fs.writeFileSync(file, after)
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'edit claimed block')

    await (daemon as unknown as { pollHead(): Promise<void> }).pollHead()

    expect(doc.claims.get(claim.id)).toBeUndefined()
    expect(doc.messages().filter(m => m.type === 'note' && m.to === 'Alice')).toHaveLength(1)
  })
}

async function pulledClaim(incomingPath: 'app.txt' | 'other.txt', incomingLine: number, transient = true, shifted = false, claimBeforeEdit = false, localEditLine = 6) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-autostash-'))
  const remote = path.join(root, 'remote.git')
  const local = path.join(root, 'local')
  const peer = path.join(root, 'peer')
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(root, 'clone', '-q', remote, local)
  git(local, 'config', 'user.email', 'test@example.com')
  git(local, 'config', 'user.name', 'Test')
  const original = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  fs.writeFileSync(path.join(local, 'app.txt'), original)
  fs.writeFileSync(path.join(local, 'other.txt'), original)
  git(local, 'add', '-A'); git(local, 'commit', '-qm', 'base'); git(local, 'push', '-q', 'origin', 'HEAD:main')
  git(root, 'clone', '-q', remote, peer)
  git(peer, 'config', 'user.email', 'peer@example.com')
  git(peer, 'config', 'user.name', 'Peer')
  const logs: string[] = []
  daemon = await startRoomd({ dir: local, room: 'ws://memory/autostash', name: 'Alice', kind: 'agent',
    providerFactory: (_server, _name, doc) => provider(doc), basePollMs: 60_000, trackedRefreshMs: 60_000, log: line => logs.push(line),
  })
  const edited = shifted ? 'mine\n'.repeat(5) + original.replace('line 11\n', 'my line 11\n') : original.replace(`line ${localEditLine}\n`, `my line ${localEditLine}\n`)
  const from = shifted ? 15 : 6
  const to = shifted ? 19 : 6
  const claim = claimBeforeEdit
    ? daemon.roomDoc.addClaim({ path: 'app.txt', from, to, by: 'Alice', byKind: 'agent', intent: 'edit', claimedHash: claimDigest(original, from, to) })
    : undefined
  fs.writeFileSync(path.join(local, 'app.txt'), edited)
  daemon.roomDoc.setOverlay('Alice', 'app.txt', edited)
  const actualClaim = claim ?? daemon.roomDoc.addClaim({ path: 'app.txt', from, to, by: 'Alice', byKind: 'agent', intent: 'edit', claimedHash: claimDigest(edited, from, to) })
  const changed = incomingLine === 0 ? 'peer insertion\n' + original : original.replace(`line ${incomingLine}\n`, `peer line ${incomingLine}\n`)
  fs.writeFileSync(path.join(peer, incomingPath), changed)
  git(peer, 'add', '-A'); git(peer, 'commit', '-qm', 'peer edit'); git(peer, 'push', '-q', 'origin', 'HEAD:main')
  // Hold Git's autostash marker across a deterministic clean-tree phase.
  // The direct-pull case below uses Git's own autostash end to end.
  if (transient) git(local, 'stash', 'push', '-q')
  git(local, 'pull', '-q', '--ff-only', '--autostash')
  let restore: Promise<void> | undefined
  if (transient) {
    const marker = path.join(local, '.git', 'MERGE_AUTOSTASH')
    fs.writeFileSync(marker, 'autostash in progress\n')
    restore = new Promise<void>((resolve, reject) => setTimeout(() => {
      try { git(local, 'stash', 'pop', '-q'); fs.rmSync(marker); resolve() } catch (error) { reject(error) }
    }, 200))
  }
  await (daemon as unknown as { pollHead(): Promise<void> }).pollHead()
  await restore
  return { local, claim: actualClaim, edited, logs }
}

it('keeps a claim made before editing its lines through a real autostash pull on other lines', async () => {
  const { local, claim, edited, logs } = await pulledClaim('app.txt', 20, false, false, true)
  expect(fs.readFileSync(path.join(local, 'app.txt'), 'utf8')).toContain('my line 6')
  expect(edited).toContain('my line 6')
  expect(daemon!.roomDoc.claims.get(claim.id)).toEqual(claim)
  expect(daemon!.roomDoc.messages().filter(m => m.type === 'note' && m.to === 'Alice')).toEqual([])
  expect(logs.filter(line => line.startsWith('kept claim on app.txt:6-6 after '))).toHaveLength(1)
})

it('conservatively keeps a pre-edit claim when a teammate rewrites its lines and local edits are elsewhere', async () => {
  const { local, claim, logs } = await pulledClaim('app.txt', 6, false, false, true, 20)
  expect(fs.readFileSync(path.join(local, 'app.txt'), 'utf8')).toContain('peer line 6')
  expect(daemon!.roomDoc.claims.get(claim.id)).toEqual(claim)
  expect(logs.filter(line => line.startsWith('kept claim on app.txt:6-6 after '))).toHaveLength(1)
})

it('keeps an edited claim when a pull changes other lines in the same file', async () => {
  const { claim } = await pulledClaim('app.txt', 10)
  expect(daemon!.roomDoc.claims.get(claim.id)).toBeDefined()
})

it('keeps an edited claim when a pull does not touch its file', async () => {
  const { claim } = await pulledClaim('other.txt', 10)
  expect(daemon!.roomDoc.claims.get(claim.id)).toBeDefined()
})

it('moves an edited claim when a pull inserts lines above it', async () => {
  const { claim } = await pulledClaim('app.txt', 0)
  expect(daemon!.roomDoc.claims.get(claim.id)).toMatchObject({ from: 7, to: 7 })
})

it('keeps an edited claim through a real pull --ff-only --autostash', async () => {
  const { local, claim, edited } = await pulledClaim('other.txt', 10, false)
  expect(fs.readFileSync(path.join(local, 'app.txt'), 'utf8')).toBe(edited)
  expect(daemon!.roomDoc.claims.get(claim.id)).toBeDefined()
})

it('keeps a working-tree shifted claim when the incoming hunk only overlaps its working coordinates', async () => {
  const { local, claim, edited } = await pulledClaim('app.txt', 17, false, true)
  expect(fs.readFileSync(path.join(local, 'app.txt'), 'utf8')).toContain('my line 11')
  expect(daemon!.roomDoc.claims.get(claim.id)).toMatchObject({ from: 15, to: 19, claimedHash: claimDigest(edited, 15, 19) })
})

it('waits for an in-progress autostash before publishing the new HEAD', async () => {
  const { local, claim, edited } = await pulledClaim('other.txt', 10)
  // A second incoming commit gives the daemon a new transition to reconcile.
  const peer = path.join(root!, 'peer')
  fs.writeFileSync(path.join(peer, 'other.txt'), 'another line\n')
  git(peer, 'add', '-A'); git(peer, 'commit', '-qm', 'another peer edit'); git(peer, 'push', '-q', 'origin', 'HEAD:main')
  git(local, 'pull', '-q', '--ff-only', '--autostash')
  git(local, 'stash', 'push', '-q')
  const marker = path.join(local, '.git', 'MERGE_AUTOSTASH')
  fs.writeFileSync(marker, 'autostash in progress\n')
  const restore = new Promise<void>((resolve, reject) => setTimeout(() => {
    try { git(local, 'stash', 'pop', '-q'); fs.rmSync(marker); resolve() } catch (error) { reject(error) }
  }, 200))
  await (daemon as unknown as { pollHead(): Promise<void> }).pollHead()
  await restore
  expect(daemon!.roomDoc.claims.get(claim.id)).toBeDefined()
  expect(daemon!.roomDoc.overlayText('Alice', 'app.txt')?.toString()).toBe(edited)
})

it('releases a claim when an incoming commit changes its claimed line', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-incoming-claim-'))
  const local = path.join(root, 'local')
  const peer = path.join(root, 'peer')
  git(root, 'init', '-q', '--bare', '-b', 'main', path.join(root, 'remote.git'))
  git(root, 'clone', '-q', path.join(root, 'remote.git'), local)
  git(local, 'config', 'user.email', 'test@example.com'); git(local, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(local, 'app.txt'), 'first\nclaimed\nlast\n')
  git(local, 'add', '-A'); git(local, 'commit', '-qm', 'base'); git(local, 'push', '-q', 'origin', 'HEAD:main')
  git(root, 'clone', '-q', path.join(root, 'remote.git'), peer)
  git(peer, 'config', 'user.email', 'peer@example.com'); git(peer, 'config', 'user.name', 'Peer')
  daemon = await startRoomd({ dir: local, room: 'ws://memory/incoming-claim', name: 'Alice', kind: 'agent',
    providerFactory: (_server, _name, doc) => provider(doc), basePollMs: 60_000, trackedRefreshMs: 60_000, log: () => {},
  })
  const claim = daemon.roomDoc.addClaim({ path: 'app.txt', from: 2, to: 2, by: 'Alice', byKind: 'agent', intent: 'edit', claimedHash: claimDigest('first\nclaimed\nlast\n', 2, 2) })
  fs.writeFileSync(path.join(peer, 'app.txt'), 'first\npeer change\nlast\n')
  git(peer, 'add', '-A'); git(peer, 'commit', '-qm', 'change claimed line'); git(peer, 'push', '-q', 'origin', 'HEAD:main')
  git(local, 'pull', '-q', '--ff-only', '--autostash')
  const commit = git(local, 'rev-parse', '--short=10', 'HEAD')
  await (daemon as unknown as { pollHead(): Promise<void> }).pollHead()
  expect(daemon.roomDoc.claims.get(claim.id)).toBeUndefined()
  expect(daemon.roomDoc.messages()).toContainEqual(expect.objectContaining({
    type: 'note', from: 'room', to: 'Alice', text: `released your claim on app.txt:2-2: that code changed in ${commit}`,
  }))
})

it.each(['directory', 'rename'] as const)('releases the old-path claim when a commit replaces its file with a %s', async replacement => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-claim-path-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  const original = 'first\nclaimed\nlast\n'
  fs.writeFileSync(path.join(root, 'app.txt'), original)
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base')
  daemon = await startRoomd({ dir: root, room: 'ws://memory/claim-path', name: 'Alice', kind: 'agent',
    providerFactory: (_server, _name, doc) => provider(doc), basePollMs: 60_000, trackedRefreshMs: 60_000, log: () => {},
  })
  const claim = daemon.roomDoc.addClaim({ path: 'app.txt', from: 2, to: 2, by: 'Alice', byKind: 'agent', intent: 'edit', claimedHash: claimDigest(original, 2, 2) })
  if (replacement === 'rename') git(root, 'mv', 'app.txt', 'moved.txt')
  else {
    git(root, 'rm', '-q', 'app.txt')
    fs.mkdirSync(path.join(root, 'app.txt'))
    fs.writeFileSync(path.join(root, 'app.txt', 'child.txt'), 'new\n')
    git(root, 'add', '-A')
  }
  git(root, 'commit', '-qm', 'replace claimed path')
  const head = git(root, 'rev-parse', 'HEAD')
  await (daemon as unknown as { pollHead(): Promise<void> }).pollHead()
  expect(daemon.roomDoc.baseOf('Alice')).toBe(head)
  expect(daemon.roomDoc.claims.get(claim.id)).toBeUndefined()
})
