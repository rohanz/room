import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import { manifestPaths, manifestText } from './manifest-assert.js'
import { startRoomd, type Roomd } from '../src/index.js'
import { policyFromLevel } from '../src/policy.js'
import { readRoomFile, roomFilePath } from '../src/room-file.js'
import { ROOMIGNORE_MAX_BYTES, ROOMIGNORE_MAX_PATTERNS } from '../src/roomignore.js'

// A .roomignore that cannot be read must never widen sharing (cleanliness review 2026-11-04, finding 1 and R1).
const roots: string[] = []
const daemons: Roomd[] = []
beforeAll(() => vi.stubEnv('CHOKIDAR_USEPOLLING', '1'))
afterAll(() => vi.unstubAllEnvs())
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop()
  for (const r of roots.splice(0)) { try { fs.chmodSync(path.join(r, '.roomignore'), 0o644) } catch { /* absent */ } fs.rmSync(r, { recursive: true, force: true }) }
})
// chmod 000 does not stop root, and Windows has no POSIX modes.
const unreadable = process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it

// .roomignore stays untracked (and gitignored) so the unreadable file is not itself a failed publication read.
function checkout(files: Record<string, string>, local: Record<string, string> = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-ignore-policy-')))
  roots.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
  for (const [p, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, p), value)
  git('add', '-f', '--', ...Object.keys(files)); git('commit', '-qm', 'base')
  for (const [p, value] of Object.entries(local)) fs.writeFileSync(path.join(dir, p), value)
  return dir
}
function provider(doc: Y.Doc): WebsocketProvider {
  let state: unknown = null
  return { synced: true, awareness: { getLocalState: () => state, setLocalState: (s: unknown) => { state = s }, getStates: () => new Map([[doc.clientID, state]]) }, on() {}, off() {}, destroy() {} } as unknown as WebsocketProvider
}
async function start(dir: string, before?: () => void) {
  const logs: string[] = []
  before?.()
  const daemon = await startRoomd({ dir, room: 'ws://memory/local/r', localKey: 'test', name: 'Ben', sessionId: 's1', policy: policyFromLevel('full'),
    providerFactory: (_s, _n, doc) => provider(doc), basePollMs: 0, trackedRefreshMs: 60000, log: line => logs.push(line) })
  daemons.push(daemon)
  const internal = daemon as unknown as { reloadRoomIgnore(): void; refreshTracked(): Promise<void> }
  const reconcile = async () => { await daemon.reconcileGitChanges(); await daemon.settle() }
  const complete = () => daemon.roomDoc.manifestHead.get('Ben')?.complete
  const unavailable = () => logs.filter(line => line.includes('.roomignore') && /unavailable|cannot read|too large|too many/.test(line))
  return { daemon, logs, internal, reconcile, complete, unavailable }
}
const files = { '.gitignore': '.roomignore\n', 'private.txt': 'base\n', 'app.txt': 'a\n' }
const ignore = { '.roomignore': 'private.txt\n' }

unreadable('an unreadable .roomignore keeps the last policy, reports it once and marks publication incomplete', async () => {
  const dir = checkout(files, ignore)
  const { daemon, internal, reconcile, complete, unavailable } = await start(dir)
  fs.writeFileSync(path.join(dir, 'private.txt'), 'secret\n')
  fs.writeFileSync(path.join(dir, 'app.txt'), 'b\n')
  await reconcile()
  expect(manifestPaths(daemon.roomDoc, 'Ben')).toEqual(['app.txt'])

  fs.chmodSync(path.join(dir, '.roomignore'), 0)
  internal.reloadRoomIgnore()
  internal.reloadRoomIgnore()
  await reconcile()
  expect(manifestPaths(daemon.roomDoc, 'Ben')).toEqual(['app.txt'])
  expect(manifestText(daemon.roomDoc, 'private.txt', 'Ben')).toBeUndefined()
  expect(unavailable()).toHaveLength(1)
  expect(complete()).toBe(false)

  fs.chmodSync(path.join(dir, '.roomignore'), 0o644)
  internal.reloadRoomIgnore()
  await reconcile()
  expect(manifestPaths(daemon.roomDoc, 'Ben')).toEqual(['app.txt'])
  expect(complete()).toBe(true)
})

it('deleting .roomignore deliberately selects the empty policy', async () => {
  const dir = checkout(files, ignore)
  const { daemon, internal, reconcile, unavailable } = await start(dir)
  fs.writeFileSync(path.join(dir, 'private.txt'), 'secret\n')
  await reconcile()
  expect(manifestPaths(daemon.roomDoc, 'Ben')).toEqual([])
  fs.rmSync(path.join(dir, '.roomignore'))
  internal.reloadRoomIgnore()
  await reconcile()
  expect(manifestText(daemon.roomDoc, 'private.txt', 'Ben')).toBe('secret\n')
  expect(unavailable()).toEqual([])
})

unreadable('at startup an unreadable .roomignore withholds all file text until it can be read', async () => {
  const dir = checkout(files, ignore)
  fs.writeFileSync(path.join(dir, 'private.txt'), 'secret\n')
  fs.writeFileSync(path.join(dir, 'app.txt'), 'b\n')
  const { daemon, internal, reconcile, complete, unavailable } = await start(dir, () => fs.chmodSync(path.join(dir, '.roomignore'), 0))
  await reconcile()
  expect(manifestPaths(daemon.roomDoc, 'Ben')).toEqual([])
  expect(manifestText(daemon.roomDoc, 'app.txt', 'Ben')).toBeUndefined()
  expect(unavailable()).toHaveLength(1)
  expect(complete()).toBe(false)

  // The periodic tracked refresh retries the read; a readable file then lifts the gate.
  fs.chmodSync(path.join(dir, '.roomignore'), 0o644)
  await internal.refreshTracked()
  await reconcile()
  expect(manifestPaths(daemon.roomDoc, 'Ben')).toEqual(['app.txt'])
  expect(manifestText(daemon.roomDoc, 'app.txt', 'Ben')).toBe('b\n')
  expect(complete()).toBe(true)
})

it.each([
  ['bytes', 'private.txt\n' + `#${'x'.repeat(ROOMIGNORE_MAX_BYTES)}\n`],
  ['patterns', 'private.txt\n' + Array.from({ length: ROOMIGNORE_MAX_PATTERNS }, (_, i) => `p${i}\n`).join('')],
])('an oversized .roomignore (%s) never widens sharing', async (_kind, oversized) => {
  const dir = checkout(files, ignore)
  const { daemon, internal, reconcile, complete, unavailable } = await start(dir)
  fs.writeFileSync(path.join(dir, 'private.txt'), 'secret\n')
  fs.writeFileSync(path.join(dir, 'app.txt'), 'b\n')
  // Mid-run: the last policy stays in force.
  fs.writeFileSync(path.join(dir, '.roomignore'), oversized)
  internal.reloadRoomIgnore()
  await reconcile()
  expect(manifestPaths(daemon.roomDoc, 'Ben')).toEqual(['app.txt'])
  expect(unavailable()).toHaveLength(1)
  expect(complete()).toBe(false)
  await daemon.stop()

  // Startup: no policy is known, so no file text is published.
  const restarted = await start(dir)
  await restarted.reconcile()
  expect(manifestPaths(restarted.daemon.roomDoc, 'Ben')).toEqual([])
  expect(restarted.unavailable()).toHaveLength(1)
})

it('ignores oversized session metadata instead of reading it whole', () => {
  const dir = checkout({ 'app.txt': 'a\n' })
  fs.writeFileSync(roomFilePath(dir), JSON.stringify({ name: 'me', pad: 'x'.repeat(1024 * 1024) }))
  expect(readRoomFile(dir)).toBeUndefined()
})

it('does not append to an oversized Git exclude file', async () => {
  const dir = checkout({ 'app.txt': 'a\n' })
  const exclude = path.join(dir, '.git', 'info', 'exclude')
  fs.mkdirSync(path.dirname(exclude), { recursive: true })
  const big = '#'.repeat(2 * 1024 * 1024) + '\n'
  fs.writeFileSync(exclude, big)
  const { logs } = await start(dir)
  expect(fs.readFileSync(exclude, 'utf8')).toBe(big)
  expect(logs.some(line => line.includes('info/exclude'))).toBe(true)
})
