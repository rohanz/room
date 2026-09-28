import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import { digestPath, manifestKey, participantRecord } from '@room/shared'
import { startRoomd, type Roomd } from '../src/index.js'
import { policyFromLevel } from '../src/policy.js'

vi.setConfig({ testTimeout: 30000 })
const roots: string[] = []
const daemons: Roomd[] = []
afterEach(async () => { for (const d of daemons.splice(0)) await d.stop(); for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }) })
const sh = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
function provider(doc: Y.Doc): WebsocketProvider {
  let state: unknown = null
  return { synced: true, awareness: { getLocalState: () => state, setLocalState: (s: unknown) => { state = s }, getStates: () => new Map([[doc.clientID, state]]) }, on() {}, off() {}, destroy() {} } as unknown as WebsocketProvider
}
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-policy-publish-'))
  roots.push(dir)
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'user.name', 'Test'); sh(dir, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(dir, 'x'), 'base')
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'base')
  const daemon = await startRoomd({ dir, room: 'ws://memory/local/r/main', localKey: 'test', name: 'Ben', sessionId: 's1', policy: policyFromLevel('full'),
    providerFactory: (_s, _n, doc) => provider(doc), basePollMs: 0, trackedRefreshMs: 60000, log: () => {} })
  daemons.push(daemon)
  return { dir, daemon, entries: () => daemon.roomDoc.manifest.get(manifestKey('Ben', 's1'))! }
}

it('withdraws a path synchronously when policy narrows during an awaited base read', async () => {
  const { dir, daemon, entries } = await fixture()
  fs.writeFileSync(path.join(dir, 'x'), 'private')
  let entered!: () => void, release!: () => void
  const reached = new Promise<void>(resolve => { entered = resolve })
  const parked = new Promise<void>(resolve => { release = resolve })
  ;(daemon as any).beforeBaseRead = async () => { entered(); await parked }
  const work = (daemon as any).publisher.reconcile('all') as Promise<unknown>
  await reached
  daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('intent') })
  expect(entries().size).toBe(0)
  release(); await work
  expect(entries().size).toBe(0)
  expect(daemon.roomDoc.overlayText('Ben', 'x')).toBeUndefined()
})

it('turns a changed ignored path into a digest even when the rule changes during a base read', async () => {
  const { dir, daemon, entries } = await fixture()
  fs.writeFileSync(path.join(dir, 'x'), 'private')
  let entered!: () => void, release!: () => void
  const reached = new Promise<void>(resolve => { entered = resolve })
  const parked = new Promise<void>(resolve => { release = resolve })
  ;(daemon as any).beforeBaseRead = async () => { entered(); await parked }
  const work = (daemon as any).publisher.reconcile('all') as Promise<unknown>
  await reached
  fs.writeFileSync(path.join(dir, '.roomignore'), 'x\n')
  ;(daemon as any).reloadRoomIgnore()
  release(); await work
  ;(daemon as any).beforeBaseRead = undefined
  await (daemon as any).publisher.reconcile('all')
  expect(entries().has('x')).toBe(false)
  expect(daemon.roomDoc.manifestHead.get('Ben')?.excluded).toContain(digestPath(daemon.roomDoc.roomSalt!, 'x'))
})

it('commits a moved HEAD and its completed manifest in one Y transaction', async () => {
  const { dir, daemon } = await fixture()
  const observed: Array<{ base?: string; manifest?: string; complete?: boolean }> = []
  daemon.roomDoc.doc.on('afterTransaction', () => {
    const git = participantRecord(daemon.roomDoc, 'Ben')?.git
    const manifest = daemon.roomDoc.manifestHead.get('Ben')
    if (manifest?.complete) observed.push({ base: git?.base, manifest: manifest.base, complete: manifest.complete })
  })
  fs.writeFileSync(path.join(dir, 'x'), 'committed')
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'move')
  await (daemon as any).pollHead()
  expect(observed.length).toBeGreaterThan(0)
  expect(observed.every(s => s.base === s.manifest)).toBe(true)
})
