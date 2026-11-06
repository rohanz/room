/** Alternating A/B fresh-process measurements; the driver is shared, target sources are isolated.
 * node --import tsx scripts/measure-lifecycle-interleaved.mts --baseline-root=<checkout> --phase=hooks|tools --samples=40
 * Baseline checkout needs workspace links resolving @room/* to its own sources. No live Room state is used.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const options = Object.fromEntries(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)] }))
const baseline = options['baseline-root'], phase = options.phase ?? 'hooks', samples = Number(options.samples ?? 40)
if (!baseline || !['hooks', 'tools'].includes(phase) || !Number.isInteger(samples) || samples < 1 || samples > 100) throw new Error('provide --baseline-root=<checkout> --phase=hooks|tools --samples=1..100')
const candidate = fileURLToPath(new URL('../', import.meta.url)), script = path.join(candidate, 'scripts/measure-lifecycle.mts')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'room-interleaved-'))
const runs: Record<string, Record<string, { ms: number }>[]> = { baseline: [], candidate: [] }
const env = { ...process.env }
for (const key of Object.keys(env)) if (/^(ROOM_|CLAUDE_|CODEX_|GIT_)/.test(key)) delete env[key]
console.log(JSON.stringify({ kind: 'environment', at: new Date().toISOString(), phase, samples, baseline, candidate,
  node: process.version, executable: fs.realpathSync(process.execPath), platform: process.platform, arch: process.arch,
  cpu: os.cpus()[0]?.model, memory: os.totalmem(), filesystem: fs.statfsSync(temp).type,
  fixture: 'fresh private Git clone and child per observation; alternating AB/BA pairs; OS page cache not cleared; one child at a time; hooks use real arbitration with in-memory session; tools use two workers, no host/model; collect applies one file with keep=true; spawn admission excludes checkout and host launch' }))
try {
  for (let sample = 0; sample < samples; sample++) for (const label of sample % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    const root = path.join(temp, `${label}-${sample}`), common = path.join(root, '.git')
    const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8', env })
    if (init.status !== 0) throw new Error(init.stderr)
    for (const dir of ['room', 'room/registry', 'room/registry/workers', 'room/registry/tags']) fs.mkdirSync(path.join(common, dir), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(common, 'room/registry/migration.json'), JSON.stringify({ v: 1, sources: {}, done: true }))
    const source = label === 'baseline' ? path.resolve(baseline) : candidate
    const run = spawnSync(process.execPath, ['--import', 'tsx', script, '--extra-child', phase, common, '0', 'bound', `--source-root=${source}`],
      { cwd: candidate, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
    if (run.status !== 0 || run.error) {
      console.log(JSON.stringify({ kind: 'failure', sample, label, status: run.status, error: String(run.error ?? ''), stdout: run.stdout, stderr: run.stderr }))
      process.exitCode = 1
      continue
    }
    const data = JSON.parse(run.stdout)
    runs[label].push(data)
    console.log(JSON.stringify({ kind: 'sample', sample, label, ...data }))
  }
  for (const [label, values] of Object.entries(runs)) for (const operation of new Set(values.flatMap(value => Object.keys(value)))) {
    const sorted = values.map(value => value[operation].ms).sort((a, b) => a - b)
    const percentile = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]
    console.log(JSON.stringify({ kind: 'summary', label, operation, successfulSamples: values.length, failedSamples: samples - values.length,
      p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99) }))
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }) }
