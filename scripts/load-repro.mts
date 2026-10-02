// Usage: npx tsx scripts/load-repro.mts <source clone> [--branch b] [--workers 8] [--bundle <room-mcp.mjs>] [--profile <dir>] [--out <dir>]
// Reproduces the rc11 all-Codex rehearsal's load (R4): one lead and N workers in a team room on one machine.
// A local server (fake issuer, in memory) runs from source. The lead is the Room MCP bundle over stdio, as a host
// runs it. Each worker is a fake `codex` (first on the lead's PATH) that starts the same bundle in its worktree and
// does what the rehearsal's workers did: scope, claims on CHANGES.rst and source, edits, a preview, a commit,
// room_done, exit. Meanwhile the lead spawns them one by one and calls room_state / room_send every few seconds.
// Prints tool latencies (lead and workers), event-loop lag lines and graph index times from <git dir>/room-mcp.log.
// The source clone is only read (cloned with --single-branch, as the rehearsal's lead clone was).
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TSX = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs')
const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** A stdio MCP client for one Room MCP process. */
function mcp(cmd: string, argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; stderr?: string }) {
  const child = spawn(cmd, argv, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', opts.stderr ? fs.openSync(opts.stderr, 'a') : 'ignore'] })
  let buf = '', nextId = 1
  const waiting = new Map<number, (msg: any) => void>()
  child.stdout!.on('data', (c: Buffer) => {
    buf += c
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      try { const msg = JSON.parse(line); if (msg.id !== undefined) waiting.get(msg.id)?.(msg) } catch { /* not JSON */ }
    }
  })
  child.once('exit', code => { for (const resolve of waiting.values()) resolve({ error: { message: `MCP exited (${code})` } }); waiting.clear() })
  const rpc = (method: string, params: unknown = {}) => {
    const id = nextId++
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return new Promise<any>(resolve => waiting.set(id, resolve))
  }
  return {
    child,
    async init() {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'load-repro', version: '0' } })
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    },
    async call(name: string, a: object = {}) {
      const t = performance.now(); const r = await rpc('tools/call', { name, arguments: a })
      return { ms: Math.round(performance.now() - t), text: (r.result?.content ?? []).map((c: any) => c.text).join('\n') || JSON.stringify(r.error) }
    },
    close() { child.stdin!.end() },
  }
}

const AREAS = [
  { src: 'src/werkzeug/sansio/request.py', test: 'tests/test_wrappers.py' },
  { src: 'src/werkzeug/datastructures/accept.py', test: 'tests/test_http.py' },
  { src: 'src/werkzeug/http.py', test: 'tests/test_wrappers.py' },
  { src: 'src/werkzeug/http.py', test: 'tests/test_http.py' },
  { src: 'src/werkzeug/security.py', test: 'tests/test_security.py' },
  { src: 'src/werkzeug/_internal.py', test: 'tests/test_utils.py' },
  { src: 'src/werkzeug/serving.py', test: 'tests/test_serving.py' },
  { src: 'src/werkzeug/routing/map.py', test: 'tests/test_routing.py' },
]

/** A fake `codex exec` worker host: the Room MCP bundle in the worktree, driven like the rehearsal's workers. */
async function host(): Promise<void> {
  if (args.includes('--version')) { console.log('codex-cli 0.160.0'); return }
  const dir = process.cwd(), tag = process.env.ROOM_TAG ?? 'w'
  const index = Math.max(0, Number(/\d+/.exec(tag)?.[0] ?? 0)) % AREAS.length
  const area = AREAS[index]
  console.log(JSON.stringify({ type: 'thread.started', thread_id: `00000000-0000-7000-8000-${String(process.pid).padStart(12, '0')}` }))
  const m = mcp(process.execPath, [process.env.LOAD_BUNDLE!], { cwd: dir, env: { ...process.env, ROOM_HOST: 'codex', ROOM_DIR: dir, PWD: dir } })
  await m.init()
  const report = (tool: string, r: { ms: number; text: string }) => console.log(JSON.stringify({ type: 'load.tool', tag, tool, ms: r.ms, head: r.text.split('\n')[0].slice(0, 160) }))
  report('room_scope', await m.call('room_scope', { area: `issue ${tag}`, paths: [area.src, area.test, 'CHANGES.rst'] }))
  const lines = (p: string) => fs.readFileSync(path.join(dir, p), 'utf8').split('\n')
  const changesAt = 5 + index
  report('room_claim', await m.call('room_claim', { path: 'CHANGES.rst', from: changesAt, to: changesAt, intent: `${tag} changelog entry` }))
  const srcLines = lines(area.src).length
  const at = Math.max(1, Math.floor(srcLines * (0.2 + 0.08 * index)))
  report('room_claim', await m.call('room_claim', { path: area.src, from: at, to: at + 10, intent: `${tag} source change` }))
  const testAt = Math.max(1, Math.floor(lines(area.test).length * (0.1 + 0.1 * index)))
  report('room_claim', await m.call('room_claim', { path: area.test, from: testAt, to: testAt + 15, intent: `${tag} tests` }))
  await sleep(8000 + index * 1500)
  const edit = (p: string, n: number, text: string) => { const l = lines(p); l.splice(n, 0, text); fs.writeFileSync(path.join(dir, p), l.join('\n')) }
  edit('CHANGES.rst', changesAt, `-   ${tag}: a change. :issue:\`${4 + index}\``)
  edit(area.src, at, `# ${tag}: changed here`)
  edit(area.test, testAt, `# ${tag}: test here`)
  await sleep(6000)
  report('room_preview_merge', await m.call('room_preview_merge', {}))
  execFileSync('git', ['commit', '-qam', `${tag}: change`], { cwd: dir })
  await sleep(4000)
  report('room_done', await m.call('room_done', { summary: `${tag} committed` }))
  m.close()
  await new Promise(r => m.child.once('exit', r))
}

async function orchestrate(): Promise<void> {
  const source = path.resolve(args[0] ?? '')
  const branch = flag('--branch') ?? execFileSync('git', ['-C', source, 'branch', '--show-current'], { encoding: 'utf8' }).trim()
  const workers = Number(flag('--workers') ?? 8)
  const bundle = path.resolve(flag('--bundle') ?? path.join(ROOT, 'plugins/room/server/room-mcp.mjs'))
  const profile = flag('--profile')
  const out = path.resolve(flag('--out') ?? `/tmp/room-load-${process.pid}`)
  if (!/^\/(private\/)?tmp\//.test(out)) throw new Error('--out must be under /tmp')
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })
  const lead = path.join(out, 'lead')
  execFileSync('git', ['clone', '-q', '--single-branch', '-b', branch, source, lead])
  execFileSync('git', ['-C', lead, 'remote', 'set-url', 'origin', 'https://github.com/acme/werk.git'])
  execFileSync('git', ['-C', lead, 'config', 'user.name', 'Ana']); execFileSync('git', ['-C', lead, 'config', 'user.email', 'ana@example.test'])
  // Fake `codex`: this script's host mode under the worker's environment.
  const bin = path.join(out, 'bin'); fs.mkdirSync(bin); fs.mkdirSync(path.join(out, 'codex-home'))
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${TSX}" "${fileURLToPath(import.meta.url)}" host "$@"\n`, { mode: 0o755 })

  const port = await new Promise<number>((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) }) })
  const http = `http://127.0.0.1:${port}`, ws = `ws://127.0.0.1:${port}`
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ROOM_|CLAUDE_CODE_|CODEX_)/.test(k)))
  const server: ChildProcess = spawn(process.execPath, [TSX, path.join(ROOT, 'packages/server/src/index.ts')], {
    env: { ...clean, HOST: '127.0.0.1', PORT: String(port), GITHUB_CLIENT_ID: 'fake', NODE_ENV: 'development' }, stdio: 'ignore',
  })
  const children: ChildProcess[] = [server]
  try {
    for (let i = 0; i < 200; i++) { try { if ((await fetch(`${http}/health`)).ok) break } catch { /* starting */ } await sleep(100) }
    const post = (p: string, body: unknown) => fetch(`${http}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const device = (await (await post('/auth/device', {})).json() as { device: string }).device
    const { session } = await (await post('/auth/poll', { device, fakeLogin: 'ana' })).json() as { session: string }
    if (!(await post('/rooms', { room: 'github.com/acme/werk', session, schema: 2 })).ok) throw new Error('could not open the room')
    const credentials = path.join(out, 'credentials.json')
    fs.writeFileSync(credentials, JSON.stringify({ [ws]: { session, login: 'ana', at: Date.now() } }), { mode: 0o600 })
    const env = { ...clean, PATH: `${bin}:${process.env.PATH}`, ROOM_SERVER: ws, ROOM_CREDENTIALS: credentials, ROOM_AUTO_FETCH: '0',
      ROOM_HOST: 'codex', ROOM_DIR: lead, PWD: lead, LOAD_BUNDLE: bundle,
      // An empty Codex home: no installed Room plugin to compare with (the fake host loads the bundle itself).
      CODEX_HOME: path.join(out, 'codex-home') }
    const m = mcp(process.execPath, [...(profile ? ['--cpu-prof', `--cpu-prof-dir=${path.resolve(profile)}`] : []), bundle], { cwd: lead, env, stderr: path.join(out, 'lead.stderr') })
    children.push(m.child)
    await m.init()
    const t0 = performance.now()
    const samples: { tool: string; ms: number }[] = []
    const record = (tool: string, r: { ms: number; text: string }) => { samples.push({ tool, ms: r.ms }); return r }
    console.log(`join: ${record('room_state', await m.call('room_state')).ms} ms`)
    record('room_scope', await m.call('room_scope', { area: 'integration', paths: ['src/werkzeug/', 'tests/', 'CHANGES.rst'] }))
    let polling = true
    const poll = (async () => {
      for (let i = 0; polling; i++) {
        await sleep(3000)
        if (!polling) break
        record('room_state', await m.call('room_state'))
        if (i % 2) record('room_send', await m.call('room_send', { type: 'note', text: `lead note ${i}`, to: `ana+i${4 + (i % workers)}` }))
      }
    })()
    for (let i = 0; i < workers; i++) {
      const r = record('room_spawn', await m.call('room_spawn', { tag: `i${4 + i}`, task: `issue ${4 + i}`, host: 'codex', model: 'fake', carry: false }))
      console.log(`spawn i${4 + i}: ${r.ms} ms ${r.text.split('\n')[0].slice(0, 100)}`)
    }
    const deadline = Date.now() + 240_000
    let done = 0
    while (done < workers && Date.now() < deadline) {
      const r = await m.call('room_wait', { timeoutMs: 20_000 })
      done += (r.text.match(/finished:/g) ?? []).length
    }
    polling = false
    await poll
    console.log(`workers done: ${done}/${workers} in ${Math.round((performance.now() - t0) / 1000)} s`)
    const by = new Map<string, number[]>()
    for (const s of samples) by.set(s.tool, [...by.get(s.tool) ?? [], s.ms])
    const workerTools: { tool: string; ms: number }[] = []
    const workerDir = path.join(lead, '.room', 'workers')
    for (const f of (fs.existsSync(workerDir) ? fs.readdirSync(workerDir) : []).filter(f => f.endsWith('.log') && !f.endsWith('.mcp.log'))) {
      for (const line of fs.readFileSync(path.join(workerDir, f), 'utf8').split('\n')) {
        try { const e = JSON.parse(line); if (e.type === 'load.tool') workerTools.push({ tool: `worker ${e.tool}`, ms: e.ms }) } catch { /* banner */ }
      }
    }
    for (const s of workerTools) by.set(s.tool, [...by.get(s.tool) ?? [], s.ms])
    const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
    for (const [tool, xs] of [...by].sort()) console.log(`${tool.padEnd(26)} n=${String(xs.length).padStart(3)}  p50 ${String(pct(xs, 0.5)).padStart(6)} ms  max ${String(Math.max(...xs)).padStart(6)} ms`)
    m.close()
    await new Promise(r => { m.child.once('exit', r); setTimeout(r, 15_000) })
    const log = fs.readFileSync(path.join(lead, '.git', 'room-mcp.log'), 'utf8').split('\n')
    const lags = log.filter(l => l.includes('event loop lag')).map(l => Number(/lag (\d+)ms/.exec(l)?.[1]))
    console.log(`event loop lag lines: ${lags.length}${lags.length ? `, max ${Math.max(...lags)} ms, total ${lags.reduce((a, b) => a + b, 0)} ms` : ''}`)
    const graphs = log.filter(l => l.includes('graph: indexed')).map(l => Number(/in (\d+)ms/.exec(l)?.[1]))
    console.log(`graph index: n=${graphs.length} max ${Math.max(...graphs)} ms`)
    for (const l of log.filter(l => /slow tool|event loop lag/.test(l))) fs.appendFileSync(path.join(out, 'slow.log'), l + '\n')
    console.log(`log: ${path.join(lead, '.git', 'room-mcp.log')}; slow lines: ${path.join(out, 'slow.log')}`)
  } finally {
    for (const c of children.reverse()) c.kill()
    // Fake hosts and their MCPs are this run's processes; nothing else runs under the scratch dir.
    for (const row of execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n')) {
      const [pid, ...command] = row.trim().split(/\s+/)
      if (command.join(' ').includes(out) && Number(pid) !== process.pid) try { process.kill(Number(pid)) } catch { /* gone */ }
    }
  }
}

if (args[0] === 'host') { args.shift(); await host() } else await orchestrate()
