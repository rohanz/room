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
  const oldHead = daemon.base
  const claim = daemon.roomDoc.addClaim({ path: 'app.txt', from: 2, to: 2, by: 'Alice', byKind: 'agent', intent: 'edit', claimedHash: claimDigest(original, 2, 2) })
  fs.writeFileSync(path.join(dir, 'app.txt'), 'added\n' + original)
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'move block')
  return { oldHead, newHead: git(dir, 'rev-parse', 'HEAD'), claim, retries }
}

it('retries an injected Git failure through the whole HEAD transition', async () => {
  const { oldHead, newHead, claim, retries } = await movedHead()
  probe.failTracked = true
  const queued = daemon as Roomd & { enqueue(work: () => Promise<void>): Promise<void> }
  await queued.enqueue(async () => { await (daemon as Roomd & { pollHead(): Promise<void> }).pollHead() })
  expect(daemon!.base).toBe(oldHead)
  expect(daemon!.roomDoc.baseOf('Alice')).toBe(oldHead)
  expect(retries).toHaveLength(1)
  retries.shift()!()
  await queued.enqueue(async () => {})
  expect(daemon!.base).toBe(newHead)
  expect(daemon!.roomDoc.baseOf('Alice')).toBe(newHead)
  expect(daemon!.roomDoc.claims.get(claim.id)).toMatchObject({ from: 3, to: 3 })
})

it('does not skip a second poll after a failed HEAD transition', async () => {
  const { oldHead, newHead, claim } = await movedHead()
  probe.failTracked = true
  await expect((daemon as Roomd & { pollHead(): Promise<void> }).pollHead()).rejects.toThrow('injected git ls-files failure')
  expect(daemon!.base).toBe(oldHead)
  await (daemon as Roomd & { pollHead(): Promise<void> }).pollHead()
  expect(daemon!.base).toBe(newHead)
  expect(daemon!.roomDoc.claims.get(claim.id)).toMatchObject({ from: 3, to: 3 })
})

it('publishes the new base only after reconciling the new HEAD overlays', async () => {
  const { oldHead, newHead } = await movedHead()
  fs.writeFileSync(path.join(dir!, 'app.txt'), 'dirty after commit\n')
  let baseDuringPublish: string | undefined
  ;(daemon as Roomd & { beforePublishWrite: (path: string) => Promise<void> }).beforePublishWrite = async () => {
    baseDuringPublish = daemon!.roomDoc.baseOf('Alice')
  }
  await (daemon as Roomd & { pollHead(): Promise<void> }).pollHead()
  expect(baseDuringPublish).toBe(oldHead)
  expect(daemon!.roomDoc.baseOf('Alice')).toBe(newHead)
  expect(daemon!.roomDoc.overlayText('Alice', 'app.txt')?.toString()).toBe('dirty after commit\n')
})
