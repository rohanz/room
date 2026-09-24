// Usage: npx tsx scripts/measure-room-perf.mts <clone> [--bundle <room-mcp.mjs>] [--idle <s>] [--edit <source file>] [--preview] [--profile <dir>]
// Measures one Room MCP server on a real clone, the way a host runs it (stdio MCP, local room):
// join time, CPU while idle, log lines written, and optionally room_preview_merge time. With --edit, the
// idle window is a working session instead: every 2 s the file gets a new line (restored afterwards) and
// 200 files land in test-results/ as a Playwright run writes traces.
// Run it on a copy-on-write copy of the repo (cp -Rc), never on a clone with live Room sessions.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined }
const has = (name: string) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0 }
const bundle = path.resolve(flag('--bundle') ?? 'plugins/room/server/room-mcp.mjs')
const idleS = Number(flag('--idle') ?? 60)
const profile = flag('--profile')
const preview = has('--preview')
const edit = flag('--edit')
const dir = path.resolve(args[0] ?? '')
if (!args[0] || !fs.existsSync(path.join(dir, '.git'))) throw new Error('usage: measure-room-perf.mts <clone> [--bundle f] [--idle s] [--preview] [--profile dir]')

const logFile = path.join(execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: dir, encoding: 'utf8' }).trim().replace(/^(?!\/)/, `${dir}/`), 'room-mcp.log')
const logLines = () => { try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length } catch { return 0 } }
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ROOM_|CLAUDE_CODE_MESSAGING|CLAUDE_CODE_SESSION_ID)/.test(k)))
const child = spawn(process.execPath, [...(profile ? ['--cpu-prof', `--cpu-prof-dir=${path.resolve(profile)}`] : []), bundle], {
  cwd: dir, env: { ...env, ROOM_HOST: 'claude', ROOM_DIR: dir, PWD: dir }, stdio: ['pipe', 'pipe', 'pipe'],
})
let buf = ''
const waiting = new Map<number, (msg: any) => void>()
child.stdout.on('data', (c: Buffer) => {
  buf += c
  for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    try { const msg = JSON.parse(line); if (msg.id !== undefined) waiting.get(msg.id)?.(msg) } catch { /* not JSON */ }
  }
})
child.stderr.on('data', () => {})
let nextId = 1
function rpc(method: string, params: unknown = {}): Promise<any> {
  const id = nextId++
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise(resolve => waiting.set(id, resolve))
}
const call = async (name: string, a: object = {}) => {
  const t = Date.now(); const r = await rpc('tools/call', { name, arguments: a })
  return { ms: Date.now() - t, text: (r.result?.content ?? []).map((c: any) => c.text).join('\n') || JSON.stringify(r.error) }
}
/** CPU seconds of the server and its descendants (the relay runs in-process; git children come and go). */
function cpuSeconds(): number {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time='], { encoding: 'utf8' }).trim().split('\n').map(r => r.trim().split(/\s+/))
  const tree = new Set([String(child.pid)])
  for (let grew = true; grew;) { grew = false; for (const [pid, ppid] of rows) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true } }
  let total = 0
  for (const [pid, , time] of rows) if (tree.has(pid)) {
    const parts = time.split(':').map(Number); total += parts.reduce((acc, v) => acc * 60 + v, 0)
  }
  return total
}

const startLines = logLines()
const t0 = Date.now()
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'measure-room-perf', version: '0' } })
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
const state = await call('room_state')
console.log(`join+room_state: ${Date.now() - t0} ms`)
console.log(state.text.split('\n').slice(0, 3).join('\n'))
await new Promise(r => setTimeout(r, 5000))
const cpu0 = cpuSeconds(), lines0 = logLines(), idleStart = Date.now()
const original = edit ? fs.readFileSync(path.join(dir, edit)) : undefined
const traces = path.join(dir, 'test-results', `measure-${process.pid}`)
let tick = 0
const churn = edit ? setInterval(() => {
  tick++
  fs.appendFileSync(path.join(dir, edit), `// measure ${tick}\n`)
  fs.mkdirSync(traces, { recursive: true })
  for (let i = 0; i < 200 / (idleS / 2); i++) fs.writeFileSync(path.join(traces, `page-${tick}-${i}.jpeg`), 'frame')
}, 2000) : undefined
await new Promise(r => setTimeout(r, idleS * 1000))
clearInterval(churn)
if (original) fs.writeFileSync(path.join(dir, edit!), original)
fs.rmSync(traces, { recursive: true, force: true })
const cpu1 = cpuSeconds(), lines1 = logLines(), idleMs = Date.now() - idleStart
console.log(`${edit ? 'editing' : 'idle'} ${Math.round(idleMs / 1000)} s: cpu ${(cpu1 - cpu0).toFixed(2)} s (${(100 * (cpu1 - cpu0) / (idleMs / 1000)).toFixed(1)}%), log lines ${lines1 - lines0}`)
if (preview) {
  const r = await call('room_preview_merge', { includeOffline: true })
  console.log(`room_preview_merge: ${r.ms} ms\n${r.text.split('\n').slice(0, 6).join('\n')}`)
}
console.log(`log lines since start: ${logLines() - startLines}`)
child.kill('SIGTERM')
await new Promise(r => child.once('exit', r))
