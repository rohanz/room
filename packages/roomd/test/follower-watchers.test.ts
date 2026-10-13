import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import chokidar from 'chokidar'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd, type Roomd, type RoomdOptions } from '../src/index.js'
import type { CheckoutWatch, WatcherHandoff } from '../src/checkout-watch.js'
import { setGitObserver } from '../src/git.js'
import { policyFromLevel } from '../src/policy.js'
import { claimDigest } from '../src/reanchor.js'
import { manifestText } from './manifest-assert.js'


const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
const daemons: Roomd[] = []
const roots: string[] = []
let transfer: WatcherHandoff | undefined
const internal = (daemon: Roomd) => daemon as Roomd & {
  watcher: CheckoutWatch | null
  tracked: Set<string>
  indexed: Set<string>
  trackedPoll?: { stopped: boolean; timer?: unknown }
  headPoll?: unknown
  appliedHead: string
  refreshTracked(): Promise<void>
  queuedHeadPoll(): Promise<void>
  startWatcher(): Promise<void>
}
const providerFactory: NonNullable<RoomdOptions['providerFactory']> = (_s, _n, doc) => {
  let local: Record<string, unknown> | null = null
  return { synced: true, awareness: {
    setLocalState(state: Record<string, unknown> | null) { local = state },
    getLocalState: () => local, getStates: () => new Map([[doc.clientID, local]]),
  }, on() {}, off() {}, destroy() {} } as unknown as WebsocketProvider
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  await transfer?.dispose(); transfer = undefined
  setGitObserver(undefined)
  vi.useRealTimers(); vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-follower-watch-')))
  roots.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(dir, 'app.txt'), 'first\nclaimed\nlast\n')
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base')
  return dir
}

async function start(dir: string, options: Partial<RoomdOptions> = {}) {
  const daemon = await startRoomd({ dir, name: 'Follower', room: 'ws://memory/follower-watch',
    policy: { ...policyFromLevel('full', [], 'full', false), publisherName: 'Publisher' },
    basePollMs: 0, trackedRefreshMs: 10_000, reconcileIntervalMs: 0, debounceMs: 5, log: () => {},
    providerFactory, ...options })
  daemons.push(daemon)
  return daemon
}

// Only interval ticks are virtual: Git child-process callbacks and watcher readiness use real I/O.
function fakePolls() { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) }
async function ticks(ms = 30_000) {
  await vi.advanceTimersByTimeAsync(ms)
  // Give Git processes launched by ticks a chance to finish (they are not fake I/O).
  await new Promise(resolve => setTimeout(resolve, 100))
}

it('starts a follower with no checkout watch, inventory, or ls-files across 30 seconds', async () => {
  const dir = repo(), watched = vi.spyOn(chokidar, 'watch'), calls: string[][] = []
  setGitObserver(args => calls.push([...args]))
  fakePolls()
  const daemon = await start(dir)
  await ticks()
  await daemon.enqueue(async () => {})
  for (const level of ['intent', 'declared', 'full'] as const) {
    daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel(level, ['app.txt'], 'full', false) })
    await daemon.reconcileGitChanges()
    expect(daemon.share).toBe(level)
  }
  expect(calls.filter(args => args[0] === 'ls-files')).toEqual([])
  expect(watched).not.toHaveBeenCalled()
  expect(internal(daemon).watcher).toBeNull()
  expect(internal(daemon).tracked.size).toBe(0)
  expect(internal(daemon).indexed.size).toBe(0)
  expect(internal(daemon).trackedPoll).toBeUndefined()
  expect(daemon.roomDoc.manifestHead.get(daemon.name)?.coverage).toEqual({ kind: 'none', reason: 'not-publisher' })
  await daemon.stop()
  expect(vi.getTimerCount()).toBe(0)
})

it('promotes with fresh rules, inventory, watch and a full rescan of follower edits', async () => {
  const dir = repo(), watched = vi.spyOn(chokidar, 'watch'), calls: string[][] = [], logs: string[] = []
  fakePolls()
  const daemon = await start(dir, { log: line => logs.push(line) })
  fs.writeFileSync(path.join(dir, 'app.txt'), 'edited while following\n')
  fs.mkdirSync(path.join(dir, 'out')); fs.writeFileSync(path.join(dir, 'out/app.ts'), 'gap\n')
  fs.mkdirSync(path.join(dir, 'ignored')); fs.writeFileSync(path.join(dir, 'ignored/new.txt'), 'unignored\n')
  fs.writeFileSync(path.join(dir, '.gitignore'), '')
  fs.writeFileSync(path.join(dir, 'private.txt'), 'withheld\n')
  fs.writeFileSync(path.join(dir, '.roomignore'), 'private.txt\n')
  expect(watched).not.toHaveBeenCalled()
  daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('full') })
  await daemon.reconcileGitChanges()
  expect(watched).toHaveBeenCalledTimes(1)
  expect(internal(daemon).trackedPoll, logs.join('\n')).toBeDefined()
  expect(internal(daemon).tracked.has('out/app.ts')).toBe(true)
  expect(manifestText(daemon.roomDoc, 'app.txt', daemon.name)).toBe('edited while following\n')
  expect(manifestText(daemon.roomDoc, 'out/app.ts', daemon.name)).toBe('gap\n')
  expect(manifestText(daemon.roomDoc, 'ignored/new.txt', daemon.name)).toBe('unignored\n')
  expect(manifestText(daemon.roomDoc, 'private.txt', daemon.name)).toBeUndefined()
  fs.writeFileSync(path.join(dir, 'out/app.ts'), 'watched after promotion\n')
  await expect.poll(() => manifestText(daemon.roomDoc, 'out/app.ts', daemon.name)).toBe('watched after promotion\n')
  internal(daemon).watcher!.suspend()
  setGitObserver(args => calls.push([...args]))
  fs.writeFileSync(path.join(dir, 'polled.txt'), 'poll after promotion\n')
  await ticks(10_000)
  await expect.poll(() => manifestText(daemon.roomDoc, 'polled.txt', daemon.name)).toBe('poll after promotion\n')
  expect(calls.some(args => args[0] === 'ls-files')).toBe(true)
})

it('demotes by closing its watch and tracked poll, and stop leaves no interval timers', async () => {
  const dir = repo(), watched = vi.spyOn(chokidar, 'watch'), calls: string[][] = []
  fakePolls()
  const daemon = await start(dir, { policy: policyFromLevel('full') })
  const watch = internal(daemon).watcher!, close = vi.spyOn(watch, 'close')
  const trackedPoll = internal(daemon).trackedPoll!
  daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('full', [], 'full', false) })
  await daemon.reconcileGitChanges()
  expect(close).toHaveBeenCalledTimes(1)
  expect(internal(daemon).watcher).toBeNull()
  expect(internal(daemon).trackedPoll).toBeUndefined()
  expect(trackedPoll.stopped).toBe(true)
  expect(trackedPoll.timer).toBeUndefined()
  expect(internal(daemon).tracked.size).toBe(0)
  expect(internal(daemon).indexed.size).toBe(0)
  setGitObserver(args => calls.push([...args]))
  fs.writeFileSync(path.join(dir, 'app.txt'), 'after demotion\n')
  await ticks()
  expect(calls.filter(args => args[0] === 'ls-files')).toEqual([])
  expect(watched).toHaveBeenCalledTimes(1)
  await daemon.stop()
  expect(close).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('discards an in-flight tracked listing when its publisher is demoted', async () => {
  const dir = repo()
  const daemon = await start(dir, { policy: policyFromLevel('full') })
  let demoted = false
  fs.writeFileSync(path.join(dir, 'late.txt'), 'listing completed after demotion\n')
  // The observer runs before git() resolves its buffered output, making the completion race deterministic.
  setGitObserver(args => {
    if (!demoted && args[0] === 'ls-files' && args.includes('--cached')) {
      demoted = true
      daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('full', [], 'full', false) })
    }
  })
  await internal(daemon).refreshTracked()
  await daemon.reconcileGitChanges()
  expect(demoted).toBe(true)
  expect(internal(daemon).tracked.size).toBe(0)
  expect(internal(daemon).indexed.size).toBe(0)
  expect(internal(daemon).watcher).toBeNull()
  expect(internal(daemon).trackedPoll).toBeUndefined()
  expect(manifestText(daemon.roomDoc, 'late.txt', daemon.name)).toBeUndefined()
})

it('does not install publisher resources when demoted during watch setup, then permits a later promotion', async () => {
  const dir = repo(), watched = vi.spyOn(chokidar, 'watch')
  let demote = true
  const daemon = await start(dir, { beforeWatcherReady: () => {
    if (demote) daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('full', [], 'full', false) })
  } })
  fs.writeFileSync(path.join(dir, 'app.txt'), 'promotion race\n')
  daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('full') })
  await daemon.reconcileGitChanges()
  expect(watched).not.toHaveBeenCalled()
  expect(internal(daemon).trackedPoll).toBeUndefined()
  expect(internal(daemon).tracked.size).toBe(0)
  demote = false
  daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('full') })
  await daemon.reconcileGitChanges()
  expect(watched).toHaveBeenCalledTimes(1)
  expect(internal(daemon).trackedPoll).toBeDefined()
  expect(manifestText(daemon.roomDoc, 'app.txt', daemon.name)).toBe('promotion race\n')
})

it('frees the queue when demoted before chokidar ready, then re-promotes without leaking the cancelled watch', async () => {
  const dir = repo()
  const daemon = await start(dir)
  const watch = chokidar.watch.bind(chokidar)
  let cancelled: CheckoutWatch | undefined
  let cancellation: unknown
  let nativeFirstReady = false
  const closeCounts: Array<() => number> = []
  let interrupted!: () => void
  const interruption = new Promise<void>(resolve => { interrupted = resolve })
  const watched = vi.spyOn(chokidar, 'watch').mockImplementation((...args) => {
    const native = watch(...args)
    const close = vi.spyOn(native, 'close')
    closeCounts.push(() => close.mock.calls.length)
    if (closeCounts.length === 1) {
      native.once('ready', () => { nativeFirstReady = true })
      // The real watch has been allocated but its asynchronous tree walk has not emitted ready.
      // CheckoutWatch and its readiness consumer are installed before this microtask runs.
      queueMicrotask(() => {
        cancelled = internal(daemon).watcher!
        void cancelled.ready.catch(error => { cancellation = error })
        daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('full', [], 'full', false) })
        fs.writeFileSync(path.join(dir, 'app.txt'), 'changed during cancelled setup\n')
        daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('full') })
        interrupted()
      })
    }
    return native
  })
  daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('full') })
  await interruption
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const drained = await Promise.race([
      daemon.enqueue(async () => {}).then(() => true),
      new Promise<boolean>(resolve => { deadline = setTimeout(() => resolve(false), 1500) }),
    ])
    expect(drained, 'closed readiness must settle so queued re-promotion can run').toBe(true)
  } finally { clearTimeout(deadline) }
  expect(nativeFirstReady).toBe(false)
  expect(cancellation).toMatchObject({ name: 'AbortError' })
  expect(watched).toHaveBeenCalledTimes(2)
  expect(closeCounts.map(count => count())).toEqual([1, 0])
  expect(internal(daemon).watcher).not.toBe(cancelled)
  expect(internal(daemon).trackedPoll).toBeDefined()
  expect(manifestText(daemon.roomDoc, 'app.txt', daemon.name)).toBe('changed during cancelled setup\n')
  await internal(daemon).queuedHeadPoll()
  await daemon.reconcileGitChanges()
  await daemon.stop()
  expect(closeCounts.map(count => count())).toEqual([1, 1])
})

it('stop during promotion inventory loading cannot install a later watch or poll', async () => {
  const dir = repo(), watched = vi.spyOn(chokidar, 'watch')
  fakePolls()
  const daemon = await start(dir)
  let stopped: Promise<void> | undefined
  setGitObserver(args => {
    if (!stopped && args[0] === 'ls-files' && args.includes('--cached')) stopped = daemon.stop()
  })
  daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('full') })
  await daemon.enqueue(async () => {})
  await stopped
  expect(stopped).toBeDefined()
  expect(watched).not.toHaveBeenCalled()
  expect(internal(daemon).trackedPoll).toBeUndefined()
  expect(internal(daemon).tracked.size).toBe(0)
  expect(internal(daemon).indexed.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('backs off repeated promotion setup failures, logs each class once, and resets after success or demotion', async () => {
  const dir = repo(), logs: string[] = [], calls: string[][] = []
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(0)
  const daemon = await start(dir, { basePollMs: 3_000, log: line => logs.push(line) })
  const watch = internal(daemon).startWatcher.bind(daemon)
  const attempts: number[] = []
  let failuresLeft = 3
  const setup = vi.spyOn(internal(daemon), 'startWatcher').mockImplementation(async () => {
    attempts.push(Date.now())
    if (failuresLeft-- > 0) throw Object.assign(new Error('synthetic watch limit'), { code: 'EMFILE' })
    await watch()
  })
  setGitObserver(args => calls.push([...args]))
  daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('full') })
  await daemon.enqueue(async () => {})
  expect(attempts).toEqual([0])
  const headTick = async (at: number) => {
    vi.setSystemTime(at)
    await internal(daemon).queuedHeadPoll()
  }
  await headTick(3_000)
  expect(attempts).toEqual([0])
  await headTick(6_000)
  const listings = () => calls.filter(args => args[0] === 'ls-files' && args.includes('--cached')).length
  const atSecondAttempt = listings()
  await headTick(9_000)
  await headTick(12_000)
  await headTick(15_000)
  expect(attempts).toEqual([0, 6_000])
  expect(listings()).toBe(atSecondAttempt)
  await headTick(18_000)
  expect(attempts).toEqual([0, 6_000, 18_000])
  // Additional publication scans use ls-files too; each setup retry adds exactly one tracked inventory.
  expect(listings()).toBe(atSecondAttempt + 1)
  expect(calls.filter(args => args[0] === 'ls-files' && args.includes('--directory'))).toHaveLength(3)
  expect(logs.filter(line => line.includes('synthetic watch limit'))).toHaveLength(1)
  fs.writeFileSync(path.join(dir, 'app.txt'), 'edited during backoff\n')
  for (let at = 21_000; at < 42_000; at += 3_000) await headTick(at)
  expect(attempts).toHaveLength(3)
  await headTick(42_000)
  expect(attempts).toEqual([0, 6_000, 18_000, 42_000])
  expect(internal(daemon).trackedPoll).toBeDefined()
  expect(manifestText(daemon.roomDoc, 'app.txt', daemon.name)).toBe('edited during backoff\n')

  // A later setup failure after success starts at the first delay again.
  setup.mockImplementation(async () => {
    attempts.push(Date.now())
    throw Object.assign(new Error('synthetic watch limit'), { code: 'EMFILE' })
  })
  transfer = daemon.takeWatcher!()
  const poll = internal(daemon).trackedPoll!
  ;(poll as unknown as { stop(): void }).stop()
  internal(daemon).trackedPoll = undefined
  await headTick(45_000)
  await headTick(48_000)
  expect(attempts.at(-1)).toBe(45_000)
  await headTick(51_000)
  expect(attempts.at(-1)).toBe(51_000)
  expect(logs.filter(line => line.includes('synthetic watch limit'))).toHaveLength(2)
  // A distinct failure class gets one diagnostic; repeated attempts remain capped at three minutes.
  setup.mockImplementation(async () => {
    attempts.push(Date.now())
    throw Object.assign(new Error('synthetic watch limit'), { code: 'EACCES' })
  })
  for (const at of [63_000, 87_000, 135_000, 231_000, 411_000, 591_000]) {
    await headTick(at)
    expect(attempts.at(-1)).toBe(at)
    await headTick(at + 3_000)
    expect(attempts.at(-1)).toBe(at)
  }
  expect(logs.filter(line => line.includes('synthetic watch limit'))).toHaveLength(3)
  // Demotion resets the pending longer retry, so a new promotion tries immediately.
  daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('full', [], 'full', false) })
  await daemon.enqueue(async () => {})
  vi.setSystemTime(595_000)
  daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('full') })
  await daemon.enqueue(async () => {})
  expect(attempts.at(-1)).toBe(595_000)
  expect(logs.filter(line => line.includes('synthetic watch limit'))).toHaveLength(4)
})

it('keeps follower HEAD polling and reanchors its own privately remembered claim digest without ls-files', async () => {
  const dir = repo(), watched = vi.spyOn(chokidar, 'watch'), calls: string[][] = []
  const daemon = await start(dir, { basePollMs: 30 })
  const original = fs.readFileSync(path.join(dir, 'app.txt'), 'utf8')
  const claim = daemon.roomDoc.addClaim({ path: 'app.txt', from: 2, to: 2, by: daemon.name, byKind: 'agent', intent: 'edit' })
  daemon.rememberClaimDigest(claim.id, claimDigest(original, 2, 2)!)
  setGitObserver(args => calls.push([...args]))
  fs.writeFileSync(path.join(dir, 'app.txt'), 'inserted\n' + original)
  git(dir, 'add', 'app.txt'); git(dir, 'commit', '-qm', 'move own claim')
  const head = git(dir, 'rev-parse', 'HEAD')
  await expect.poll(() => internal(daemon).appliedHead).toBe(head)
  expect(daemon.base).toBe(head)
  expect(daemon.roomDoc.claims.get(claim.id)).toMatchObject({ from: 3, to: 3 })
  expect(internal(daemon).headPoll).toBeDefined()
  expect(watched).not.toHaveBeenCalled()
  expect(calls.filter(args => args[0] === 'ls-files')).toEqual([])
  expect(daemon.roomDoc.manifestHead.get(daemon.name)?.coverage).toEqual({ kind: 'none', reason: 'not-publisher' })
})

it('closes a publisher handoff received by a follower instead of retaining it', async () => {
  const dir = repo(), watched = vi.spyOn(chokidar, 'watch')
  const publisher = await start(dir, { name: 'Publisher', policy: policyFromLevel('full') })
  const close = vi.spyOn(internal(publisher).watcher!, 'close')
  transfer = publisher.takeWatcher!()
  await publisher.stop()
  expect(close).not.toHaveBeenCalled()
  const follower = await start(dir, { watcher: transfer })
  expect(watched).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledTimes(1)
  expect(internal(follower).watcher).toBeNull()
  await follower.stop(); await transfer!.dispose()
  expect(close).toHaveBeenCalledTimes(1)
})

it('keeps independent publisher watches in different worktrees of the same repository', async () => {
  const dir = repo(), other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-follower-other-'))), watched = vi.spyOn(chokidar, 'watch')
  roots.push(other)
  git(dir, 'worktree', 'add', '-q', '-b', 'other', other)
  const a = await start(dir, { name: 'A', policy: policyFromLevel('full') })
  const b = await start(other, { name: 'B', policy: policyFromLevel('full') })
  expect(watched).toHaveBeenCalledTimes(2)
  expect(a.provider.awareness.getLocalState()!.watchedDirectory).not.toBe(b.provider.awareness.getLocalState()!.watchedDirectory)
  fs.writeFileSync(path.join(other, 'app.txt'), 'other worktree\n')
  await expect.poll(() => manifestText(b.roomDoc, 'app.txt', 'B')).toBe('other worktree\n')
  a.applyInputs({ ...a.inputs, policy: policyFromLevel('full', [], 'full', false) })
  await a.reconcileGitChanges()
  expect(internal(a).watcher).toBeNull()
  expect(internal(b).watcher).not.toBeNull()
})
