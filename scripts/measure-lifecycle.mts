import { requireWorkerInventory } from '../packages/room-mcp/src/worker-store.js'
/**
 * Socket-free file-registry baseline. Run: node --import tsx scripts/measure-lifecycle.mts [50 500] [--samples=5]
 * Each sample uses a fresh process and a fresh private fixture; never opens a live Room registry.
 * Counts JS fs API invocations, including failed calls, NOT kernel syscalls or child-process Git I/O.
 * Status = list + status for every worker. Admission = writeIntent at the last available slot;
 * it excludes checkout preparation, host startup and model/API latency. Startup includes module import.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import type { WorkerRecord } from '../packages/room-mcp/src/worker-status.js'

const identity = { pid: process.pid, startTime: 'synthetic-alive', executable: process.execPath, sessionId: 'baseline', nonce: 'baseline' }
function record(common: string, n: number): WorkerRecord {
  const tag = `baseline-${n}`
  return { v: 1, id: `w_baseline_${n}`, tag, name: `baseline+${tag}`, mode: 'local', room: 'local/baseline',
    lead: { participant: 'baseline', room: 'local/baseline', instance: identity }, host: 'codex',
    budget: { threads: 1, memGb: 1, nice: 10 }, share: 'declared', task: 'synthetic baseline; no host launched',
    dir: path.join(path.dirname(common), '.room', 'workers', tag), outside: false, branch: `room/${tag}`,
    prep: { step: 'prepared' }, capabilities: { resume: false, signal: false, collect: 'delta' }, phase: 'prepared',
    runs: [{ n: 1, mode: 'fresh', intentAt: 1, nonce: `launch-${n}`, busFrontier: 0, promptMsgIds: [], launcher: identity, logStart: 0 }],
    createdAt: 1, seq: 1 }
}

function instrument() {
  let counts: Record<string, number> = {}
  const restores: (() => void)[] = []
  // Cover the common metadata/read/write and durable publication APIs on all three fs surfaces.
  const operations = ['access', 'exists', 'stat', 'lstat', 'fstat', 'statfs', 'realpath', 'readlink', 'readdir', 'opendir',
    'readFile', 'writeFile', 'appendFile', 'open', 'close', 'read', 'write', 'mkdir', 'rmdir', 'rm', 'unlink', 'rename',
    'link', 'symlink', 'copyFile', 'cp', 'chmod', 'fchmod', 'chown', 'utimes', 'fsync', 'fdatasync', 'truncate', 'watch', 'watchFile']
  for (const [surface, target, names] of [
    ['fs', fs, operations.flatMap(name => [name, `${name}Sync`])],
    ['promises', fsp, operations],
  ] as const) {
    const object = target as unknown as Record<string, unknown>
    for (const name of names) {
      const original = object[name]
      if (typeof original !== 'function') continue
      const key = `${surface}.${name}`
      const wrapped = function (this: unknown, ...args: unknown[]) {
        counts[key] = (counts[key] ?? 0) + 1
        return Reflect.apply(original, this, args)
      }
      // realpathSync.native is used on some hosts; retain/count that entry point too.
      const native = (original as { native?: (...args: unknown[]) => unknown }).native
      if (native) Object.assign(wrapped, { native: (...args: unknown[]) => {
        counts[`${key}.native`] = (counts[`${key}.native`] ?? 0) + 1
        return native(...args)
      } })
      object[name] = wrapped
      restores.push(() => { object[name] = original })
    }
  }
  syncBuiltinESMExports()
  return { reset() { counts = {} }, result() {
    return { total: Object.values(counts).reduce((a, b) => a + b, 0), byApi: { ...counts } }
  }, restore() { for (const restore of restores.reverse()) restore(); syncBuiltinESMExports() } }
}

async function child(common: string, count: number) {
  const meter = instrument()
  try {
    const start = performance.now()
    const { WorkerRegistry } = await import('../packages/room-mcp/src/worker-registry.js')
    const registry = await WorkerRegistry.open(common, { migrate: false, watch: false, identity, liveness: () => 'alive' })
    const startup = { ms: performance.now() - start, fs: meter.result() }
    try {
      meter.reset()
      const statusStart = performance.now()
      const workers = requireWorkerInventory(await registry.list())
      for (const worker of workers) await registry.status(worker.id)
      if (workers.length !== count) throw new Error(`fixture mismatch: expected ${count}, got ${workers.length}`)
      const status = { ms: performance.now() - statusStart, fs: meter.result() }
      meter.reset()
      const admissionStart = performance.now()
      await registry.writeIntent(record(common, count), count + 1)
      const admission = { ms: performance.now() - admissionStart, fs: meter.result() }
      return { startup, status, admission }
    } finally { await registry.close() }
  } finally { meter.restore() }
}

function fixture(root: string, count: number) {
  const common = path.join(root, '.git')
  const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' })
  if (init.status !== 0) throw new Error(`git init: ${init.stderr}`)
  const registry = path.join(common, 'room', 'registry')
  for (const dir of ['workers', 'tags']) fs.mkdirSync(path.join(registry, dir), { recursive: true })
  fs.writeFileSync(path.join(registry, 'migration.json'), JSON.stringify({ v: 1, sources: {}, done: true }))
  for (let n = 0; n < count; n++) {
    const worker = record(common, n)
    // Manufacture validated-shaped fixtures outside measurements; do not benchmark O(N²) fixture setup.
    fs.writeFileSync(path.join(registry, 'workers', `${worker.id}.json`), JSON.stringify(worker))
    fs.writeFileSync(path.join(registry, 'tags', `${worker.tag}.json`), JSON.stringify({ id: worker.id, holder: identity, at: 1 }))
  }
  return common
}

const args = process.argv.slice(2)
if (args[0] === '--child') {
  try { process.stdout.write(JSON.stringify(await child(args[1], Number(args[2]))) + '\n') }
  catch (error) { console.error(error); process.exitCode = 1 }
} else {
  const numeric = args.filter(arg => !arg.startsWith('--'))
  const sizes = numeric.length ? numeric.map(Number) : [50, 500]
  const sampleArg = args.find(arg => arg.startsWith('--samples='))
  const samples = sampleArg ? Number(sampleArg.slice('--samples='.length)) : 5
  if (args.some(arg => arg.startsWith('--') && !arg.startsWith('--samples=')) ||
      sizes.some(n => !Number.isSafeInteger(n) || n < 1 || n > 10000) || !Number.isSafeInteger(samples) || samples < 1 || samples > 100) {
    throw new Error('usage: node --import tsx scripts/measure-lifecycle.mts [N ... (1..10000)] [--samples=1..100]')
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'room-lifecycle-baseline-'))
  try {
    const disk = fs.statfsSync(temp)
    const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
    console.log(JSON.stringify({ kind: 'environment', at: new Date().toISOString(), commit: git.stdout.trim(),
      node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch,
      os: { type: os.type(), release: os.release(), version: os.version() },
      hardware: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem() },
      filesystem: { fixtureParent: os.tmpdir(), type: disk.type, blockSize: disk.bsize, availableBlocks: disk.bavail },
      fixture: { sizes, samples, state: 'all prepared, one fresh run, no host launched, synthetic alive liveness',
        watcher: false, migration: false, runtimeLoader: 'tsx; transform cache not cleared', cache: 'fresh child per sample; no OS page-cache eviction; freshly written files',
        status: 'list + status for every worker', admission: 'writeIntent(capacity=N+1); excludes Git and host launch',
        startup: 'module import + open/reconcile; excludes Node/tsx process bootstrap',
        fsCounts: 'JS fs + fs/promises API calls, failed calls included; excludes native syscalls and subprocess Git I/O',
        unmeasured: ['hooks', 'real-host launch', 'event-loop/queue delay', 'SQLite contention/WAL'] } }))
    for (const count of sizes) {
      const runs: Awaited<ReturnType<typeof child>>[] = []
      for (let sample = 0; sample < samples; sample++) {
        const root = path.join(temp, `${count}-${sample}`)
        const common = fixture(root, count)
        const run = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--child', common, String(count)],
          { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 120_000 })
        if (run.status !== 0 || run.error) {
          console.log(JSON.stringify({ kind: 'failure', workers: count, sample, status: run.status, signal: run.signal, error: String(run.error ?? ''), stderr: run.stderr }))
          process.exitCode = 1
          continue
        }
        const result = JSON.parse(run.stdout) as Awaited<ReturnType<typeof child>>
        runs.push(result)
        console.log(JSON.stringify({ kind: 'sample', workers: count, sample, ...result }))
      }
      for (const phase of ['startup', 'status', 'admission'] as const) {
        const times = runs.map(run => run[phase].ms).sort((a, b) => a - b)
        const percentile = (q: number) => times.length ? times[Math.max(0, Math.ceil(q * times.length) - 1)] : null
        console.log(JSON.stringify({ kind: 'summary', workers: count, phase, successfulSamples: runs.length, failedSamples: samples - runs.length,
          p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99),
          fsCalls: runs.map(run => run[phase].fs.total) }))
      }
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
}
