import { expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import chokidar from 'chokidar'
import { Awareness } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd, type Roomd } from '../src/index.js'
import { CheckoutWatch, WatcherHandoff } from '../src/checkout-watch.js'
import { policyFromLevel } from '../src/policy.js'
import { manifestText } from './manifest-assert.js'

it('hands a live watch to a fresh daemon, reconciles the gap and closes it only on final leave', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-watch-handoff-')))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  let old: Roomd | undefined, fresh: Roomd | undefined, transfer: WatcherHandoff | undefined
  const watched = vi.spyOn(chokidar, 'watch')
  try {
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 't@t')
    fs.writeFileSync(path.join(dir, 'app.txt'), 'base\n')
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n')
    git('add', '.'); git('commit', '-qm', 'base')
    fs.mkdirSync(path.join(dir, 'ignored')); fs.writeFileSync(path.join(dir, 'ignored', 'new.txt'), 'hidden\n')
    const options = { dir, name: 'A', room: 'ws://memory/rejoin', policy: policyFromLevel('full'),
      basePollMs: 0, reconcileIntervalMs: 0, trackedRefreshMs: 60_000, debounceMs: 5, log: () => {},
      providerFactory: (_s: string, _n: string, doc: import('yjs').Doc) => ({ synced: true, awareness: new Awareness(doc), on() {}, off() {},
        destroy() { this.awareness.destroy() } }) as unknown as WebsocketProvider }
    fs.mkdirSync(path.join(dir, 'out'))
    old = await startRoomd(options)
    const close = vi.spyOn(watched.mock.results[0].value, 'close')
    transfer = old.takeWatcher!()
    expect(transfer).toBeDefined()
    await old.stop()
    expect(close).not.toHaveBeenCalled()
    fs.writeFileSync(path.join(dir, 'out', 'app.ts'), 'gap\n')
    fs.writeFileSync(path.join(dir, 'app.txt'), 'during gap\n')
    fs.writeFileSync(path.join(dir, '.gitignore'), '')
    fresh = await startRoomd({ ...options, watcher: transfer })
    expect(watched).toHaveBeenCalledTimes(1)
    expect(manifestText(fresh.roomDoc, 'app.txt', 'A')).toBe('during gap\n')
    expect(manifestText(fresh.roomDoc, 'ignored/new.txt', 'A')).toBe('hidden\n')
    // Adding a previously pruned directory installs its native watch asynchronously.
    await expect.poll(() => Object.keys(watched.mock.results[0].value.getWatched()).includes(path.join(dir, 'out'))).toBe(true)
    fs.writeFileSync(path.join(dir, 'out', 'app.ts'), 'later edit\n')
    await expect.poll(() => manifestText(fresh!.roomDoc, 'out/app.ts', 'A'), { timeout: 5000 }).toBe('later edit\n')
    fs.writeFileSync(path.join(dir, 'ignored', 'new.txt'), 'after rejoin\n')
    await expect.poll(() => manifestText(fresh!.roomDoc, 'ignored/new.txt', 'A'), { timeout: 5000 }).toBe('after rejoin\n')
    await fresh.stop(); fresh = undefined
    expect(close).toHaveBeenCalledTimes(1)
    await transfer!.dispose()
    expect(close).toHaveBeenCalledTimes(1)
  } finally {
    await fresh?.stop(); await old?.stop(); await transfer?.dispose()
    vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true })
  }
})

it('expires an abandoned handoff and refuses reuse in another checkout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-watch-expiry-'))
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'room-watch-other-'))
  const watcher = new CheckoutWatch(dir, { ignored: () => false, event: () => {}, error: () => {} })
  let transfer: WatcherHandoff | undefined
  try {
    await watcher.ready
    const close = vi.spyOn(watcher, 'close')
    transfer = new WatcherHandoff(watcher, 30)
    expect(transfer.take(other)).toBeUndefined()
    await expect.poll(() => close.mock.calls.length).toBe(1)
    expect(transfer.take(dir)).toBeUndefined()
  } finally { await transfer?.dispose(); await watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }) }
})

it('refuses aliases and replaced checkout roots', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'room-watch-root-'))
  const dir = path.join(parent, 'checkout'), alias = path.join(parent, 'alias')
  fs.mkdirSync(dir); fs.symlinkSync(dir, alias)
  const watcher = new CheckoutWatch(dir, { ignored: () => false, event: () => {}, error: () => {} })
  let transfer: WatcherHandoff | undefined
  try {
    await watcher.ready
    transfer = new WatcherHandoff(watcher)
    expect(transfer.take(alias)).toBeUndefined()
    fs.renameSync(dir, path.join(parent, 'old')); fs.mkdirSync(dir)
    expect(transfer.take(dir)).toBeUndefined()
    fs.rmSync(dir, { recursive: true })
    expect(transfer.take(dir)).toBeUndefined()
  } finally { await transfer?.dispose(); await watcher.close(); fs.rmSync(parent, { recursive: true, force: true }) }
})
