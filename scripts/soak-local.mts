#!/usr/bin/env tsx
/**
 * Local daemon soak, Linux/macOS, no model calls. Uses this checkout's BUILT plugin.
 *   npx tsx scripts/soak-local.mts run [--minutes 180] [--sessions 4] [--sample-seconds 60]
 *     [--churn-seconds 90] [--idle-every-minutes 30] [--idle-minutes 6] [--keep]
 *     [--output /tmp/local-soak.jsonl]
 *   npx tsx scripts/soak-local.mts run --minutes 3 --sample-seconds 15  # smoke, no idle exit
 *   npx tsx scripts/soak-local.mts report /tmp/local-soak.jsonl
 *
 * Each generation joins real MCPs, exchanges notes/questions/answers, claims, edits,
 * releases, scopes, waits and reports done. Alternate generations leave/exit directly.
 * Fixed-size files and reused identities avoid intentionally growing input data.
 * Every 30 minutes all clients close for SIX minutes (the production five-minute
 * timeout is unchanged); the next generation verifies a different daemon nonce.
 * Workers SKIPPED: Windows CI's fake host requires an injected launchWorkerProcess
 * spawner; the built MCP has no such injection. No real host executable is invoked.
 * Y.Doc/bus bytes unavailable from public health/state; disk persistence is measured.
 *
 * JSONL survives cleanup, outside the disposable repo. Includes raw per-PID RSS,
 * CPU seconds, FD counts (null if unavailable), per-tool interval p50/p95, disk trees,
 * events, failures, phases and daemon nonces. No credentials or real host homes used.
 * Report excludes idle/churn samples, compares first/last thirds, fits OLS to last
 * two thirds, and requires BOTH latter third means to rise. GROWING threshold/hour:
 * max(10% first-third mean, 1 MiB bytes/RSS, 2 counts, 10ms latency, 1 CPU %-point).
 * CPU time is cumulative by definition: report its per-PID interval rate instead.
 * MCP trends use per-process mean/max (individual PID lifetimes are short).
 * PASS means no detected growth, not proof of boundedness. <9 active samples or
 * <30 minutes is WARN/insufficient. Exit 1 growth; 2 failed/incomplete run. Smoke can
 * exit 0 with insufficient-data warnings. SIGINT/TERM cleans up and exits 2. If process cleanup cannot be verified, the
 * temp directory is retained with a diagnostic instead of deleting live state.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const exec = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
type Sample = { kind: 'sample'; t: number; phase: string; metrics: Record<string, number>; [key: string]: unknown }
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length
function report(file: string): number {
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  const samples = rows.filter((r): r is Sample => r.kind === 'sample' && r.phase === 'active')
  console.log('Metric | first third | last third | slope/hour | threshold/hour | result')
  let growing = false
  for (const key of [...new Set(samples.flatMap(s => Object.keys(s.metrics)))].sort()) {
    const points = samples.filter(s => Number.isFinite(s.metrics[key]))
    const n = Math.floor(points.length / 3)
    if (!n) { console.log(`${key} | - | - | - | - | WARN insufficient samples`); continue }
    const a = mean(points.slice(0, n).map(s => s.metrics[key]))
    const b = mean(points.slice(n, 2 * n).map(s => s.metrics[key]))
    const c = mean(points.slice(-n).map(s => s.metrics[key]))
    const tail = points.slice(n), xs = tail.map(s => (s.t - points[0].t) / 3600000)
    const ys = tail.map(s => s.metrics[key]), xm = mean(xs), ym = mean(ys)
    const variance = xs.reduce((v, x) => v + (x - xm) ** 2, 0)
    const slope = variance ? xs.reduce((v, x, i) => v + (x - xm) * (ys[i] - ym), 0) / variance : 0
    const floor = /Bytes/.test(key) ? 1048576 : /Ms/.test(key) ? 10 : /cpuPercent/.test(key) ? 1 : 2
    const threshold = Math.max(Math.abs(a) * .1, floor)
    const enough = points.length >= 9 && points.at(-1)!.t - points[0].t >= 30 * 60000
    const rises = enough && slope > threshold && b > a && c > b
    growing ||= rises
    console.log(`${key} | ${a.toFixed(2)} | ${c.toFixed(2)} | ${slope.toFixed(2)} | ${threshold.toFixed(2)} | ${rises ? 'WARN GROWING' : enough ? 'PASS' : 'WARN insufficient duration/samples'}`)
  }
  const failed = rows.some(r => r.kind === 'failure') || !rows.some(r => r.kind === 'complete')
  console.log(`Run: ${failed ? 'WARN failed/incomplete' : 'PASS completed'}; workers: SKIPPED; Y.Doc/bus bytes: unavailable`)
  if (!samples.length) console.log('WARN no active samples')
  return failed ? 2 : growing ? 1 : 0
}

const args = process.argv.slice(2), command = args.shift()
if (command === 'report') { process.exitCode = report(args[0]); }
else if (command === 'run') { await run() }
else throw new Error('Usage: npx tsx scripts/soak-local.mts run [options] | report FILE (see script header)')

async function run() {
  if (process.platform === 'win32') throw new Error('Requires Linux/macOS ps; Windows fake-host tests are separate')
  const options: Record<string, number> = { minutes: 180, sessions: 4, 'sample-seconds': 60, 'churn-seconds': 90, 'idle-every-minutes': 30, 'idle-minutes': 6 }
  let keep = false, output = path.join(os.tmpdir(), `room-local-soak-${Date.now()}.jsonl`)
  while (args.length) {
    const flag = args.shift()!
    if (flag === '--keep') { keep = true; continue }
    if (flag === '--output') { output = path.resolve(args.shift()!); continue }
    const key = flag.slice(2), value = Number(args.shift())
    if (!flag.startsWith('--') || !(key in options) || !Number.isFinite(value) || value <= 0) throw new Error(`Invalid option ${flag}`)
    options[key] = value
  }
  if (!Number.isInteger(options.sessions) || options.sessions < 2 || options.sessions > 64) throw new Error('--sessions must be 2..64')
  if (options['idle-minutes'] <= 5) throw new Error('--idle-minutes must exceed 5')
  const entry = path.join(root, 'plugins/room/server/room-mcp.mjs')
  for (const file of [entry, path.join(root, 'plugins/room/server/room-daemon.mjs')]) fs.accessSync(file)
  // Exclusive creation prevents overwriting any user's existing file.
  const fd = fs.openSync(output, 'wx', 0o600)
  const emit = (kind: string, data: Record<string, unknown> = {}) => fs.writeSync(fd, JSON.stringify({ kind, t: Date.now(), ...data }) + '\n')
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-local-soak-')))
  const repo = path.join(temp, 'repo'), home = path.join(temp, 'home'), common = path.join(repo, '.git'), room = path.join(common, 'room')
  fs.mkdirSync(repo); fs.mkdirSync(home); fs.mkdirSync(path.join(temp, 'tmp'))
  // Allowlist, never inherit host tokens/config/identities, git overrides or Node loaders.
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, USERPROFILE: home,
    TMPDIR: path.join(temp, 'tmp'), TMP: path.join(temp, 'tmp'), TEMP: path.join(temp, 'tmp'),
    XDG_CONFIG_HOME: path.join(home, '.config'), CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', ROOM_DIR: repo, ROOM_WAKE: 'off', ROOM_SERVER: 'local' }
  const git = async (...a: string[]) => (await exec('git', ['-C', repo, ...a], { env, timeout: 10000 })).stdout
  const abort = new AbortController()
  const interrupt = () => abort.abort(new Error('interrupted by signal'))
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  const pause = (ms: number) => delay(ms, undefined, { signal: abort.signal })
  const clients: { client: Client; transport: StdioClientTransport; name: string; stderr: string }[] = []
  let phase = 'setup', generation = 0, sampling: Promise<void> | undefined, failed = false, cleanupFailed = false
  let timings: Record<string, number[]> = {}
  const cpu = new Map<number, { t: number; seconds: number }>()
  const discovery = () => { try { return JSON.parse(fs.readFileSync(path.join(room, 'relay.json'), 'utf8')) as { pid: number; nonce: string; port: number } } catch { return undefined } }
  async function call(c: typeof clients[number], name: string, arguments_: Record<string, unknown> = {}, expected?: RegExp) {
    abort.signal.throwIfAborted()
    const start = performance.now()
    try {
      const result = await c.client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 70000, signal: abort.signal })
      const text = (result.content as { text?: string }[]).map(x => x.text ?? '').join('\n')
      if (result.isError || /^error:|could not join|not in (?:a|the local) room/im.test(text) || expected && !expected.test(text)) throw new Error(`${name}: ${text}\nstderr: ${c.stderr}`)
      emit('tool', { tool: name, session: c.name, ms: performance.now() - start })
      return text
    } finally { (timings[name] ??= []).push(performance.now() - start) }
  }
  async function closeClients() {
    for (const c of clients.splice(0)) await c.client.close().catch(() => {})
  }
  function disk(dir: string): { files: number; dirs: number; bytes: number } {
    const result = { files: 0, dirs: 0, bytes: 0 }
    try {
      for (const name of fs.readdirSync(dir)) {
        try {
          const file = path.join(dir, name), st = fs.lstatSync(file)
          if (st.isDirectory()) { const d = disk(file); result.dirs += 1 + d.dirs; result.files += d.files; result.bytes += d.bytes }
          else { result.files++; result.bytes += st.size } // never follow symlinks
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    return result
  }
  async function processStats(pid: number, role: string) {
    try {
      const raw = (await exec('ps', ['-p', String(pid), '-o', 'rss=,time='], { timeout: 5000 })).stdout.trim().split(/\s+/)
      const time = raw[1].split('-'), days = time.length === 2 ? Number(time.shift()) : 0
      const seconds = days * 86400 + time[0].split(':').reduce((s, v) => s * 60 + Number(v), 0)
      let fds: number | null = null
      try { fds = fs.readdirSync(`/proc/${pid}/fd`).length } catch {
        try { fds = (await exec('lsof', ['-nP', '-a', '-p', String(pid), '-Ff'], { timeout: 5000 })).stdout.split('\n').filter(l => /^f\d/.test(l)).length } catch { /* unavailable */ }
      }
      const prev = cpu.get(pid), t = Date.now(); cpu.set(pid, { t, seconds })
      return { pid, role, rssBytes: Number(raw[0]) * 1024, cpuSeconds: seconds, fds,
        cpuPercent: prev && seconds >= prev.seconds ? (seconds - prev.seconds) / (t - prev.t) * 100000 : null }
    } catch (e) {
      // ps exits 1 for a vanished PID; a denied/missing sampler is a run failure.
      if ((e as { code?: unknown }).code === 1) return null
      throw e
    }
  }
  async function sample() {
    const info = discovery(), snapshotPhase = phase, t = Date.now(), interval = timings; timings = {}
    const processes = (await Promise.all([
      ...(info ? [processStats(info.pid, 'daemon')] : []),
      ...clients.filter(c => c.transport.pid).map(c => processStats(c.transport.pid!, 'mcp')),
    ])).filter(p => p !== null)
    for (const pid of cpu.keys()) if (!processes.some(p => p.pid === pid)) cpu.delete(pid)
    const metrics: Record<string, number> = {}, trees: Record<string, unknown> = {}
    const dirs = new Set(['registry', 'sessions', 'logs', 'preview', 'previews'])
    if (fs.existsSync(room)) for (const name of fs.readdirSync(room)) if (fs.lstatSync(path.join(room, name)).isDirectory()) dirs.add(name)
    for (const [name, dir] of [['room', room], ['workers', path.join(repo, '.room/workers')], ...[...dirs].map(n => [`room/${n}`, path.join(room, n)])]) {
      const d = disk(dir); trees[name] = d
      for (const [k, v] of Object.entries(d)) metrics[`${name}.${k === 'bytes' ? 'Bytes' : k}`] = v
    }
    metrics.worktrees = (await git('worktree', 'list', '--porcelain')).split('\n').filter(l => l.startsWith('worktree ')).length
    for (const role of ['daemon', 'mcp']) for (const key of ['rssBytes', 'fds', 'cpuPercent'] as const) {
      const values = processes.filter(p => p.role === role).map(p => p[key]).filter((v): v is number => v !== null)
      if (values.length) { metrics[`${role}.${key}.mean`] = mean(values); metrics[`${role}.${key}.max`] = Math.max(...values) }
    }
    const latency: Record<string, unknown> = {}
    for (const [name, values] of Object.entries(interval)) {
      values.sort((a, b) => a - b)
      const p50 = values[Math.ceil(values.length * .5) - 1], p95 = values[Math.ceil(values.length * .95) - 1]
      latency[name] = { count: values.length, p50, p95 }
      metrics[`${name}.p50Ms`] = p50; metrics[`${name}.p95Ms`] = p95
    }
    let health: unknown = null
    if (info) try { health = await (await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(2000) })).json() } catch { /* idle exit */ }
    emit('sample', { t, phase: snapshotPhase, generation, daemonNonce: info?.nonce, processes, trees, latency, health, metrics })
    console.error(`sample ${snapshotPhase}: ${processes.length} processes, ${metrics['room.Bytes']} room bytes`)
  }
  try {
    emit('start', { options, temp, entry, platform: process.platform, node: process.version, workers: 'SKIPPED: fake-host fixture requires injected spawner', yDocBus: 'unavailable in health/state' })
    console.error(`Temp: ${temp}\nSamples: ${output}`)
    await git('init', '-q', '-b', 'main'); await git('config', 'user.name', 'Soak'); await git('config', 'user.email', 'soak@example.invalid')
    fs.writeFileSync(path.join(repo, '.gitignore'), '.room/\n')
    for (let i = 0; i < options.sessions; i++) fs.writeFileSync(path.join(repo, `file-${i}.txt`), 'initial\n')
    await git('add', '.'); await git('commit', '-qm', 'synthetic soak fixture')
    // One linked worktree per simulated session, as parallel agents use: Room shares one checkout's file changes once,
    // so sessions in a single checkout would not publish their edits under their own names.
    const worktrees = Array.from({ length: options.sessions }, (_, i) => path.join(path.dirname(repo), `slot${i}`))
    for (const [i, dir] of worktrees.entries()) await git('worktree', 'add', '-q', '-b', `slot${i}`, dir)
    const start = Date.now(), deadline = start + options.minutes * 60000
    let nextIdle = start + options['idle-every-minutes'] * 60000, previousNonce: string | undefined
    sampling = (async () => { while (!abort.signal.aborted) { await pause(options['sample-seconds'] * 1000); await sample() } })()
    void sampling.catch(e => { if (!abort.signal.aborted) { emit('failure', { step: 'sampling', error: String(e) }); failed = true; abort.abort(e) } })
    while (Date.now() < deadline) {
      abort.signal.throwIfAborted(); phase = 'churn'; generation++
      for (let i = 0; i < options.sessions; i++) {
        const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: worktrees[i], env: { ...env, ROOM_DIR: worktrees[i], ROOM_NAME: 'Soak', ROOM_TAG: `slot${i}` }, stderr: 'pipe' })
        const c = { client: new Client({ name: 'local-soak', version: '1' }), transport, name: `Soak+slot${i}`, stderr: '' }; clients.push(c)
        transport.stderr?.on('data', d => { c.stderr = (c.stderr + String(d)).slice(-16000) })
        await c.client.connect(transport)
        await call(c, 'room_join', { where: 'local', dir: worktrees[i], name: 'Soak', share: 'full' }, /joined|already in|^you: .+ in local\//m)
        await call(c, 'room_scope', { area: `slot${i}`, summary: 'synthetic soak', paths: Array.from({ length: options.sessions }, (_, slot) => `file-${slot}.txt`) }, /scope set/)
      }
      if (previousNonce && discovery()?.nonce === previousNonce) throw new Error('Daemon did not exit/restart across idle gap')
      if (previousNonce) emit('idle-restarted', { oldNonce: previousNonce, nonce: discovery()?.nonce })
      previousNonce = undefined; phase = 'active'; await sample()
      const until = Math.min(deadline, Date.now() + options['churn-seconds'] * 1000, nextIdle)
      while (Date.now() < until) {
        for (let i = 0; i < clients.length; i++) {
          const c = clients[i], peer = clients[(i + 1) % clients.length], file = `file-${i}.txt`
          await call(c, 'room_state')
          await call(c, 'room_send', { type: 'note', text: 'synthetic progress', priority: 'fyi' }, /sent \[/)
          const question = await call(c, 'room_send', { type: 'question', to: peer.name, text: 'Ready?', priority: 'fyi' }, /sent \[/)
          const id = /sent \[([^\]]+)\]/.exec(question)![1]
          await call(peer, 'room_wait', { questionId: id, timeoutMs: 100 })
          await call(peer, 'room_send', { type: 'answer', inReplyTo: id, text: 'Ready.', priority: 'fyi' }, /sent \[/)
          await call(c, 'room_wait', { questionId: id, timeoutMs: 100 })
          const claim = await call(c, 'room_claim', { path: file, from: 1, to: 1, intent: 'synthetic edit' }, /claimed c_/)
          const content = `generation ${generation} time ${Date.now()}`
          fs.writeFileSync(path.join(worktrees[i], file), content + '\n')
          // Publication latency is a tracked metric (a growing trend is a finding); only a 30 s miss fails the run.
          const written = performance.now()
          let published = false
          while (performance.now() - written < 30_000) {
            await pause(250)
            if ((await call(peer, 'room_read', { person: c.name, path: file })).includes(content)) { published = true; break }
          }
          if (!published) throw new Error(`Overlay did not publish within 30 s for ${c.name}/${file}`)
          ;(timings.publish ??= []).push(performance.now() - written)
          await call(c, 'room_release', { claimId: /claimed (c_\w+)/.exec(claim)![1], summary: 'updated synthetic file' }, /released/)
        }
        await pause(Math.min(5000, Math.max(1, until - Date.now())))
      }
      for (const c of clients) { await call(c, 'room_done', { summary: 'synthetic iteration complete' }); if (generation % 2) await call(c, 'room_leave') }
      phase = 'churn'; await closeClients()
      if (Date.now() >= nextIdle && Date.now() + options['idle-minutes'] * 60000 < deadline) {
        phase = 'idle'; previousNonce = discovery()?.nonce; emit('idle-start', { nonce: previousNonce })
        await pause(options['idle-minutes'] * 60000)
        const info = discovery()
        if (info && await processStats(info.pid, 'daemon')) throw new Error('Daemon still alive after idle gap')
        emit('idle-exited', { nonce: previousNonce }); nextIdle = Date.now() + options['idle-every-minutes'] * 60000
      } else if (Date.now() >= nextIdle) nextIdle = Infinity
    }
    emit('complete')
  } catch (e) { failed = true; emit('failure', { step: phase, error: String(e) }); console.error(e) }
  finally {
    abort.abort(); await sampling?.catch(() => {}); await closeClients()
    // Only processes whose command includes THIS freshly-created temp root. Also
    // catches detached daemon startup contenders before relay.json publication.
    try {
      const rows = (await exec('ps', ['-ax', '-o', 'pid=,command='], { timeout: 5000 })).stdout.split('\n')
      const pids = rows.flatMap(l => { const m = /^\s*(\d+)\s+(.*)$/.exec(l); return m && m[2].includes(temp) && m[2].includes('room-daemon.mjs') ? [Number(m[1])] : [] })
      for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch {} }
      if (pids.length) await delay(1500)
      // Recheck command identity before escalation, avoiding stale/reused PIDs.
      for (const pid of pids) try { if ((await exec('ps', ['-p', String(pid), '-o', 'command='])).stdout.includes(temp)) process.kill(pid, 'SIGKILL') } catch {}
    } catch (e) { failed = true; cleanupFailed = true; emit('failure', { step: 'cleanup', error: String(e) }) }
    if (!keep && !cleanupFailed) fs.rmSync(temp, { recursive: true, force: true })
    else console.error(`Retained ${temp}${cleanupFailed ? ': process cleanup could not be verified' : ' (--keep)'}`)
    fs.closeSync(fd); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
  }
  process.exitCode = Math.max(failed ? 2 : 0, report(output))
}
