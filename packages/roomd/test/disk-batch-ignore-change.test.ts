import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd, type Roomd } from '../src/index.js'
import { policyFromLevel } from '../src/policy.js'
import { manifestText } from './manifest-assert.js'
import * as gitModule from '../src/git.js'

// One shared Git outage starts when the second path is classified. Both that
// check-ignore and any subsequent full-snapshot Git calls time out until recovery.
const outage = vi.hoisted(() => ({ armed: false, active: false, failures: [] as string[] }))
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, execFile: (...args: any[]) => {
    const [file, argv] = args
    if (file === 'git' && outage.armed && argv[0] === 'check-ignore' && argv.at(-1) === 'later.txt') outage.active = true
    if (file === 'git' && outage.active) {
      outage.failures.push(argv.join(' '))
      const done = args.at(-1)
      queueMicrotask(() => done(Object.assign(new Error('injected shared Git outage'), { killed: true, signal: 'SIGTERM' }), '', ''))
      return undefined
    }
    return (original.execFile as any)(...args)
  } }
})

let dir: string | undefined, daemon: Roomd | undefined
afterEach(async () => {
  outage.armed = outage.active = false
  outage.failures = []
  await daemon?.stop()
  vi.restoreAllMocks()
  daemon = undefined
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

async function start() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-review8-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  const write = (p: string, text: string) => fs.writeFileSync(path.join(dir!, p), text)
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
  write('early.txt', 'base\n'); write('later.txt', 'base\n'); write('.gitignore', '')
  git('add', '.'); git('commit', '-qm', 'base')
  daemon = await startRoomd({ dir, room: 'ws://memory/review8', name: 'Alice', policy: policyFromLevel('full'),
    debounceMs: 5, trackedRefreshMs: 0, basePollMs: 0, reconcileIntervalMs: 0, log: () => {},
    providerFactory: (_s, _n, doc) => {
      let local: unknown = null
      return { synced: true, awareness: { setLocalState(value: unknown) { local = value }, getLocalState: () => local,
        getStates: () => new Map([[doc.clientID, local]]) }, on() {}, off() {}, destroy() {} } as unknown as WebsocketProvider
    },
  })
  ;(daemon as unknown as { watcher: { suspend(): void } }).watcher.suspend()
  await daemon.settle()
  return { daemon, write }
}

it.each([false, true])('uses current ignore rules when ignored=%s changes during classification', async initiallyIgnored => {
  const { daemon, write } = await start()
  write('candidate.txt', 'candidate text\n')
  write('.gitignore', initiallyIgnored ? 'candidate.txt\n' : '')
  const ignored = gitModule.gitIgnored
  vi.spyOn(gitModule, 'gitIgnored').mockImplementation((...args) => {
    if (args[1] === 'later.txt') write('.gitignore', initiallyIgnored ? '' : 'candidate.txt\n')
    return ignored(...args)
  })
  daemon.scheduleDisk('candidate.txt', true)
  daemon.scheduleDisk('later.txt', false)
  await daemon.settle()
  expect(manifestText(daemon.roomDoc, 'candidate.txt', 'Alice')).toBe(initiallyIgnored ? 'candidate text\n' : undefined)
})
