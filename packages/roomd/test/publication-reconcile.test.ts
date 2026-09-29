import { incarnationText } from './manifest-assert.js'
import { policyFromLevel } from '../src/policy.js'
import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { RoomDoc, manifestKey } from '@room/shared'
import { MAX_PUBLICATION_PATHS } from '../src/policy.js'
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
  return { dir: repo(), room: 'ws://memory/level-reconcile', name: 'Alice', policy: policyFromLevel('full'), providerFactory: (_s, _n, doc) => provider(doc),
    basePollMs: 60_000, trackedRefreshMs: 60_000, log: () => {}, ...extra }
}

it('publishes an edit between the startup scan and watcher readiness', async () => {
  const config = options()
  config.beforeWatcherReady = () => { fs.writeFileSync(path.join(config.dir, 'app.txt'), 'startup edit\n') }
  daemon = await startRoomd(config)
  expect(incarnationText(daemon.roomDoc, 'Alice', 'app.txt')?.toString()).toBe('startup edit\n')
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
  expect(incarnationText(daemon.roomDoc, 'Alice', 'app.txt')).toBeUndefined()
  tick!()
  await internal.enqueue(async () => {})
  expect(incarnationText(daemon.roomDoc, 'Alice', 'app.txt')?.toString()).toBe('missed edit\n')
  await daemon.stop()
  expect(cancelled).toBe(true)
})

it('coalesces a periodic tick into one follow-up while reconciliation is in flight', async () => {
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
  expect(writes).toBe(2)
  expect(incarnationText(daemon.roomDoc, 'Alice', 'app.txt')?.toString()).toBe('missed edit\n')
})

it('lets queued work run between reconcile batches while requests keep arriving', async () => {
  daemon = await startRoomd(options())
  const internal = daemon as Roomd & { enqueue(work: () => Promise<void>): Promise<void>; publisher: { reconcile(): Promise<unknown> } }
  const events: string[] = [], requests: Promise<void>[] = []
  let finish!: () => void
  const finalPass = new Promise<void>(resolve => { finish = resolve })
  let passes = 0
  internal.publisher.reconcile = async () => {
    const at = ++passes
    events.push(`pass ${at}`)
    if (at >= 25) { finish(); return }
    requests.push(internal.reconcileGitChanges().then(() => { expect(passes).toBeGreaterThan(at) }))
    void internal.enqueue(async () => { events.push(`other ${at}`) })
  }
  const first = internal.reconcileGitChanges()
  await finalPass
  await first
  await Promise.all(requests)
  expect(passes).toBe(25)
  let consecutive = 0
  for (const event of events) {
    consecutive = event.startsWith('pass') ? consecutive + 1 : 0
    expect(consecutive).toBeLessThanOrEqual(2)
  }
  expect(events.indexOf('other 2')).toBeLessThan(events.indexOf('pass 3'))
}, 30_000)

it('yields to an event-loop turn while preparing a many-file atomic publication', async () => {
  const config = options()
  const paths = Array.from({ length: 72 }, (_, i) => `file-${i}.txt`)
  for (const p of paths) fs.writeFileSync(path.join(config.dir, p), 'base\n')
  git(config.dir, 'add', '-A'); git(config.dir, 'commit', '-qm', 'many files')
  daemon = await startRoomd(config)
  const internal = daemon as Roomd & { watcher: { removeAllListeners(name: string): void } }
  internal.watcher.removeAllListeners('all')
  for (const p of paths) fs.writeFileSync(path.join(config.dir, p), 'changed\n')
  const events: string[] = []
  const original = RoomDoc.prototype.prepareOverlayDiff
  let prepared = 0
  let followUp: Promise<void> | undefined
  const spy = vi.spyOn(RoomDoc.prototype, 'prepareOverlayDiff').mockImplementation(function (person, relpath, text, stats) {
    if (++prepared === 1) setImmediate(() => {
      events.push('timer')
      fs.writeFileSync(path.join(config.dir, paths[0]), 'latest\n')
      followUp = daemon!.reconcileGitChanges()
    })
    return original.call(this, person, relpath, text, stats)
  })
  try {
    await daemon.reconcileGitChanges()
    await followUp
    events.push('published')
    expect(events).toEqual(['timer', 'published'])
    expect(prepared).toBeGreaterThanOrEqual(paths.length)
    for (const p of paths) expect(incarnationText(daemon.roomDoc, 'Alice', p)?.toString()).toBe(p === paths[0] ? 'latest\n' : 'changed\n')
  } finally { spy.mockRestore() }
})

it('publishes exact large rewrites with a bounded diff work budget', async () => {
  const config = options()
  daemon = await startRoomd(config)
  const internal = daemon as Roomd & { watcher: { removeAllListeners(name: string): void } }
  internal.watcher.removeAllListeners('all')
  const oldJson = JSON.stringify({ rows: 'a'.repeat(60_000) })
  const newJson = JSON.stringify({ rows: 'b'.repeat(60_000) })
  const oldLines = Array.from({ length: 800 }, (_, i) => `line ${i}: ${'x'.repeat(45)}`).join('\n') + '\n'
  const newLines = Array.from({ length: 800 }, (_, i) => `line ${i}: ${'y'.repeat(45)}`).join('\n') + '\n'
  fs.writeFileSync(path.join(config.dir, 'blob.json'), oldJson)
  fs.writeFileSync(path.join(config.dir, 'lines.txt'), oldLines)
  await daemon.reconcileGitChanges()
  const measured = new Map<string, number>()
  const original = RoomDoc.prototype.prepareOverlayDiff
  const spy = vi.spyOn(RoomDoc.prototype, 'prepareOverlayDiff').mockImplementation(function (person, relpath, text) {
    const stats = { work: 0, charCalls: 0, lineCalls: 0 }
    const result = original.call(this, person, relpath, text, stats)
    measured.set(relpath, stats.work)
    return result
  })
  try {
    fs.writeFileSync(path.join(config.dir, 'blob.json'), newJson)
    fs.writeFileSync(path.join(config.dir, 'lines.txt'), newLines)
    await daemon.reconcileGitChanges()
    expect(incarnationText(daemon.roomDoc, 'Alice', 'blob.json')?.toString()).toBe(newJson)
    expect(incarnationText(daemon.roomDoc, 'Alice', 'lines.txt')?.toString()).toBe(newLines)
    expect([...measured.keys()]).toEqual(expect.arrayContaining(['blob.json', 'lines.txt']))
    for (const work of measured.values()) expect(work).toBeLessThanOrEqual(2_000_000)
  } finally { spy.mockRestore() }
})

it('applies the prepared text operations when the overlay has not changed', async () => {
  const config = options()
  daemon = await startRoomd(config)
  fs.writeFileSync(path.join(config.dir, 'app.txt'), 'new text\n')
  const publisher = (daemon as unknown as { publisher: { prepare(): Promise<any>; apply(prepared: any, complete: boolean): boolean } }).publisher
  const prepared = await publisher.prepare()
  const item = prepared.textOps.get('app.txt')!
  let iterations = 0
  prepared.textOps.set('app.txt', { ...item, ops: new Proxy(item.ops, {
    get(target, key, receiver) {
      if (key === Symbol.iterator) { iterations++; return target[Symbol.iterator].bind(target) }
      return Reflect.get(target, key, receiver)
    },
  }) })
  expect(publisher.apply(prepared, true)).toBe(true)
  expect(iterations).toBe(1)
  expect(incarnationText(daemon.roomDoc, 'Alice', 'app.txt')?.toString()).toBe('new text\n')
})

it('yields while validating every text path before the atomic apply', async () => {
  const config = options()
  const paths = Array.from({ length: 96 }, (_, i) => `gate-${String(i).padStart(3, '0')}.txt`)
  for (const p of paths) fs.writeFileSync(path.join(config.dir, p), 'changed\n')
  daemon = await startRoomd(config)
  const publisher = (daemon as unknown as { publisher: { prepare(): Promise<any>; validatePrepared(prepared: any): Promise<boolean> } }).publisher
  const prepared = await publisher.prepare()
  const events: string[] = []
  const stat = fs.lstatSync
  let checked = 0
  const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, options?: unknown) => {
    if (String(p).includes('gate-') && ++checked === 1) setImmediate(() => {
      events.push('timer')
      fs.writeFileSync(path.join(config.dir, paths.at(-1)!), 'changed again\n')
    })
    return (stat as any)(p, options)
  }) as typeof fs.lstatSync)
  try {
    expect(await publisher.validatePrepared(prepared)).toBe(false)
    events.push('validated')
    expect(events).toEqual(['timer', 'validated'])
    expect(checked).toBeGreaterThan(32)
  } finally { spy.mockRestore() }
})

it('marks coverage incomplete instead of accepting an oversized policy-narrowing transaction', async () => {
  daemon = await startRoomd(options())
  const map = daemon.roomDoc.manifest.get(manifestKey('Alice', daemon.fence!))!
  for (let i = 0; i <= MAX_PUBLICATION_PATHS; i++) map.set(`bulk/${i}`, { change: 'M', state: 'held', held: 'scope', at: 1, fence: daemon.fence! })
  daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('intent') })
  expect(daemon.roomDoc.manifestHead.get('Alice')).toMatchObject({ complete: false, coverage: { kind: 'none', reason: 'starting' } })
})
