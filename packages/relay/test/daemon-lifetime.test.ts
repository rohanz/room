import { afterEach, expect, it, vi } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { roomConnection, docGeneration } from '@room/shared'
import { CURRENT_COMPAT } from '@room/hub-core'
import { authorizedWebSocket } from '../../roomd/src/ws-auth.js'
import { stopLocalDaemon } from '../src/daemon.js'
import { readRelayInfo, relayHealth, ensureLocalDaemon, memoryFile, localProofHeader, localViewKey, type LocalRelayInfo } from '../src/index.js'

const require = createRequire(import.meta.url)
const daemonPids: number[] = []
const children: ChildProcess[] = [], dirs: string[] = [], providers: WebsocketProvider[] = [], servers: http.Server[] = []
const room = 'local/daemon-lifetime'
const offer = { ...CURRENT_COMPAT, capabilities: { ...CURRENT_COMPAT.capabilities, 'room.daemon': [1] }, requiredCapabilities: { 'room.daemon': [1] } }
afterEach(async () => {
  for (const pid of daemonPids.splice(0)) { try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ } }
  for (const p of providers.splice(0)) { p.destroy(); p.doc.destroy() }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const exit = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exit }
  }
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function common() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-daemon-process-')); dirs.push(dir); return dir }
async function start(dir: string, idleMs = 300000, clock = 'fake') {
  const child = spawn(process.execPath, ['--import', require.resolve('tsx'), fileURLToPath(new URL('./daemon-child.ts', import.meta.url)), dir, room, String(idleMs), clock], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  children.push(child)
  const messages: any[] = []; let stderr = ''
  child.stderr!.on('data', b => { stderr += String(b) })
  child.on('message', message => messages.push(message))
  await vi.waitFor(() => { if (child.exitCode !== null) throw new Error(`daemon fixture exited: ${stderr}`); expect(messages.some(m => m.ready)).toBe(true) }, { timeout: 10000 })
  const info = messages.find(m => m.ready).ready as LocalRelayInfo
  const command = async (command: string, extra = {}) => {
    const before = messages.length
    child.send({ command, ...extra })
    await vi.waitFor(() => expect(messages.slice(before).some(m => m.ack === command)).toBe(true))
  }
  return { child, info, command, messages }
}
function connect(info: LocalRelayInfo, doc = new Y.Doc(), view = false, ticket?: string) {
  const connection = roomConnection(doc)
  Object.assign(connection.params, view ? { ticket: ticket! } : { negotiate: '1' })
  const p = new WebsocketProvider(`ws://127.0.0.1:${info.port}`, encodeURIComponent(room), doc, {
    WebSocketPolyfill: authorizedWebSocket({ ...(view ? { viewKey: localViewKey(info.key, room) } : { key: info.key, negotiation: { offer, sessionId: `test-${doc.clientID}` } }) }) as never,
    ...connection,
  })
  providers.push(p); return p
}
async function synced(p: WebsocketProvider) { await vi.waitFor(() => expect(p.synced).toBe(true), { timeout: 10000 }) }
async function gone(child: ChildProcess) { await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null).toBe(true), { timeout: 10000 }) }

it('a separate process stops at five minutes of fake writer-idle time (short real timer seam)', async () => {
  const { child, command } = await start(common())
  await command('clock', { now: 299999 })
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(child.exitCode).toBeNull()
  // The timer enters drain in the same callback; no writer or traffic is needed to finish.
  child.send({ command: 'clock', now: 300000 })
  await gone(child)
})

it('the last writer leaves while a read-only viewer remains; viewers never reset the countdown', async () => {
  const { child, info, command } = await start(common())
  const writer = connect(info); await synced(writer)
  const target = '/ws-ticket'
  const response = await fetch(`http://127.0.0.1:${info.port}${target}`, { method: 'POST', headers: { Authorization: localProofHeader(info.key, 'POST', target, info.port), 'content-type': 'application/json' }, body: JSON.stringify({ schema: 2, room, compat: CURRENT_COMPAT }) })
  const { ticket } = await response.json() as { ticket: string }
  const viewer = connect(info, new Y.Doc(), true, ticket); await synced(viewer)
  await command('clock', { now: 600000 })
  expect((await relayHealth(info.port, info.key))?.writers).toBe(1)
  writer.disconnect()
  await vi.waitFor(async () => expect((await relayHealth(info.port, info.key))?.writers).toBe(0))
  await command('clock', { now: 899999 })
  expect(child.exitCode).toBeNull()
  child.send({ command: 'clock', now: 900000 })
  await gone(child)
})

it('SIGTERM final save ends the generation, refuses a survivor, and syncs saved receipts to a fresh replica', async () => {
  const dir = common(), first = await start(dir)
  const survivor = connect(first.info); await synced(survivor)
  const generation = docGeneration(survivor.doc)
  const receipt = { at: 123, via: 'reply', s: 'ada' }
  survivor.doc.getMap('mail').set('read-message', { id: 'read-message', type: 'note', from: 'bob', to: 'ada', text: 'already read', at: Date.now() })
  survivor.doc.getMap('seen:ada').set('read-message', receipt)
  const observer = connect(first.info); await synced(observer)
  await vi.waitFor(() => expect(observer.doc.getMap('seen:ada').has('read-message')).toBe(true))
  first.child.kill('SIGTERM'); await gone(first.child)
  survivor.disconnect(); observer.disconnect()
  const saved = new Y.Doc(); Y.applyUpdate(saved, fs.readFileSync(memoryFile(dir, room)))
  expect(saved.getMap('seen:ada').get('read-message')).toEqual(receipt)
  expect(docGeneration(saved)).toBeTruthy()
  expect(docGeneration(saved)).not.toBe(generation)
  const second = await start(dir)
  let code: number | undefined
  survivor.on('connection-close', (event: { code: number }) => { code = event.code })
  survivor.connect()
  await vi.waitFor(() => expect(code).toBe(4409))
  const fresh = connect(second.info); await synced(fresh)
  expect(docGeneration(fresh.doc)).toBe(docGeneration(saved))
  expect(fresh.doc.getMap('seen:ada').toJSON()).toEqual(saved.getMap('seen:ada').toJSON())
  saved.destroy()
})

it('crash with one surviving client replica resyncs an unsnapshotted fact after restart', async () => {
  const dir = common(), first = await start(dir)
  const p = connect(first.info); await synced(p)
  expect(p.doc.getMap('meta').get('generation')).toBeUndefined() // local first-start generation remains 0
  // Force disk failure before the fact, so even a disconnect-triggered save cannot persist it.
  await first.command('full', { full: true })
  p.doc.getMap('meta').set('surviving-post', 'acknowledged-in-memory')
  const observer = connect(first.info); await synced(observer)
  await vi.waitFor(() => expect(observer.doc.getMap('meta').get('surviving-post')).toBe('acknowledged-in-memory'))
  observer.destroy()
  const disk = new Y.Doc(); if (fs.existsSync(memoryFile(dir, room))) Y.applyUpdate(disk, fs.readFileSync(memoryFile(dir, room))); expect(disk.getMap('meta').has('surviving-post')).toBe(false); disk.destroy()
  first.child.kill('SIGKILL'); await gone(first.child)
  p.disconnect()
  const second = await start(dir)
  expect(second.info.key).toBe(first.info.key)
  expect(second.info.port).toBe(first.info.port)
  p.connect(); await synced(p)
  const after = connect(second.info); await synced(after)
  expect(docGeneration(after.doc)).toBeUndefined()
  await vi.waitFor(() => expect(after.doc.getMap('meta').get('surviving-post')).toBe('acknowledged-in-memory'))
})

it('a taken recorded port uses a fallback, preserves the key and the surviving replica', async () => {
  const dir = common(), first = await start(dir)
  const p = connect(first.info); await synced(p)
  await first.command('full', { full: true })
  p.doc.getMap('meta').set('fallback-fact', 'retained')
  const witnessed = connect(first.info); await synced(witnessed)
  await vi.waitFor(() => expect(witnessed.doc.getMap('meta').get('fallback-fact')).toBe('retained'))
  witnessed.destroy()
  first.child.kill('SIGKILL'); await gone(first.child); p.disconnect()
  const occupied = http.createServer((_req, res) => res.end('foreign listener')); servers.push(occupied)
  await new Promise<void>(resolve => occupied.listen(first.info.port, '127.0.0.1', resolve))
  const second = await start(dir)
  expect(second.info.port).not.toBe(first.info.port); expect(second.info.key).toBe(first.info.key)
  expect(readRelayInfo(dir)?.port).toBe(second.info.port)
  // Transport replacement retains the very same doc; session-level integration is daemon-client's slice.
  const retained = p.doc
  const replacement = connect(second.info, retained); await synced(replacement)
  const after = connect(second.info); await synced(after)
  await vi.waitFor(() => expect(after.doc.getMap('meta').get('fallback-fact')).toBe('retained'))
})

it('full-disk idle stop keeps serving and holding authority, then retries without another edit', async () => {
  const dir = common(), runtime = await start(dir)
  await runtime.command('shed')
  const p = connect(runtime.info); await synced(p)
  await runtime.command('full', { full: true })
  p.doc.getMap('meta').set('latest', 'must survive')
  const observer = connect(runtime.info); await synced(observer)
  await vi.waitFor(() => expect(observer.doc.getMap('meta').get('latest')).toBe('must survive'))
  p.disconnect(); observer.disconnect()
  await vi.waitFor(async () => expect((await relayHealth(runtime.info.port, runtime.info.key))?.writers).toBe(0))
  await runtime.command('clock', { now: 300000 })
  await vi.waitFor(async () => expect((await relayHealth(runtime.info.port, runtime.info.key))?.stopFailure).toMatch(/ENOSPC/))
  expect(runtime.child.exitCode).toBeNull()
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'room/hub/authority.lock'), 'utf8')).pid).toBe(runtime.child.pid)
  const repair = connect(runtime.info); await synced(repair)
  expect(repair.doc.getMap('meta').get('latest')).toBe('must survive')
  repair.disconnect()
  await runtime.command('full', { full: false })
  await vi.waitFor(async () => expect((await relayHealth(runtime.info.port, runtime.info.key))?.writers).toBe(0))
  runtime.child.send({ command: 'clock', now: 600000 })
  await gone(runtime.child)
  const saved = new Y.Doc(); Y.applyUpdate(saved, fs.readFileSync(memoryFile(dir, room))); expect(saved.getMap('meta').get('latest')).toBe('must survive'); saved.destroy()
})

it('the detached daemon outlives its launcher process and owns discovery and authority itself', async () => {
  const dir = common()
  const child = spawn(process.execPath, ['--import', require.resolve('tsx'), fileURLToPath(new URL('./daemon-launcher-child.ts', import.meta.url)), dir], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  children.push(child)
  let info: { pid: number; port: number; key: string } | undefined, stderr = ''
  child.on('message', (message: any) => { info = message.ready; if (info) daemonPids.push(info.pid) })
  child.stderr!.on('data', b => { stderr += String(b) })
  await vi.waitFor(() => { if (child.exitCode) throw new Error(stderr); expect(info).toBeDefined() }, { timeout: 15000 })
  await gone(child)
  expect(info!.pid).not.toBe(child.pid)
  expect((await relayHealth(info!.port, info!.key))?.runtime).toBe('daemon')
  expect(readRelayInfo(dir)?.pid).toBe(info!.pid)
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'room/hub/authority.lock'), 'utf8')).pid).toBe(info!.pid)
})

it('the separate process also exits through a short real idle timeout', async () => {
  const { child } = await start(common(), 200, 'real')
  await gone(child)
})

it('refuses discovery whose pid disagrees with authenticated listener metadata', async () => {
  const dir = common(), runtime = await start(dir)
  const discovery = path.join(dir, 'room', 'relay.json')
  fs.writeFileSync(discovery, JSON.stringify({ ...runtime.info, pid: process.pid }), { mode: 0o600 })
  await expect(ensureLocalDaemon(dir, room, {})).rejects.toThrow(/PID does not match the authenticated listener/)
  expect((await relayHealth(runtime.info.port, runtime.info.key))?.pid).toBe(runtime.child.pid)
})

it('simultaneous independent first starts publish exactly one key under one daemon authority', async () => {
  const dir = common(), barrier = path.join(dir, 'start')
  const reports: any[][] = [[], []]
  const racers = reports.map(messages => {
    const child = spawn(process.execPath, ['--import', require.resolve('tsx'), fileURLToPath(new URL('./daemon-child.ts', import.meta.url)), dir, room, '300000', 'fake', barrier], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    children.push(child); child.on('message', message => messages.push(message)); return child
  })
  await vi.waitFor(() => expect(reports.every(messages => messages.some(m => m.waiting))).toBe(true), { timeout: 10000 })
  fs.writeFileSync(barrier, '')
  await vi.waitFor(() => expect(reports.flat().filter(m => m.ready || m.loser)).toHaveLength(2), { timeout: 15000 })
  expect(reports.flat().filter(m => m.published)).toHaveLength(1)
  expect(reports.flat().filter(m => m.ready)).toHaveLength(1)
  const info = reports.flat().find(m => m.ready).ready as LocalRelayInfo
  expect(readRelayInfo(dir)).toMatchObject({ key: info.key, pid: info.pid, nonce: info.nonce })
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'room/hub/authority.lock'), 'utf8')).pid).toBe(info.pid)
  expect(racers.some(child => child.pid === info.pid)).toBe(true)
  expect((await relayHealth(info.port, info.key))?.ready).toBe(true)
})

it('maintenance stop authenticates PID plus nonce, saves with writers attached and verifies actual child exit', async () => {
  const dir = common(), runtime = await start(dir)
  const writer = connect(runtime.info); await synced(writer)
  const generation = docGeneration(writer.doc)
  writer.doc.getMap('meta').set('maintenance', 'retained')
  const observer = connect(runtime.info); await synced(observer)
  await vi.waitFor(() => expect(observer.doc.getMap('meta').get('maintenance')).toBe('retained'))
  expect((await relayHealth(runtime.info.port, runtime.info.key))?.writers).toBe(2)
  const file = path.join(dir, 'room/relay.json')
  fs.writeFileSync(file, JSON.stringify({ ...runtime.info, nonce: '00000000-0000-0000-0000-000000000000' }), { mode: 0o600 })
  await expect(stopLocalDaemon(dir)).rejects.toThrow(/identity could not be authenticated/)
  fs.writeFileSync(file, JSON.stringify(runtime.info), { mode: 0o600 })
  const cli = spawn(process.execPath, ['--import', require.resolve('tsx'), fileURLToPath(new URL('../src/daemon-bin.ts', import.meta.url)), 'stop', '--common-dir', dir], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(cli)
  let output = '', error = ''
  cli.stdout!.on('data', chunk => { output += String(chunk) }); cli.stderr!.on('data', chunk => { error += String(chunk) })
  await gone(cli)
  expect(error).toBe(''); expect(cli.exitCode).toBe(0); expect(output).toContain('saved and process exit verified')
  await gone(runtime.child)
  const saved = new Y.Doc(); Y.applyUpdate(saved, fs.readFileSync(memoryFile(dir, room)))
  expect(saved.getMap('meta').get('maintenance')).toBe('retained')
  expect(docGeneration(saved)).toBeTruthy()
  expect(docGeneration(saved)).not.toBe(generation)
  saved.destroy()
})

it.each([{ args: ['start'] }, { args: [] }])('refuses a direct start ($args) that bypasses the launcher admission, writing no discovery', ({ args }) => {
  const dir = common()
  const result = (() => { try { execFileSync(process.execPath, ['--import', require.resolve('tsx'), fileURLToPath(new URL('../src/daemon-bin.ts', import.meta.url)), ...args, '--common-dir', dir, '--room', 'local/direct'], { stdio: 'pipe', encoding: 'utf8' }); return { code: 0, stderr: '' } }
    catch (error) { const e = error as { status: number; stderr: string }; return { code: e.status, stderr: String(e.stderr) } } })()
  expect(result.code).toBe(1)
  expect(result.stderr).toMatch(/Room starts the daemon itself on join/)
  expect(fs.existsSync(path.join(dir, 'room/relay.json'))).toBe(false)
  expect(fs.existsSync(path.join(dir, 'room/hub/authority.lock'))).toBe(false)
})

it('maintenance shedding-snapshot save failure reports the cause, retains the live daemon, and permits an explicit retry', async () => {
  const dir = common(), runtime = await start(dir)
  await runtime.command('shed')
  await runtime.command('full', { full: true })
  await expect(stopLocalDaemon(dir)).rejects.toThrow(/ENOSPC/)
  expect((await relayHealth(runtime.info.port, runtime.info.key))?.draining).toBe(false)
  expect(runtime.child.exitCode).toBeNull()
  await runtime.command('full', { full: false })
  await stopLocalDaemon(dir)
  await gone(runtime.child)
})

it.skipIf(process.platform !== 'win32')('native Windows initializes inherited private ACLs before daemon launch', async () => {
  const dir = common()
  // A fresh clone parent granting only the current user, SYSTEM and Administrators.
  // The child initially inherits these grants; the Room helper must protect its DACL.
  const script = `$ErrorActionPreference='Stop'; $p=$env:ROOM_TEST_PRIVATE_PARENT; $u=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object Security.AccessControl.DirectorySecurity; $a.SetOwner($u); $a.SetAccessRuleProtection($true,$false); foreach($sid in @($u.Value,'S-1-5-18','S-1-5-32-544')) { $s=New-Object Security.Principal.SecurityIdentifier($sid); $r=New-Object Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $a.AddAccessRule($r) }; Set-Acl -LiteralPath $p -AclObject $a`
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ROOM_TEST_PRIVATE_PARENT: dir }, timeout: 5000, stdio: 'pipe', windowsHide: true })
  const daemon = await ensureLocalDaemon(dir, room, { entryPath: fileURLToPath(new URL('../src/daemon-bin.ts', import.meta.url)), execArgv: ['--import', require.resolve('tsx')], startupTimeoutMs: 15000 })
  daemonPids.push(daemon.pid)
  expect((await relayHealth(daemon.port, daemon.key))?.ready).toBe(true)
  const { verifyPrivatePath } = await import('../src/private-state.js')
  verifyPrivatePath(path.join(dir, 'room'))
  verifyPrivatePath(path.join(dir, 'room/relay.json'))
  await stopLocalDaemon(dir)
}, 45000)
