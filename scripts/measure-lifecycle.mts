/**
 * Lifecycle file-registry baseline. Run: node --import tsx scripts/measure-lifecycle.mts [50 500] [--samples=5]
 * Extra phases: --phase=gate [1 64 1024] or --phase=hooks [--hooks-mode=alone|bound|both].
 * Each sample uses a fresh process and a fresh private fixture; never opens a live Room registry.
 * Counts JS fs API invocations, including failed calls, NOT kernel syscalls or child-process Git I/O.
 * Status = list + status for every worker in one validated read. Admission = gate ticket + writeIntent at the last available slot;
 * it excludes checkout preparation, host startup and model/API latency. Startup includes module import.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import type { WorkerRecord } from '../packages/room-mcp/src/worker-status.js'

// The same measurement driver imports each revision's sources and fixtures.
const sourceArg = process.argv.find(arg => arg.startsWith('--source-root='))?.slice(14)
const sourceRoot = sourceArg ? path.resolve(sourceArg) : fileURLToPath(new URL('../', import.meta.url))
const source = (relative: string): Promise<any> => import(pathToFileURL(path.join(sourceRoot, relative)).href)

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
    const { requireWorkerInventory } = await source('packages/room-mcp/src/worker-store.js')
    const { WorkerRegistry } = await source('packages/room-mcp/src/worker-registry.js')
    const registry = await WorkerRegistry.open(common, { migrate: false, watch: false, identity, liveness: () => 'alive' })
    // Startup maintenance work: per-clone preflight, gate registration and maintenance status, once per process.
    const { storageRegistration, withAdmission } = await source('packages/room-mcp/src/storage-admission.js')
    await storageRegistration(common)
    const startup = { ms: performance.now() - start, fs: meter.result() }
    try {
      meter.reset()
      const statusStart = performance.now()
      // One logical display, through the same validated-read scope production listings use.
      const workers = await registry.validatedRead(async () => {
        const listed = requireWorkerInventory(await registry.list())
        for (const worker of listed) await registry.status(worker.id)
        return listed
      })
      if (workers.length !== count) throw new Error(`fixture mismatch: expected ${count}, got ${workers.length}`)
      const status = { ms: performance.now() - statusStart, fs: meter.result() }
      meter.reset()
      // Admission includes the storage gate ticket, as every production spawn does.
      const admissionStart = performance.now()
      await withAdmission(common, 'spawn', () => registry.writeIntent(record(common, count), count + 1))
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

// --phase=hooks is intentionally independent of gate.ts and can run unchanged on 7bee1e91.
// Bound hooks reuse memorySession and the production tools/arbitration path used by hooks.test.ts.
type Measurement = { ms: number; fs?: { total: number; byApi: Record<string, number> }; stdoutBytes?: number; stderr?: string; ipcContacts?: number }
async function gateSample(common: string, count: number): Promise<Record<string, Measurement>> {
  const { openStorageGate } = await source('packages/local-state/src/gate.js')
  const { probeOwnProcess } = await source('packages/local-state/src/process.js')
  const own = probeOwnProcess()
  if (!own?.startTime || !own.executable) throw new Error('cannot verify measurement process identity')
  const gate = openStorageGate(common)
  const registration = await gate.register({ kind: 'helper', release: 'measurement', instance: {
    pid: process.pid, startTime: own.startTime, executable: own.executable, sessionId: 'measurement', nonce: randomUUID(),
  } })
  const tickets: Awaited<ReturnType<typeof gate.admit>>[] = []
  try {
    for (let i = 0; i < count; i++) tickets.push(await gate.admit(registration, 'preview'))
    const meter = instrument()
    try {
      let start = performance.now()
      const ticket = await gate.admit(registration, 'preview')
      await gate.finish(ticket)
      const admitFinish = { ms: performance.now() - start, fs: meter.result() }
      meter.reset(); start = performance.now()
      await gate.observe()
      return { admitFinish, observe: { ms: performance.now() - start, fs: meter.result() } }
    } finally { meter.restore() }
  } finally {
    for (const ticket of tickets) await gate.finish(ticket)
    await gate.unregister(registration)
  }
}

async function hooksSample(root: string, mode: string): Promise<Record<string, Measurement>> {
  const result: Record<string, Measurement> = {}
  const hooks = path.join(sourceRoot, 'plugins/room/hooks')
  const common = path.join(root, '.git')
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(ROOM_|CLAUDE_|CODEX_|GIT_)/.test(key)) delete env[key]
  // Keep fallback hook diagnostics inside the disposable fixture as well.
  env.TMPDIR = root; env.TMP = root; env.TEMP = root
  for (const variant of mode === 'both' ? ['alone', 'bound'] : [mode]) {
    for (const host of ['codex', 'claude'] as const) {
      const id = `measurement-${variant}-${host}`
      const { sessionDirectory } = await source('packages/room-mcp/src/session.js')
      const sessionDir = sessionDirectory(common, id)
      let contacts = 0
      let selectionMs = 0
      let close = async () => {}
      if (variant === 'bound') {
        const { memorySession } = await source('packages/room-mcp/test/fixtures/session.js')
        const { visiblePeer, presentPeer } = await source('packages/room-mcp/test/fixtures/visible.js')
        const { createTools } = await source('packages/room-mcp/src/tools.js')
        const { startArbitration } = await source('packages/room-mcp/src/arbitration.js')
        const session = memorySession({ name: 'measurement', kind: 'agent' }, root)
        visiblePeer(session.room, 'measurement', 'agent', id)
        visiblePeer(session.room, 'peer', 'agent', 'measurement-peer')
        const { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } = await import('y-protocols/awareness')
        const { Doc } = await import('yjs')
        const peerDoc = new Doc(), peer = new Awareness(peerDoc)
        peer.setLocalState({ user: { name: 'peer', kind: 'agent', color: '#000' }, sessionId: 'measurement-peer', status: 'idle', lastActive: Date.now() })
        applyAwarenessUpdate(session.awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'measurement')
        await session.policyStore.markDisclosed('full', 2)
        const binding = { bound: () => ({ id, host }), id: () => id, dir: () => sessionDir, commonDir: () => common }
        const tools = createTools({ getSession: () => session, setSession: () => {}, cwd: root, binding })
        let arbitration: Awaited<ReturnType<typeof startArbitration>> | undefined
        close = async () => {
          await arbitration?.close(); await tools.shutdown(); session.hub.close()
          peer.destroy(); peerDoc.destroy(); session.awareness.destroy(); session.room.doc.destroy()
        }
        try {
          tools.attachHooks(session)
          arbitration = await startArbitration({ binding, ledger: tools.ledger, select: () => { const start = performance.now(); try { return tools.hookSelect() } finally { selectionMs += performance.now() - start } }, onContact: () => { contacts++ } })
          // State publication is debounced; wait outside the timed child invocation.
          const deadline = Date.now() + 5000
          while (!fs.existsSync(path.join(sessionDir, 'state.json'))) {
            if (Date.now() >= deadline) throw new Error('bound hook fixture did not publish state')
            await new Promise(resolve => setTimeout(resolve, 10))
          }
        } catch (error) { await close(); throw error }
      } else {
        fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ at: Date.now(), company: false, owedCount: 0, notices: 0 }))
        fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({ session_id: id, host, cwd: root, at: Date.now() }))
      }
      try {
        for (const hook of ['session-start', 'before-edit']) {
          const beforeContacts = contacts, beforeSelection = selectionMs
          const meter = process.env.MEASURE_HOOKS_DIAGNOSTIC ? instrument() : undefined
          const start = performance.now()
          const run = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
            const proc = execFile(process.execPath, [path.join(hooks, `${hook}.mjs`), '--host', host],
              { cwd: root, env, timeout: 10_000, maxBuffer: 1024 * 1024 },
              (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))
            proc.stdin!.end(JSON.stringify({ cwd: root, session_id: id, source: 'startup', tool_name: 'Edit',
              tool_input: { file_path: path.join(root, 'app.py'), old_string: 'x', new_string: 'y' } }))
          })
          result[`${variant}.${host}.${hook}`] = { ms: performance.now() - start, stdoutBytes: Buffer.byteLength(run.stdout), stderr: run.stderr, ipcContacts: contacts - beforeContacts, ...(meter ? { fs: meter.result(), selectionMs: selectionMs - beforeSelection } : {}) }
          meter?.restore()
          if (run.stderr) throw new Error(`hook emitted stderr: ${run.stderr}`)
          if (variant === 'bound' && contacts <= beforeContacts) throw new Error(`bound ${hook} did not contact the MCP arbitration endpoint`)
        }
      } finally { await close() }
    }
  }
  return result
}

/** Real lifecycle-reading tool calls over two private workers; no host/model launched.
 * Collection uses keep=true and applies one file; spawn measures admission/writeIntent only. */
async function toolsSample(root: string): Promise<Record<string, Measurement>> {
  const common = path.join(root, '.git'), result: Record<string, Measurement> = {}
  const git = (...args: string[]) => {
    const run = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
    if (run.status !== 0) throw new Error(run.stderr)
    return run.stdout.trim()
  }
  git('config', 'user.name', 'Measurement'); git('config', 'user.email', 'measurement@example.test')
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n')
  fs.writeFileSync(path.join(root, '.gitignore'), '.room/\n')
  git('add', '.'); git('commit', '-qm', 'baseline')
  const head = git('rev-parse', 'HEAD')
  const { memorySession } = await source('packages/room-mcp/test/fixtures/session.js')
  const { visiblePeer, presentPeer } = await source('packages/room-mcp/test/fixtures/visible.js')
  const { createTools } = await source('packages/room-mcp/src/tools.js')
  const { registryForDir, closeRegistryForDir } = await source('packages/room-mcp/src/worker-registry.js')
  const { probeOwnProcess } = await source('packages/room-mcp/src/worker-process.js')
  const admission = fs.existsSync(path.join(sourceRoot, 'packages/room-mcp/src/storage-admission.ts'))
    ? await source('packages/room-mcp/src/storage-admission.js') : undefined
  const own = probeOwnProcess(), instance = { ...identity, startTime: own?.startTime ?? '', executable: own?.executable ?? process.execPath }
  for (const [n, tag] of ['running', 'finished'].entries()) {
    const worker = { ...record(common, n), id: `w_${tag}`, tag, name: `baseline+${tag}`, phase: 'active', base: head,
      dir: path.join(root, '.room/workers', tag), branch: `room/${tag}`, collectedKeep: true,
      lead: { participant: 'baseline', room: 'local/baseline', instance },
      runs: [{ ...record(common, n).runs[0], launch: { outcome: 'launched', pid: tag === 'finished' ? 4_000_000 : process.pid, process: { ...instance, pid: tag === 'finished' ? 4_000_000 : process.pid } } }] }
    git('worktree', 'add', '-qb', worker.branch, worker.dir, head)
    fs.writeFileSync(path.join(common, 'room/registry/workers', `${worker.id}.json`), JSON.stringify(worker))
    fs.writeFileSync(path.join(common, 'room/registry/tags', `${tag}.json`), JSON.stringify({ id: worker.id, holder: instance, at: 1 }))
    const runDir = path.join(common, 'room/registry/runs', worker.id)
    fs.mkdirSync(runDir, { recursive: true })
    // Use the public facade below for evidence files; its schemas/path layout belong to each revision.
  }
  const registry = await registryForDir(root)
  const running = await registry.read('w_running'), finished = await registry.read('w_finished')
  for (const worker of [running, finished]) await registry.writeReport(worker.id,
    { run: 1, nonce: worker.runs[0].nonce, chain: [], joinedAt: 1,
      ...(worker.tag === 'finished' ? { done: { at: Date.now(), summary: 'finished', changed: ['result.txt'] } } : {}) })
  await registry.writeExit('w_finished', { run: 1, code: 0, at: Date.now(), witnessed: true })
  fs.writeFileSync(path.join(finished.dir, 'result.txt'), 'collected\n')
  const session = memorySession({ name: 'baseline', kind: 'agent', owner: 'baseline' }, root, undefined, 'local/baseline')
  visiblePeer(session.room, 'baseline', 'agent', 'measurement')
  const leavePeer = presentPeer(session.room, session.awareness, 'baseline+running')
  session.local = { url: 'ws://127.0.0.1:9', port: 9, owned: false, stop: async () => {} }
  await session.policyStore.markDisclosed('full', 2)
  const tools = createTools({ getSession: () => session, setSession: () => {}, cwd: root,
    probe: () => undefined, listCwdProcesses: () => [], log: () => {} })
  const timed = async (name: string, fn: () => Promise<unknown>) => {
    const start = performance.now(); const value = await fn(); result[name] = { ms: performance.now() - start }
    if (typeof value === 'string' && /^(error:|not joined)/i.test(value)) throw new Error(`${name}: ${value}`)
    return value
  }
  try {
    // Establish tool/registry caches before measuring steady calls, exactly once on both revisions.
    await tools.call('room_state', {})
    await timed('room_state', () => tools.call('room_state', {}))
    await timed('room_send', () => tools.call('room_send', { type: 'note', to: 'baseline+running', text: 'measurement' }))
    await timed('room_done', () => tools.call('room_done', { summary: 'measurement' }))
    const collected = await timed('collect', () => tools.call('room_collect', { tag: 'finished', keep: true }))
    if (!fs.existsSync(path.join(root, 'result.txt'))) throw new Error(`collect did not apply fixture: ${collected}`)
    const spawn = async () => {
      await registry.snapshot()
      await registry.writeIntent(record(common, 2), 3)
      await registry.finishOperation(record(common, 2).id)
    }
    await timed('spawnAdmission', () => admission ? admission.withDirectoryAdmission(root, 'spawn', spawn) : spawn())
    return result
  } finally {
    await tools.shutdown(); await closeRegistryForDir(root); await admission?.closeStorageAdmissions()
    leavePeer(); session.graph?.stop(); session.hub.close(); session.awareness.destroy(); session.room.doc.destroy()
  }
}

async function extraPhase(args: string[]) {
  const phase = args.find(arg => arg.startsWith('--phase='))?.slice(8)
  const mode = args.find(arg => arg.startsWith('--hooks-mode='))?.slice(13) ?? 'both'
  const samples = Number(args.find(arg => arg.startsWith('--samples='))?.slice(10) ?? 5)
  const numeric = args.filter(arg => !arg.startsWith('--'))
  const sizes = phase === 'gate' ? (numeric.length ? numeric.map(Number) : [1, 64, 1024]) : [0]
  if (!['gate', 'hooks'].includes(phase!) || !['alone', 'bound', 'both'].includes(mode) ||
      !Number.isInteger(samples) || samples < 1 || samples > 100 ||
      sizes.some(n => !Number.isInteger(n) || n < (phase === 'gate' ? 1 : 0) || n > 1024) ||
      (phase === 'hooks' && numeric.length) ||
      args.some(arg => arg.startsWith('--') && !/^--(phase|hooks-mode|samples)=/.test(arg))) {
    throw new Error('usage: measure-lifecycle.mts --phase=gate [1 64 1024] --samples=1..100 | --phase=hooks [--hooks-mode=alone|bound|both] --samples=1..100')
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'room-lifecycle-measure-'))
  try {
    const disk = fs.statfsSync(temp)
    console.log(JSON.stringify({ kind: 'environment', phase, at: new Date().toISOString(),
      commit: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
      node: process.version, executable: fs.realpathSync(process.execPath), platform: process.platform, arch: process.arch,
      os: { type: os.type(), release: os.release(), version: os.version() },
      hardware: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem() },
      filesystem: { fixtureParent: os.tmpdir(), type: disk.type, blockSize: disk.bsize },
      fixture: { sizes, samples, hooksMode: mode, cache: 'fresh child and fixture per sample; no OS page-cache eviction',
        gate: 'N live preview tickets, timed extra admit+finish then observe; setup/cleanup excluded',
        hooks: 'real hook child wall time including Node startup; in-memory test Session + real arbitration for bound; no host/model calls',
        fsCounts: 'JS API calls only in gate measurement; no kernel syscall counts' } }))
    for (const count of sizes) {
      const runs: Record<string, Measurement>[] = []
      for (let sample = 0; sample < samples; sample++) {
        const root = path.join(temp, `${count}-${sample}`)
        const common = fixture(root, 0)
        // Fixture setup uses private directories so hook timings exclude legacy permission repair.
        for (const relative of ['room', 'room/registry', 'room/registry/workers', 'room/registry/tags'])
          fs.chmodSync(path.join(common, relative), 0o700)
        const run = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--extra-child', phase!, common, String(count), mode],
          { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
        if (run.status !== 0 || run.error) {
          console.log(JSON.stringify({ kind: 'failure', phase, liveTickets: count, sample, status: run.status, signal: run.signal,
            error: String(run.error ?? ''), stdout: run.stdout, stderr: run.stderr }))
          process.exitCode = 1; continue
        }
        const result = JSON.parse(run.stdout) as Record<string, Measurement>
        runs.push(result)
        console.log(JSON.stringify({ kind: 'sample', phase, liveTickets: count, sample, ...result }))
      }
      for (const operation of new Set(runs.flatMap(run => Object.keys(run)))) {
        const times = runs.map(run => run[operation].ms).sort((a, b) => a - b)
        const percentile = (q: number) => times[Math.max(0, Math.ceil(q * times.length) - 1)]
        console.log(JSON.stringify({ kind: 'summary', phase, operation, liveTickets: count,
          successfulSamples: runs.length, failedSamples: samples - runs.length, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99),
          fsCalls: runs.map(run => run[operation].fs?.total ?? null) }))
      }
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
}

const args = process.argv.slice(2)
if (args[0] === '--extra-child') {
  for (const key of Object.keys(process.env)) if (/^(ROOM_|CLAUDE_|CODEX_|GIT_)/.test(key)) delete process.env[key]
  try {
    const result = args[1] === 'gate' ? await gateSample(args[2], Number(args[3])) : args[1] === 'tools' ? await toolsSample(path.dirname(args[2])) : await hooksSample(path.dirname(args[2]), args[4])
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch (error) { console.error(error); process.exitCode = 1 }
} else if (args.some(arg => arg.startsWith('--phase='))) {
  await extraPhase(args)
} else if (args[0] === '--child') {
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
        status: 'list + status for every worker in one validated read', admission: 'gate ticket + writeIntent(capacity=N+1); excludes Git and host launch',
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
