import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd, type Roomd, type RoomdOptions } from '../src/index.js'
import { policyFromLevel } from '../src/policy.js'
import { manifestPaths } from './manifest-assert.js'
import * as git from '../src/git.js'

let daemon: Roomd | undefined
const dirs: string[] = []
afterEach(async () => {
  await daemon?.stop(); daemon = undefined
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
const barrier = () => {
  let release!: () => void, enter!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { enter = resolve })
  return { release, entered, wait: async () => { enter(); await held } }
}
function fixture(signal: AbortSignal) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomd-cancel-')); dirs.push(dir)
  const sh = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  sh('init', '-q', '-b', 'main'); sh('config', 'user.name', 'T'); sh('config', 'user.email', 't@t')
  fs.writeFileSync(path.join(dir, 'app.py'), 'x = 1\n'); sh('add', '.'); sh('commit', '-qm', 'init')
  fs.writeFileSync(path.join(dir, 'app.py'), 'private text\n')
  const doc = new Y.Doc(), awareness = new Awareness(doc)
  let destroyed = false
  const outbound: Uint8Array[] = []
  doc.on('update', bytes => { if (signal.aborted && !destroyed) outbound.push(bytes) })
  const provider = Object.assign(new EventEmitter(), { synced: true, awareness, destroy: vi.fn(() => { destroyed = true }) })
  const connect = vi.fn(() => provider as unknown as WebsocketProvider)
  const options: RoomdOptions & { signal: AbortSignal } = { signal, dir, room: 'ws://memory/local/cancel', name: 'T', policy: policyFromLevel('full'),
    replica: doc, providerFactory: connect, basePollMs: 0, reconcileIntervalMs: 0, log: () => {} }
  return { options, connect, provider, doc, outbound, destroy: () => { awareness.destroy(); doc.destroy() } }
}

it('an abort before startup creates no provider or publication', async () => {
  const abort = new AbortController(); abort.abort()
  const f = fixture(abort.signal)
  try {
    const result = await startRoomd(f.options).then(value => { daemon = value; return undefined }, error => error)
    expect(result).toMatchObject({ name: 'AbortError' })
    expect(f.connect).not.toHaveBeenCalled()
  } finally { f.destroy() }
})

it.each(['git', 'sync', 'seed'])('an abort during %s stops startup before a file write and cleans up its provider', async phase => {
  const abort = new AbortController(), f = fixture(abort.signal), gate = barrier()
  if (phase === 'git') {
    const original = git.gitBranch
    vi.spyOn(git, 'gitBranch').mockImplementationOnce(async (...args) => { await gate.wait(); return original(...args) })
  } else if (phase === 'sync') {
    f.provider.synced = false
    f.provider.on('newListener', event => { if (event === 'sync') void gate.wait() })
  } else f.options.beforePublishWrite = () => gate.wait()
  f.options.connectTimeoutMs = 23456
  const timers = vi.spyOn(globalThis, 'setTimeout'), clear = vi.spyOn(globalThis, 'clearTimeout')
  const pending = startRoomd(f.options).then(value => { daemon = value; return undefined }, error => error)
  try {
    await gate.entered
    abort.abort()
    fs.writeFileSync(path.join(f.options.dir, 'app.py'), 'PRIVATE_AFTER_CANCEL\n')
    gate.release()
    expect(await pending).toMatchObject({ name: 'AbortError' })
    expect(f.provider.destroy).toHaveBeenCalledOnce()
    expect(Buffer.concat(f.outbound.map(bytes => Buffer.from(bytes))).toString()).not.toContain('PRIVATE_AFTER_CANCEL')
    expect(f.outbound).toEqual([])
    expect(f.provider.listenerCount('sync')).toBe(0)
    if (phase === 'sync') {
      const index = timers.mock.calls.findIndex(args => args[1] === 23456)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(clear).toHaveBeenCalledWith(timers.mock.results[index].value)
    }
    expect(manifestPaths(new (await import('@room/shared')).RoomDoc(f.doc), 'T')).toEqual([])
  } finally { gate.release(); await pending; f.destroy() }
})

it('an abort after successful startup has no effect on the daemon', async () => {
  const abort = new AbortController(), f = fixture(abort.signal)
  try {
    daemon = await startRoomd(f.options)
    abort.abort()
    expect(f.provider.destroy).not.toHaveBeenCalled()
    expect(manifestPaths(daemon.roomDoc, 'T')).toContain('app.py')
  } finally { await daemon?.stop(); daemon = undefined; f.destroy() }
})
