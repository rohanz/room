import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'

const failure = vi.hoisted(() => ({ once: false }))
vi.mock('../src/git.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/git.js')>()
  return { ...actual, gitChanged: async (dir: string) => {
    if (failure.once) { failure.once = false; throw new Error('git status failed once') }
    return actual.gitChanged(dir)
  } }
})
import { startRoomd, type Roomd } from '../src/index.js'

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
let dir: string | undefined
let daemon: Roomd | undefined
afterEach(async () => {
  failure.once = false
  await daemon?.stop()
  daemon = undefined
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = undefined
  vi.unstubAllEnvs()
})

it('retries publication after a secondary takes over and its first Git scan fails', async () => {
  vi.stubEnv('ROOM_MACHINE_ID', 'test-machine')
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-takeover-poll-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(dir, 'app.txt'), 'base\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')

  let local: Record<string, unknown> | null = null
  const states = new Map<number, Record<string, unknown>>()
  const provider = (doc: Y.Doc) => ({
    synced: true,
    awareness: {
      setLocalState(value: Record<string, unknown> | null) { local = value; if (value) states.set(doc.clientID, value); else states.delete(doc.clientID) },
      getLocalState: () => local,
      getStates: () => states,
    },
    on() {}, off() {}, destroy() {},
  }) as unknown as WebsocketProvider
  const retries: Array<() => void> = []
  daemon = await startRoomd({ dir, room: 'ws://memory/takeover-poll', name: 'Amy', providerFactory: (_s, _n, doc) => provider(doc),
    basePollMs: 60_000, trackedRefreshMs: 60_000, reconcileIntervalMs: 0, log: () => {},
    retrySchedule: run => { retries.push(run); return () => {} } })
  const internal = daemon as Roomd & {
    watcher: { removeAllListeners(event: string): void }
    choosePublisher(): void
    queuedHeadPoll(): Promise<void>
  }
  internal.watcher.removeAllListeners('all')
  states.set(-1, { ...local, user: { name: 'Ada' }, publishUnder: undefined })
  internal.choosePublisher()
  expect(daemon.provider.awareness.getLocalState()?.publishUnder).toBe('Ada')
  fs.writeFileSync(path.join(dir, 'app.txt'), 'changed\n')
  states.delete(-1)

  failure.once = true
  // The failure goes to the publisher's retry, as before 0.16.37, and the HEAD poll itself resolves (no backoff).
  await expect(internal.queuedHeadPoll()).resolves.toBeUndefined()
  expect(daemon.provider.awareness.getLocalState()?.publishUnder).toBeUndefined()
  expect(daemon.roomDoc.overlayText('Amy', 'app.txt')).toBeUndefined()
  expect(retries).toHaveLength(1)

  retries.shift()!()
  await daemon.reconcileGitChanges()
  expect(daemon.roomDoc.overlayText('Amy', 'app.txt')?.toString()).toBe('changed\n')
})
