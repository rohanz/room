import { expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import chokidar from 'chokidar'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { WebsocketProvider } from 'y-websocket'
import type * as Y from 'yjs'
import { startRoomd } from '../src/index.js'
import { policyFromLevel } from '../src/policy.js'

const provider = (doc: Y.Doc): WebsocketProvider => {
  const states = new Map<number, unknown>()
  let local: unknown = null
  return { synced: true, awareness: { setLocalState(s: unknown) { local = s; if (s) states.set(doc.clientID, s); else states.delete(doc.clientID) },
    getStates: () => states, getLocalState: () => local }, on() {}, off() {}, destroy() {} } as unknown as WebsocketProvider
}

// The probe budget is independent of tree size, so a modest tree proves it (the rehearsal's tree was 8,375
// files, where the old path did 463,891 probes); a large one only made the test slow under suite load.
const FILES = 1500

it('rejoins a large tree without per-file synchronous scan probes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-large-rejoin-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim()
  const daemons: Awaited<ReturnType<typeof startRoomd>>[] = []
  try {
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'gc.auto', '0')
    const files: string[] = []
    for (let i = 0; i < FILES; i++) {
      const folder = path.join(dir, 'workspace', `crate${i % 25}`, 'src', 'nested', 'module')
      fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, `file${i}.txt`), `file ${i}\n`)
      files.push(path.join(folder, `file${i}.txt`))
    }
    git('add', '.'); git('commit', '-qm', 'large watched tree')
    const stats = vi.spyOn(fs, 'lstatSync'), realpaths = vi.spyOn(fs, 'realpathSync'), countStats = vi.spyOn(fs, 'statSync')
    // Model watcher enumeration explicitly. Its own synchronous stats are not
    // Room's probes, regardless of when a real watcher's callbacks get scheduled.
    let watcherStats = 0
    vi.spyOn(chokidar, 'watch').mockImplementation((_root, options) => {
      const watcher = new EventEmitter()
      Object.assign(watcher, { close: async () => {}, getWatched: () => ({}) })
      queueMicrotask(() => {
        for (const file of files) {
          const stat = fs.statSync(file); watcherStats++
          expect((options!.ignored as (file: string, stat: fs.Stats) => boolean)(file, stat)).toBe(false)
        }
        watcher.emit('ready')
      })
      return watcher as ReturnType<typeof chokidar.watch>
    })
    const measurements: unknown[] = []
    for (let join = 0; join < 2; join++) {
      const logs: string[] = []
      watcherStats = 0
      stats.mockClear(); realpaths.mockClear(); countStats.mockClear()
      const daemon = await startRoomd({ policy: policyFromLevel('full'), dir, room: 'ws://memory/rejoin', name: 'A',
        providerFactory: (_s, _n, doc) => provider(doc), log: line => logs.push(line),
        basePollMs: 0, reconcileIntervalMs: 0, trackedRefreshMs: 60_000 })
      daemons.push(daemon)
      const scanCalls = stats.mock.calls.length + realpaths.mock.calls.length + countStats.mock.calls.length - watcherStats
      measurements.push({ join, syncScanCalls: scanCalls })
      // A small root-probe budget, independent of runner load and tree size; the fixed path does about five.
      expect(watcherStats).toBe(FILES)
      expect(scanCalls).toBeLessThan(100)
      expect(logs).toContain(`watching ${FILES} files`)
      await daemon.stop(); daemons.pop()
    }
    console.log(JSON.stringify({ files: FILES, measurements }))
    stats.mockRestore(); realpaths.mockRestore(); countStats.mockRestore()
  } finally {
    vi.restoreAllMocks(); vi.unstubAllEnvs()
    for (const daemon of daemons) await daemon.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)
