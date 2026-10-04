import { incarnationText } from './manifest-assert.js'
import { policyFromLevel } from '../src/policy.js'
import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { RoomDoc, manifestKey } from '@room/shared'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd, type Roomd, type RoomdOptions } from '../src/index.js'
import { Publisher } from '../src/publisher.js'
import { rulesFromText } from '../src/policy.js'
import { setGitObserver } from '../src/git.js'
import { checkoutText } from '../src/baseline.js'

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
  const internal = daemon as Roomd & { watcher: { suspend(): void }; enqueue(work: () => Promise<void>): Promise<void> }
  internal.watcher.suspend()
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
  const internal = daemon as Roomd & { watcher: { suspend(): void }; enqueue(work: () => Promise<void>): Promise<void>; beforePublishWrite: () => Promise<void> }
  internal.watcher.suspend()
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
  const internal = daemon as Roomd & { watcher: { suspend(): void } }
  internal.watcher.suspend()
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
  const internal = daemon as Roomd & { watcher: { suspend(): void } }
  internal.watcher.suspend()
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

it('rejects a first validated path changed at a later validation boundary', async () => {
  const checkout = repo()
  const base = git(checkout, 'rev-parse', 'HEAD')
  const roomDoc = new RoomDoc()
  const host: any = { dir: checkout, name: 'Alice', fence: '1', roomDoc, base, stopped: false, phase: 'watch',
    inputs: { policy: policyFromLevel('full'), rules: rulesFromText('', 1024, 1024 * 1024), head: base },
    batch: { published() {} }, skips: { size: new Set(), budget: new Set(), ignore: new Set() },
    log() {}, abs: (p: string) => path.join(checkout, p), isSafeRoomPath: () => true,
    bumpLastActive() {}, reconcileGitChanges: async () => {}, carried: () => undefined }
  const publisher = new Publisher(host)
  const paths = Array.from({ length: 96 }, (_, i) => `gate-${String(i).padStart(3, '0')}.txt`)
  for (const p of paths) fs.writeFileSync(path.join(checkout, p), 'before\n')
  const prepared = await publisher.prepare()
  const original = fs.lstatSync
  let first = true
  const events: string[] = []
  const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, options?: unknown) => {
    if (first && String(p).endsWith(paths[0])) {
      first = false
      setImmediate(() => { fs.writeFileSync(path.join(checkout, paths[0]), 'after with different size\n'); events.push('changed') })
    }
    return (original as any)(p, options)
  }) as typeof fs.lstatSync)
  try {
    expect(await publisher.validatePrepared(prepared)).toBe(true)
    expect(events).toEqual(['changed'])
    expect(publisher.identityValid(prepared)).toBe(false)
    expect(roomDoc.manifestHead.get('Alice')).toBeUndefined()
  } finally { spy.mockRestore() }
  publisher.stop()
})

it('refuses the HEAD-transition transaction when an early validated path changes', async () => {
  const config = options()
  daemon = await startRoomd(config)
  const internal = daemon as Roomd & { watcher: { suspend(): void }; publisher: {
    prepare(): Promise<any>; validatePrepared(prepared: any): Promise<boolean>
  }; commitTransition(...args: any[]): boolean }
  internal.watcher.suspend()
  const paths = Array.from({ length: 96 }, (_, i) => `gate-${String(i).padStart(3, '0')}.txt`)
  for (const p of paths) fs.writeFileSync(path.join(config.dir, p), 'before\n')
  const prepared = await internal.publisher.prepare()
  const original = fs.lstatSync
  let first = true
  const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, options?: unknown) => {
    if (first && String(p).endsWith(paths[0])) {
      first = false
      setImmediate(() => fs.writeFileSync(path.join(config.dir, paths[0]), 'after with different size\n'))
    }
    return (original as any)(p, options)
  }) as typeof fs.lstatSync)
  try {
    expect(await internal.publisher.validatePrepared(prepared)).toBe(true)
    expect(internal.commitTransition({ head: daemon.base }, { moves: [], releases: [], hashById: new Map(), claimState: new Map() }, {}, prepared, true)).toBe(false)
    expect(incarnationText(daemon.roomDoc, 'Alice', paths[0])).toBeUndefined()
  } finally { spy.mockRestore() }
})

// Multiple real filesystem scans need headroom under concurrent test load.
it('republishes, narrows, and deletes 2050 shared files without retaining content', async () => {
  const checkout = repo()
  const roomDoc = new RoomDoc()
  const base = git(checkout, 'rev-parse', 'HEAD')
  const host: any = { dir: checkout, name: 'Alice', fence: '1', roomDoc, base, stopped: false, phase: 'watch',
    inputs: { policy: policyFromLevel('full'), rules: rulesFromText('', 512 * 1024, 8 * 1024 * 1024), head: base },
    batch: { published() {} }, skips: { size: new Set(), budget: new Set(), ignore: new Set() },
    log() {}, abs: (p: string) => path.join(checkout, p), isSafeRoomPath: () => true,
    bumpLastActive() {}, reconcileGitChanges: async () => {}, carried: () => undefined }
  const publisher = new Publisher(host)
  const paths = Array.from({ length: 2050 }, (_, i) => `many/f-${String(i).padStart(4, '0')}.txt`)
  fs.mkdirSync(path.join(checkout, 'many'))
  for (const p of paths) fs.writeFileSync(path.join(checkout, p), 'x')
  expect(await publisher.reconcile()).toBeDefined()
  const key = manifestKey('Alice', '1')
  const entry = () => roomDoc.manifest.get(key)
  const assertShared = () => {
    expect(roomDoc.manifestHead.get('Alice')?.complete).toBe(true)
    expect(entry()?.size).toBe(paths.length)
    expect(incarnationText(roomDoc, 'Alice', paths[0])?.toString()).toBe('x')
  }
  assertShared()
  expect(await publisher.reconcile()).toBeDefined()
  assertShared()
  host.inputs = { ...host.inputs, policy: policyFromLevel('intent') }
  publisher.applyInputs(host.inputs)
  expect(roomDoc.manifestHead.get('Alice')?.level).toBe('intent')
  expect(entry()?.size).toBe(0)
  expect(roomDoc.overlays.get(key)?.size ?? 0).toBe(0)
  expect(roomDoc.ownedBaseTexts.size).toBe(0)
  expect(incarnationText(roomDoc, 'Alice', paths[0])).toBeUndefined()
  host.inputs = { ...host.inputs, policy: policyFromLevel('full') }
  publisher.applyInputs(host.inputs)
  expect(await publisher.reconcile()).toBeDefined()
  assertShared()
  for (const p of paths) fs.unlinkSync(path.join(checkout, p))
  expect(await publisher.reconcile()).toBeDefined()
  expect(entry()?.size).toBe(0)
  expect(roomDoc.overlays.get(key)?.size ?? 0).toBe(0)
  expect(incarnationText(roomDoc, 'Alice', paths[0])).toBeUndefined()
  publisher.stop()
}, 60_000)

it('leaves an explicit base gap for an oversized carried blob replaced by six bytes', async () => {
  const checkout = repo()
  const base = git(checkout, 'rev-parse', 'HEAD')
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: checkout, input: Buffer.alloc(2 * 1024 * 1024, 97), encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(checkout, 'carried.txt'), 'small\n')
  const roomDoc = new RoomDoc()
  roomDoc.ownedBaseTexts.set(`Alice\0${base}:carried.txt`, 'stale base')
  const host: any = { dir: checkout, name: 'Alice', fence: '1', roomDoc, base, stopped: false, phase: 'watch',
    inputs: { policy: policyFromLevel('full'), rules: rulesFromText('', 512 * 1024, 1024 * 1024), head: base },
    batch: { published() {} }, skips: { size: new Set(), budget: new Set(), ignore: new Set() },
    log() {}, abs: (p: string) => path.join(checkout, p), isSafeRoomPath: () => true,
    bumpLastActive() {}, reconcileGitChanges: async () => {}, carried: () => ({
      worker: 'Alice', sha: base, dir: checkout, carriedCommit: false, untracked: new Map([['carried.txt', { sha: blob }]]),
    }) }
  const calls: string[][] = []
  setGitObserver(args => { calls.push([...args]) })
  const publisher = new Publisher(host)
  try {
    const prepared = await publisher.prepare()
    expect(prepared.desired.entries.get('carried.txt')?.text).toBe('small\n')
    expect(prepared.baseTexts.get('carried.txt')).toBeUndefined()
    expect(calls.some(args => args[0] === 'cat-file' && args[1] === '-s' && args[2] === blob)).toBe(true)
    expect(calls.some(args => args[0] === 'cat-file' && args[1] === '--filters' && args.at(-1) === blob)).toBe(false)
    expect(publisher.apply(prepared, true)).toBe(true)
    expect(roomDoc.ownedBaseTexts.has(`Alice\0${base}:carried.txt`)).toBe(false)
  } finally { setGitObserver(undefined); publisher.stop() }
})

it('treats checkout-filter expansion past the byte cap as a base gap', async () => {
  const checkout = repo()
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: checkout, input: 'small\n', encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(checkout, '.gitattributes'), 'inflated.txt filter=inflate\n')
  git(checkout, 'config', 'filter.inflate.smudge', 'node -e "process.stdout.write(\'a\'.repeat(2097152))"')
  expect(await checkoutText(checkout, blob, 'inflated.txt', 'utf8', 512 * 1024)).toBeUndefined()
})

it('accepts checkout-filter output at the byte cap and treats one byte past it as a gap', async () => {
  const checkout = repo()
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: checkout, input: 'tiny', encoding: 'utf8' }).trim()
  const cap = 512 * 1024
  const outputs = new Map<number, string | undefined>()
  for (const size of [cap, cap + 1, cap + 2]) {
    fs.writeFileSync(path.join(checkout, '.gitattributes'), 'x.txt filter=inflate\n')
    git(checkout, 'config', 'filter.inflate.smudge', `node -e "process.stdout.write('a'.repeat(${size}))"`)
    outputs.set(size, await checkoutText(checkout, blob, 'x.txt', 'utf8', cap))
  }
  expect(outputs.get(cap)?.length).toBe(cap)
  expect(outputs.get(cap + 1)).toBeUndefined()
  expect(outputs.get(cap + 2)).toBeUndefined()
})
