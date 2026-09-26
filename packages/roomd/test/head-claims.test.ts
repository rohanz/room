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
  expect(own.claimedHash).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(own)).not.toContain('claimed one')

  fs.writeFileSync(file, 'added\n'.repeat(5) + before)
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'move block')
  await (daemon as unknown as { pollHead(): Promise<void> }).pollHead()
  expect(doc.claims.get(own.id)).toMatchObject({ from: 7, to: 8 })
  expect(doc.claims.get(other.id)).toEqual(other)

  fs.writeFileSync(file, 'first\nlast\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'delete block')
  const commit = git(root, 'rev-parse', '--short=10', 'HEAD')
  await (daemon as unknown as { pollHead(): Promise<void> }).pollHead()
  expect(doc.claims.get(own.id)).toBeUndefined()
  expect(doc.claims.get(other.id)).toEqual(other)
  expect(doc.messages()).toContainEqual(expect.objectContaining({
    type: 'note', from: 'room', to: 'Alice', priority: 'notify',
    text: `released your claim on app.txt:7-8: that code changed in ${commit}`,
  }))
})

for (const addedAbove of [0, 5]) {
  it(`keeps an edited claim after commit with ${addedAbove} lines inserted above`, async () => {
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

    expect(doc.claims.get(claim.id)).toMatchObject({ from: 10 + addedAbove, to: 12 + addedAbove,
      claimedHash: claimDigest(after, 10 + addedAbove, 12 + addedAbove) })
    expect(doc.messages().filter(m => m.type === 'note' && m.to === 'Alice')).toHaveLength(0)
  })
}
