import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { manifestPaths } from '@room/shared'
import { startAutoTaggedRoomd, type NamedRoomd } from '../src/session.js'
import { readChoice, worktreePath } from '../src/choice.js'
import { PolicyStore } from '../src/policy-store.js'
import { hubRoom, type HubRoom } from './fixtures/hub-provider.js'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllEnvs()
})

function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rev25-tag-')))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=Ada', '-c', 'user.email=a@a', 'commit', '--allow-empty', '-qm', 'initial')
  fs.writeFileSync(path.join(dir, 'work.txt'), 'unfinished local work\n')
  vi.stubEnv('ROOM_HOST', 'claude')
  const room = hubRoom()
  cleanups.push(() => room.doc.doc.destroy())
  return { dir, room }
}

async function start(room: HubRoom, dir: string, sessionId: string): Promise<NamedRoomd> {
  const joined = await startAutoTaggedRoomd({ dir, room: 'ws://test/room', localKey: 'key',
    name: 'Ada', owner: 'Ada', requested: 'full', sessionId,
    providerFactory: (_server, _room, doc) => room.provider(doc),
    basePollMs: 0, reconcileIntervalMs: 0, log: () => {} })
  cleanups.push(() => joined.daemon.stop())
  return joined
}

it('a transient remembered-tag write failure does not orphan publication and change the retry identity', async () => {
  const { dir, room } = fixture()
  await room.hold('Ada')
  const rename = fs.renameSync
  let failed = false
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (!failed && String(to) === path.join(dir, '.git', 'room-choice.json')) {
      failed = true
      throw Object.assign(new Error('choice file temporarily unwritable'), { code: 'EACCES' })
    }
    return rename(from, to)
  })
  await expect(start(room, dir, 'first')).rejects.toThrow('choice file temporarily unwritable')
  expect(failed).toBe(true)
  expect((await readChoice(dir))?.tags?.[await worktreePath(dir)]).toBeUndefined()
  const orphan = manifestPaths(room.doc, 'Ada+claude')
  // Automatic retry retains the host session ID. On the baseline this also
  // permits takeover of the local name lease left by the early write failure.
  const retry = await start(room, dir, 'first')
  expect.soft(orphan).toEqual([])
  expect(retry.me.name).toBe('Ada+claude')
})

function barrier() {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  return { entered, release, wait: async () => { enter(); await waiting } }
}

it('an overlapping session does not replace the first live worktree session remembered name', async () => {
  const { dir, room } = fixture()
  await room.hold('Ada')
  const firstGate = barrier(), secondGate = barrier()
  const open = PolicyStore.open
  vi.spyOn(PolicyStore, 'open').mockImplementation(async options => {
    if (options.participant === 'Ada+claude') await firstGate.wait()
    if (options.participant === 'Ada+claude-2') await secondGate.wait()
    return open(options)
  })
  const firstPending = start(room, dir, 'first')
  let secondPending: Promise<NamedRoomd> | undefined
  try {
    await firstGate.entered
    secondPending = start(room, dir, 'second')
    await secondGate.entered
    firstGate.release()
    const first = await firstPending
    expect((await readChoice(dir))?.tags?.[await worktreePath(dir)]).toBe('claude')
    secondGate.release()
    const second = await secondPending
    expect([first.me.name, second.me.name]).toEqual(['Ada+claude', 'Ada+claude-2'])
    expect.soft((await readChoice(dir))?.tags?.[await worktreePath(dir)]).toBe('claude')
    await first.daemon.stop()
    const restarted = await start(room, dir, 'first')
    expect(restarted.me.name).toBe('Ada+claude')
  } finally {
    firstGate.release(); secondGate.release()
    await Promise.allSettled([firstPending, secondPending])
  }
})
