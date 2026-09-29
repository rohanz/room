import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import { incarnationText } from './manifest-assert.js'
import { policyFromLevel } from '../src/policy.js'

const failure = vi.hoisted(() => ({ once: false }))
vi.mock('../src/disk-scan.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/disk-scan.js')>()
  return { ...actual, readDisk: async (...args: Parameters<typeof actual.readDisk>) => {
    if (failure.once) { failure.once = false; throw new Error('git scan failed once') }
    return actual.readDisk(...args)
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

it('retries publication after a fence resumes and its first Git scan fails', async () => {
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
  let fence: string | undefined = '1'
  const logs: string[] = []
  daemon = await startRoomd({ dir, room: 'ws://memory/takeover-poll', name: 'Amy', providerFactory: (_s, _n, doc) => provider(doc),
    policy: policyFromLevel('full'), lease: () => fence,
    basePollMs: 60_000, trackedRefreshMs: 60_000, reconcileIntervalMs: 0, log: line => logs.push(line) })
  const internal = daemon as Roomd & {
    watcher: { removeAllListeners(event: string): void }
    queuedHeadPoll(): Promise<void>
  }
  internal.watcher.removeAllListeners('all')
  fence = undefined
  fs.writeFileSync(path.join(dir, 'app.txt'), 'changed\n')
  fence = '2'

  failure.once = true
  // The failure goes to the publisher's retry, as before 0.16.37, and the HEAD poll itself resolves (no backoff).
  await expect(internal.queuedHeadPoll()).resolves.toBeUndefined()
  expect(incarnationText(daemon.roomDoc, 'Amy', 'app.txt')).toBeUndefined()
  expect(logs.some(line => line.includes('git scan failed once'))).toBe(true)

  await daemon.reconcileGitChanges()
  expect(incarnationText(daemon.roomDoc, 'Amy', 'app.txt')?.toString()).toBe('changed\n')
})
