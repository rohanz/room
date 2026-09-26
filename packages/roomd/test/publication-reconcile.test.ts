import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd, type Roomd, type RoomdOptions } from '../src/index.js'

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
const provider = (doc: Y.Doc) => {
  let local: unknown = null
  return { synced: true, awareness: { setLocalState(value: unknown) { local = value }, getLocalState: () => local, getStates: () => new Map([[doc.clientID, local]]) }, on() {}, off() {}, destroy() {} } as unknown as WebsocketProvider
}
let dir: string | undefined
let daemon: Roomd | undefined
afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function repo(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-level-reconcile-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(dir, 'app.txt'), 'base\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base')
  return dir
}

function options(extra: Partial<RoomdOptions> = {}): RoomdOptions {
  return { dir: repo(), room: 'ws://memory/level-reconcile', name: 'Alice', providerFactory: (_s, _n, doc) => provider(doc),
    basePollMs: 60_000, trackedRefreshMs: 60_000, log: () => {}, ...extra }
}

it('publishes an edit between the startup scan and watcher readiness', async () => {
  const config = options()
  config.beforeWatcherReady = () => { fs.writeFileSync(path.join(config.dir, 'app.txt'), 'startup edit\n') }
  daemon = await startRoomd(config)
  expect(daemon.roomDoc.overlayText('Alice', 'app.txt')?.toString()).toBe('startup edit\n')
})

it('publishes an edit with no watcher event on the periodic reconcile and cancels the timer on stop', async () => {
  let tick: (() => void) | undefined
  let cancelled = false
  const config = options({ reconcileIntervalMs: 60_000,
    periodicReconcileSchedule: (run, ms) => { expect(ms).toBe(60_000); tick = run; return () => { cancelled = true } },
  })
  daemon = await startRoomd(config)
  const internal = daemon as Roomd & { watcher: { removeAllListeners(name: string): void }; enqueue(work: () => Promise<void>): Promise<void> }
  internal.watcher.removeAllListeners('all')
  fs.writeFileSync(path.join(config.dir, 'app.txt'), 'missed edit\n')
  expect(daemon.roomDoc.overlayText('Alice', 'app.txt')).toBeUndefined()
  tick!()
  await internal.enqueue(async () => {})
  expect(daemon.roomDoc.overlayText('Alice', 'app.txt')?.toString()).toBe('missed edit\n')
  await daemon.stop()
  expect(cancelled).toBe(true)
})

it('skips a periodic tick while its previous reconcile is in flight', async () => {
  let tick: (() => void) | undefined
  const config = options({ periodicReconcileSchedule: run => { tick = run; return () => {} } })
  daemon = await startRoomd(config)
  const internal = daemon as Roomd & { watcher: { removeAllListeners(name: string): void }; enqueue(work: () => Promise<void>): Promise<void>; beforePublishWrite: () => Promise<void> }
  internal.watcher.removeAllListeners('all')
  fs.writeFileSync(path.join(config.dir, 'app.txt'), 'missed edit\n')
  let started!: () => void, release!: () => void
  const publishing = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let writes = 0
  internal.beforePublishWrite = async () => { writes++; started(); await held }
  tick!()
  await publishing
  tick!()
  release()
  await internal.enqueue(async () => {})
  expect(writes).toBe(1)
  expect(daemon.roomDoc.overlayText('Alice', 'app.txt')?.toString()).toBe('missed edit\n')
})
