#!/usr/bin/env tsx
/** Synthetic persisted-room idle RSS probe. Never uses a real persistence directory. */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { LeveldbPersistence } from 'y-leveldb'
import * as Y from 'yjs'

const usage = 'npx tsx scripts/measure-idle-rss.mts [--cmd "node packages/server/dist/server.mjs"] [--mb 60]'
const args = process.argv.slice(2)
let command = 'node packages/server/dist/server.mjs', mb = 60
while (args.length) {
  const flag = args.shift()
  if (flag === '--help' || flag === '-h') { console.log(usage); process.exit(0) }
  const value = args.shift()
  if (!value || !['--cmd', '--mb'].includes(flag!)) throw new Error(usage)
  if (flag === '--cmd') command = value
  else mb = Number(value)
}
if (!Number.isFinite(mb) || mb < 40 || mb > 80) throw new Error('--mb must be between 40 and 80')
if (process.platform === 'win32') throw new Error('This RSS probe requires Linux or macOS (ps and a POSIX shell)')
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'room-idle-rss-'))
const shutdown = new AbortController()
const interrupt = () => shutdown.abort(new Error('RSS probe interrupted'))
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
let child: ReturnType<typeof spawn> | undefined, childExit: Promise<void> | undefined
let log = '', failed: Error | undefined, listening = false
const exec = promisify(execFile)
async function diskBytes(dir: string): Promise<number> {
  let bytes = 0
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    bytes += entry.isDirectory() ? await diskBytes(file) : (await fs.stat(file)).size
  }
  return bytes
}
async function rssTree(pid: number) {
  const { stdout } = await exec('ps', ['-ax', '-o', 'pid=,ppid=,rss=,command='])
  const rows = stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), rssBytes: Number(match[3]) * 1024, command: match[4]! }] : []
  })
  const included = new Set([pid])
  for (let old = -1; old !== included.size;) {
    old = included.size
    for (const row of rows) if (included.has(row.parent)) included.add(row.pid)
  }
  const processes = rows.filter(row => included.has(row.pid))
  if (!processes.length) throw new Error('Server exited before RSS sampling')
  // For CLI wrappers, expose every process and select the largest Node process as the server.
  const nodes = processes.filter(row => /\bnode\b/.test(row.command))
  const server = (nodes.length ? nodes : processes).sort((a, b) => b.rssBytes - a.rssBytes)[0]!
  return { pid: server.pid, rssBytes: server.rssBytes, treeRssBytes: processes.reduce((sum, row) => sum + row.rssBytes, 0), processes }
}
try {
  console.error(`Creating ${mb} MiB synthetic fixture in ${dir}`)
  const provider = new LeveldbPersistence(dir)
  let rawUpdateBytes = 0, records = 0
  try {
    const target = Math.floor(mb * 1048576)
    while (rawUpdateBytes < target) {
      shutdown.signal.throwIfAborted()
      const doc = new Y.Doc()
      try {
        // Incompressible data keeps physical SST size close to the requested size.
        doc.getMap('fixture').set(`record-${records}`, new Uint8Array(randomBytes(Math.min(1048576, target - rawUpdateBytes))))
        const update = Y.encodeStateAsUpdate(doc)
        await provider.storeUpdate(`github.com/rss/fixture-${records % 8}/main`, update)
        rawUpdateBytes += update.byteLength; records++
      } finally { doc.destroy() }
    }
  } finally { await provider.destroy() }
  await fs.writeFile(path.join(dir, 'rooms.json'), '{}')
  const storedBytes = await diskBytes(dir)
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
  // exec avoids measuring an extra shell; retain descendants for commands with CLI wrappers.
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('ROOM_')) delete env[key]
  delete env.DATABASE_URL; delete env.NODE_OPTIONS
  child = spawn('/bin/sh', ['-c', `exec ${command}`], {
    cwd: process.cwd(), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, NODE_ENV: 'development', GITHUB_CLIENT_ID: 'fake', HOST: '127.0.0.1', PORT: String(port), YPERSISTENCE: dir },
  })
  childExit = new Promise(resolve => child!.once('exit', () => resolve()))
  child.on('error', error => { failed = error })
  for (const stream of [child.stdout!, child.stderr!]) stream.on('data', chunk => {
    log = (log + chunk).slice(-32768)
    if (log.includes('room server listening')) listening = true
  })
  const deadline = Date.now() + 60_000
  while (!listening) {
    if (failed) throw failed
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Server exited during startup: ${log}`)
    if (Date.now() > deadline) throw new Error(`Timed out waiting for the server to listen: ${log}`)
    await delay(100, undefined, { signal: shutdown.signal })
  }
  // Startup work (rc3's stored-inventory scan) runs after listening: let it finish before the idle window.
  await delay(30_000, undefined, { signal: shutdown.signal })
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]) })
  if (!response.ok) throw new Error(`Health returned ${response.status}: ${log}`)
  console.error('Startup settled; sampling after 60 seconds idle')
  const idleStart = Date.now()
  // Short waits keep shutdown and early child failures responsive.
  while (Date.now() - idleStart < 60_000) {
    if (failed) throw failed
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Server exited while idle: ${log}`)
    await delay(1000, undefined, { signal: shutdown.signal })
  }
  const sample = await rssTree(child.pid!)
  console.log(JSON.stringify({ command, requestedMB: mb, rawUpdateBytes, storedBytes, records,
    documents: 8, idleMs: Date.now() - idleStart,
    mallocArenaMax: process.env.MALLOC_ARENA_MAX ?? null, platform: process.platform,
    nodeVersion: process.version, ...sample }, null, 2))
} finally {
  if (child?.pid) {
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* already exited */ }
    await Promise.race([childExit, delay(2000)])
    // Kill surviving CLI descendants too, before removing their persistence directory.
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* process group exited */ }
    await childExit
  }
  await fs.rm(dir, { recursive: true, force: true })
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
}
