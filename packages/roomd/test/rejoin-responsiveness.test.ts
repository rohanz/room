import { expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
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

it('rejoins an 8,375-file tree without synchronous scan stalls', async () => {
  vi.stubEnv('CHOKIDAR_USEPOLLING', '1')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-large-rejoin-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim()
  const daemons: Awaited<ReturnType<typeof startRoomd>>[] = []
  let timer: NodeJS.Timeout | undefined
  try {
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'gc.auto', '0')
    for (let i = 0; i < 8375; i++) {
      const folder = path.join(dir, 'workspace', `crate${i % 25}`, 'src', 'nested', 'module')
      fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, `file${i}.txt`), `file ${i}\n`)
    }
    git('add', '.'); git('commit', '-qm', 'large watched tree')
    const stats = vi.spyOn(fs, 'lstatSync'), realpaths = vi.spyOn(fs, 'realpathSync'), countStats = vi.spyOn(fs, 'statSync')
    let maxLag = 0, last = performance.now()
    timer = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - last - 10); last = now }, 10)
    const measurements: unknown[] = []
    let maxSyncScan = 0
    for (let join = 0; join < 2; join++) {
      const logs: string[] = []
      stats.mockClear(); realpaths.mockClear(); countStats.mockClear()
      const start = performance.now()
      const daemon = await startRoomd({ policy: policyFromLevel('full'), dir, room: 'ws://memory/rejoin', name: 'A',
        providerFactory: (_s, _n, doc) => provider(doc), log: line => logs.push(line),
        basePollMs: 0, reconcileIntervalMs: 0, trackedRefreshMs: 60_000 })
      daemons.push(daemon)
      const scanCalls = stats.mock.calls.length + realpaths.mock.calls.length + countStats.mock.calls.length
      maxSyncScan = Math.max(maxSyncScan, scanCalls)
      measurements.push({ join, durationMs: Math.round(performance.now() - start), syncScanCalls: scanCalls, maxLagMs: Math.round(maxLag) })
      expect(logs).toContain('watching 8375 files')
      await daemon.stop(); daemons.pop()
    }
    console.log(JSON.stringify({ files: 8375, measurements }))
    // Root-cause regression: the watcher must not synchronously revalidate every ancestor of every file.
    expect(maxSyncScan).toBeLessThan(1000)
    expect(maxLag).toBeLessThan(100)
    stats.mockRestore(); realpaths.mockRestore(); countStats.mockRestore()
  } finally {
    clearInterval(timer); vi.restoreAllMocks(); vi.unstubAllEnvs()
    for (const daemon of daemons) await daemon.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)
