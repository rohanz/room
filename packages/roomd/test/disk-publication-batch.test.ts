import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd, type Roomd } from '../src/index.js'
import { policyFromLevel, rulesFromText } from '../src/policy.js'
import { Publisher } from '../src/publisher.js'
import * as gitModule from '../src/git.js'
import { manifestDeleted, manifestText } from './manifest-assert.js'

let dir: string | undefined
let daemon: Roomd | undefined
afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  vi.restoreAllMocks()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

async function start() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-disk-batch-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `file-${i}.txt`), 'base\n')
  fs.writeFileSync(path.join(dir, '.gitignore'), '')
  git('add', '.')
  git('commit', '-qm', 'base')
  daemon = await startRoomd({ dir, room: 'ws://memory/disk-batch', name: 'Alice', policy: policyFromLevel('full'),
    debounceMs: 5, trackedRefreshMs: 0, basePollMs: 0, reconcileIntervalMs: 0, log: () => {},
    providerFactory: (_s, _n, doc) => {
      let local: unknown = null
      return { synced: true, awareness: { setLocalState(value: unknown) { local = value }, getLocalState: () => local,
        getStates: () => new Map([[doc.clientID, local]]) }, on() {}, off() {}, destroy() {} } as unknown as WebsocketProvider
    },
  })
  const internal = daemon as unknown as { watcher: { suspend(): void } }
  internal.watcher.suspend()
  await daemon.settle()
  const reconcile = vi.spyOn(Publisher.prototype, 'reconcile')
  const write = (p: string, text: string) => fs.writeFileSync(path.join(dir!, p), text)
  return { daemon, reconcile, write, git }
}

it('reconciles once for five changed paths in one disk batch', async () => {
  const { daemon, reconcile, write } = await start()
  for (let i = 0; i < 5; i++) {
    write(`file-${i}.txt`, `edit ${i}\n`)
    daemon.scheduleDisk(`file-${i}.txt`, false)
  }
  await daemon.settle()
  for (let i = 0; i < 5; i++) expect(manifestText(daemon.roomDoc, `file-${i}.txt`, 'Alice')).toBe(`edit ${i}\n`)
  expect(reconcile).toHaveBeenCalledTimes(1)
})

it('publishes a single edit before reporting it scanned, with no poll or later event', async () => {
  const { daemon, reconcile, write } = await start()
  const scanned = vi.fn((p: string) => {
    expect(manifestText(daemon.roomDoc, p, 'Alice')).toBe('single edit\n')
  })
  daemon.onScanned = scanned
  write('file-0.txt', 'single edit\n')
  daemon.scheduleDisk('file-0.txt', false)
  await daemon.settle()
  expect(reconcile).toHaveBeenCalledTimes(1)
  expect(scanned).toHaveBeenCalledExactlyOnceWith('file-0.txt')
})

it('keeps new-file flags, tracked deletion, ignored withdrawal and policy filtering in a mixed batch', async () => {
  const { daemon, write } = await start()
  write('private.txt', 'previously offered\n')
  daemon.scheduleDisk('private.txt', true)
  await daemon.settle()
  expect(manifestText(daemon.roomDoc, 'private.txt', 'Alice')).toBe('previously offered\n')
  write('.gitignore', 'private.txt\nignored.txt\n')
  write('.roomignore', 'withheld.txt\n')
  // Policy changes normally arrive directly from the watcher, outside the disk batch.
  daemon.applyInputs({ ...daemon.inputs, rules: rulesFromText('withheld.txt\n', 512 * 1024, 8 * 1024 * 1024) })
  await daemon.enqueue(async () => {})
  fs.unlinkSync(path.join(dir!, 'file-0.txt'))
  for (const p of ['new.txt', 'ignored.txt', 'withheld.txt']) write(p, 'new text\n')
  daemon.scheduleDisk('private.txt', false)
  daemon.scheduleDisk('file-0.txt', false)
  daemon.scheduleDisk('new.txt', true)
  daemon.scheduleDisk('new.txt', false)
  daemon.scheduleDisk('ignored.txt', true)
  daemon.scheduleDisk('withheld.txt', true)
  await daemon.settle()
  expect(manifestDeleted(daemon.roomDoc, 'Alice', 'file-0.txt')).toBe(true)
  expect(manifestText(daemon.roomDoc, 'new.txt', 'Alice')).toBe('new text\n')
  for (const p of ['private.txt', 'ignored.txt', 'withheld.txt']) expect(manifestText(daemon.roomDoc, p, 'Alice')).toBeUndefined()
})

it('does not reconcile for an ignored path or an unknown non-add event alone', async () => {
  const { daemon, reconcile, write } = await start()
  write('.gitignore', 'ignored.txt\n')
  write('ignored.txt', 'ignored\n')
  write('unknown.txt', 'not an add\n')
  daemon.scheduleDisk('ignored.txt', true)
  daemon.scheduleDisk('unknown.txt', false)
  daemon.scheduleDisk('missing.txt', true)
  await daemon.settle()
  expect(reconcile).not.toHaveBeenCalled()
})

it('reconciles overflow once and discovers a changed path omitted from the retained events', async () => {
  const { daemon, reconcile, write } = await start()
  write('file-0.txt', 'retained edit\n')
  write('omitted.txt', 'overflow edit\n')
  // Exercise the daemon callback with the bounded batch's overflow flag, without 10,000 Git probes.
  const batch = daemon.batch as unknown as { run(paths: Map<string, boolean>, overflow: boolean): Promise<void> }
  await batch.run(new Map([['file-0.txt', false]]), true)
  expect(manifestText(daemon.roomDoc, 'file-0.txt', 'Alice')).toBe('retained edit\n')
  expect(manifestText(daemon.roomDoc, 'omitted.txt', 'Alice')).toBe('overflow edit\n')
  expect(reconcile).toHaveBeenCalledTimes(1)
})

it('retains one follow-up batch for edits arriving during a blocked publication', async () => {
  const { daemon, reconcile, write } = await start()
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const publishing = new Promise<void>(resolve => { started = resolve })
  const internal = daemon as unknown as { beforePublishWrite: () => Promise<void> }
  internal.beforePublishWrite = async () => { started(); await gate }
  try {
    write('file-0.txt', 'first\n')
    daemon.scheduleDisk('file-0.txt', false)
    await publishing
    for (let i = 1; i < 5; i++) {
      write(`file-${i}.txt`, `latest ${i}\n`)
      daemon.scheduleDisk(`file-${i}.txt`, false)
    }
    expect(reconcile).toHaveBeenCalledTimes(1)
    release()
    await daemon.settle()
    for (let i = 1; i < 5; i++) expect(manifestText(daemon.roomDoc, `file-${i}.txt`, 'Alice')).toBe(`latest ${i}\n`)
    expect(reconcile).toHaveBeenCalledTimes(2)
  } finally { release() }
})

it('drops path classification when the checkout epoch changes while Git is checking it', async () => {
  const { daemon, reconcile, write } = await start()
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const checking = new Promise<void>(resolve => { started = resolve })
  const ignored = gitModule.gitIgnored
  vi.spyOn(gitModule, 'gitIgnored').mockImplementation(async (...args) => {
    started()
    await gate
    return ignored(...args)
  })
  try {
    write('file-0.txt', 'superseded event\n')
    daemon.scheduleDisk('file-0.txt', false)
    await checking
    const internal = daemon as unknown as { checkoutEpoch: number }
    internal.checkoutEpoch++
    release()
    await daemon.settle()
    expect(reconcile).not.toHaveBeenCalled()
    expect(manifestText(daemon.roomDoc, 'file-0.txt', 'Alice')).toBeUndefined()
  } finally { release() }
})

it('checks HEAD before processing a disk batch and publishes against the new base', async () => {
  const { daemon, write, git } = await start()
  write('file-0.txt', 'committed\n')
  git('add', '.')
  git('commit', '-qm', 'new head')
  const head = git('rev-parse', 'HEAD').toString().trim()
  write('file-0.txt', 'edit after commit\n')
  daemon.scheduleDisk('file-0.txt', false)
  await daemon.settle()
  expect(daemon.roomDoc.manifestHead.get('Alice')?.base).toBe(head)
  expect(manifestText(daemon.roomDoc, 'file-0.txt', 'Alice')).toBe('edit after commit\n')
})

it('still publishes earlier eligible changes when a later path classification fails', async () => {
  const { daemon, reconcile, write } = await start()
  const scanned: string[] = []
  daemon.onScanned = p => { scanned.push(p) }
  const ignored = gitModule.gitIgnored
  vi.spyOn(gitModule, 'gitIgnored').mockImplementation((...args) => args[1] === 'file-1.txt'
    ? Promise.reject(new Error('injected Git ignore failure')) : ignored(...args))
  write('file-0.txt', 'eligible edit\n')
  daemon.scheduleDisk('file-0.txt', false)
  daemon.scheduleDisk('file-1.txt', false)
  await daemon.settle()
  expect(manifestText(daemon.roomDoc, 'file-0.txt', 'Alice')).toBe('eligible edit\n')
  expect(reconcile).toHaveBeenCalledTimes(1)
  expect(scanned).toEqual(['file-0.txt', 'file-1.txt'])
})
