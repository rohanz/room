import { recordTestDaemon, stopTestDaemon } from './daemon-fixture.js'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RoomdError } from '@room/roomd'
import { readRelayInfo, relayProof } from '@room/relay'
import { AutoJoin } from '../src/auto-join.js'
import { appendRoomLog } from '../src/index.js'
import { LOCAL, NoRoom, createLocalReplica, joinSession, leaveSession, writeSessionRecord, type Session } from '../src/session.js'
import { explicitLocalReplica } from '../src/tools/join.js'
import { gitCommonDir } from '@room/roomd'
import { RoomDoc } from '@room/shared'
import { memorySession } from './fixtures/session.js'
import { createTools } from '../src/tools.js'
import type { ResolvedConfig } from '../src/config.js'
import { workerProcessEnv } from '../src/worker-config.js'
import { closeRegistryForDir, registryForDir } from '../src/worker-registry.js'
import { seedRegistryWorker } from './registry-fixture.js'
import { projectWorkers } from '../src/worker-projector.js'
import { hubAppend } from '@room/shared/testing'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cleanups: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

function repo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-autojoin-')))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'Ada')
  fs.writeFileSync(path.join(dir, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
  cleanups.push(() => stopTestDaemon(path.join(dir, '.git')))
  return dir
}

/** A real room-mcp process over stdio, as a host starts it; its stderr lines are collected. */
async function startMcp(dir: string, workerEnv: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'room-autojoin-home-'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ROOM_')) env[k] = v
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), ROOM_DIR: dir }, workerEnv)
  const lines: string[] = []
  const transport = new StdioClientTransport({ command: path.join(ROOT, 'node_modules/.bin/tsx'), args: [path.join(ROOT, 'packages/room-mcp/src/index.ts')], env, cwd: dir, stderr: 'pipe' })
  transport.stderr?.on('data', d => { lines.push(...String(d).split('\n').filter(Boolean)) })
  const client = new Client({ name: 'test-host', version: '1' })
  // `dir` is a clone this test created in a private temp directory, so only this test's own room-mcp children can
  // launch a daemon there: a changed discovery nonce is this fixture's launch, never an adopted foreign daemon.
  const initialCommon = gitCommonDir(dir), initialNonce = readRelayInfo(initialCommon)?.nonce
  await client.connect(transport)
  if (readRelayInfo(initialCommon)?.nonce !== initialNonce) recordTestDaemon(initialCommon)
  cleanups.push(() => client.close())
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const common = gitCommonDir(dir), before = readRelayInfo(common)?.nonce
    try { return ((await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })).content as { text: string }[])[0].text }
    finally { if (readRelayInfo(common)?.nonce !== before) recordTestDaemon(common) }
  }
  const waitFor = async (pattern: RegExp, ms: number) => {
    const deadline = Date.now() + ms
    while (!lines.some(l => pattern.test(l))) {
      if (Date.now() > deadline) throw new Error(`no stderr line matching ${pattern} within ${ms}ms:\n${lines.join('\n')}`)
      await new Promise(r => setTimeout(r, 20))
    }
  }
  return { call, lines, waitFor, close: () => client.close() }
}

/** What a wedged relay owner looks like from outside: /health answers as this clone's relay, websockets never open. */
async function wedgedRelay(commonDir: string, key: string): Promise<{ close(): void }> {
  const clone = crypto.createHash('sha256').update(fs.realpathSync(commonDir)).digest('hex')
  const sockets = new Set<net.Socket>()
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, local: true, schema: 2, hub: 1, clone, ...(typeof req.headers['x-room-nonce'] === 'string' ? { proof: relayProof(key, req.headers['x-room-nonce'], port) } : {}) }))
  })
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  server.on('upgrade', () => { /* hang: never answer the handshake */ })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as net.AddressInfo).port
  fs.mkdirSync(path.join(commonDir, 'room'), { recursive: true })
  fs.writeFileSync(path.join(commonDir, 'room', 'relay.json'), JSON.stringify({ schema: 2, port, pid: process.pid, room: 'x', startedAt: Date.now(), key }) + '\n', { mode: 0o600 })
  let closed = false
  const close = () => { if (closed) return; closed = true; for (const s of sockets) s.destroy(); server.close() }
  cleanups.push(close)
  return { close }
}

/** Kill only this test clone's known daemon, then occupy its port with an unrelated listener. */
async function crashOntoForeignPort(commonDir: string) {
  const record = JSON.parse(fs.readFileSync(path.join(commonDir, 'room', 'relay.json'), 'utf8')) as { pid: number; port: number }
  expect(record.pid).not.toBe(process.pid)
  process.kill(record.pid, 'SIGKILL')
  const server = http.createServer((_req, res) => res.end('foreign listener'))
  await vi.waitFor(() => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(record.port, '127.0.0.1', resolve) }), { timeout: 5000, interval: 20 })
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
}

describe('automatic join (real room-mcp processes)', () => {
  it('a retained worker process uses its launch sharing as a seed and preserves later policy choices', async () => {
    const dir = repo()
    const room = 'local/demo'
    const lead = await joinSession({ dir, server: LOCAL, room, name: 'Ada' })
    cleanups.push(() => leaveSession(lead))
    const workerDir = path.join(dir, '.room', 'workers', 'privacy')
    execFileSync('git', ['-C', dir, 'worktree', 'add', '-qb', 'privacy', workerDir], { stdio: 'pipe' })
    const launcher = (await registryForDir(dir)).instance
    cleanups.push(() => closeRegistryForDir(dir))
    const { registry, record } = await seedRegistryWorker(dir, 'privacy', {
      name: 'Ada+privacy', room, lead: { participant: 'Ada', room, instance: launcher }, host: 'codex', task: 'sharing', dir: workerDir, branch: 'privacy',
      runs: [{ n: 1, mode: 'fresh', intentAt: Date.now(), nonce: 'privacy-run-1', busFrontier: 0, promptMsgIds: [], launcher, logStart: 0 }],
    })
    const run = record.runs[0]
    const env = workerProcessEnv({ threads: 1, memGb: 1, host: 'codex', server: LOCAL, room, dir: workerDir,
      tag: 'privacy', lead: 'Ada', owner: 'Ada', share: 'full', run: run.n, nonce: run.nonce, registry: registry.root, id: record.id, logDir: dir, isWorker: false, leadClone: path.join(dir, '.git') })
    const first = await startMcp(workerDir, env)
    await first.waitFor(/^room-mcp: ready$/, 30_000)
    expect(await first.call('room_share')).toContain('full text of files you change')
    expect(await first.call('room_share', { level: 'intent' })).toContain('only your plans')
    await first.close()
    await registry.update(record.id, old => ({ ...old, phase: 'active', seq: old.seq + 1,
      runs: [...old.runs, { ...run, n: 2, mode: 'resume', nonce: 'privacy-run-2', launch: { outcome: 'launched', pid: 0 } }] }))
    const retained = await startMcp(workerDir, { ...env, ROOM_WORKER_RUN: '2', ROOM_LAUNCH_NONCE: 'privacy-run-2' })
    await retained.waitFor(/^room-mcp: ready$/, 30_000)
    expect(await retained.call('room_share')).toContain('only your plans')
    // An explicit tool argument remains a deliberate override of the persisted policy.
    expect(await retained.call('room_join', { room, share: 'full' })).toContain('full text of files you change')
  }, 90_000)

  it('a spawned worker auto-joins and its first wait delivers the lead broadcast before the later interrupt, without old history', async () => {
    const dir = repo()
    const room = 'local/demo'
    const lead = await joinSession({ dir, server: LOCAL, room, name: 'Ada' })
    cleanups.push(() => leaveSession(lead))
    const old = hubAppend(lead.room, lead.me, { type: 'note', text: 'OLD-NOTIFY', priority: 'notify' })
    // The launcher's write-ahead record (registry §3): the worker process is admitted against it (§4).
    const launcher = (await registryForDir(dir)).instance
    cleanups.push(() => closeRegistryForDir(dir))
    const { registry, record } = await seedRegistryWorker(dir, 'q', {
      name: 'Ada+q', room, lead: { participant: 'Ada', room, instance: launcher }, host: 'codex', task: 'room_wait once', dir, branch: 'main',
      runs: [{ n: 1, mode: 'fresh', intentAt: Date.now(), nonce: 'auto-join-run-1', busFrontier: old.seq!, promptMsgIds: [], launcher, logStart: 0 }],
    })
    const run = record.runs[0]
    // The lead's projector shows the worker in the room.
    await projectWorkers(lead, registry, 'Ada', 'joined')
    expect(lead.room.workerViewOf('Ada+q')).toMatchObject({ id: record.id, status: 'running' })
    const early = hubAppend(lead.room, lead.me, { type: 'note', text: 'BROADCAST-NOTIFY-1', priority: 'notify' })
    const env = workerProcessEnv({ threads: 1, memGb: 1, host: 'codex', server: LOCAL, room, dir,
      tag: 'q', lead: 'Ada', owner: 'Ada', share: 'full', run: run.n, nonce: run.nonce, registry: registry.root, id: record.id, logDir: dir, isWorker: false })
    const mcp = await startMcp(dir, env)
    await mcp.waitFor(/Ada\+q joined/, 30_000)
    const waiting = mcp.call('room_wait', { timeoutMs: 3000 })
    await new Promise(r => setTimeout(r, 100))
    const late = hubAppend(lead.room, lead.me, { type: 'note', text: 'BROADCAST-INTERRUPT-2', priority: 'interrupt' })
    const result = await waiting
    expect(result).toContain('BROADCAST-INTERRUPT-2')
    expect(result).toContain('BROADCAST-NOTIFY-1')
    expect(result).not.toContain('OLD-NOTIFY')
    // Receipts are written in the worker process and reach the lead's document through the relay.
    await vi.waitFor(() => {
      expect(lead.room.seen('Ada+q').has(early.id)).toBe(true)
      expect(lead.room.seen('Ada+q').has(late.id)).toBe(true)
    }, { timeout: 5000 })
    expect(lead.room.seen('Ada+q').has(old.id)).toBe(false)
    expect(await mcp.call('room_wait', { timeoutMs: 10 })).not.toMatch(/BROADCAST-(NOTIFY|INTERRUPT)/)
  }, 45_000)

  it('a Codex worker whose hook record arrives after startup joins once under its thread id, without a rebind', async () => {
    const dir = repo()
    const room = 'local/demo'
    const lead = await joinSession({ dir, server: LOCAL, room, name: 'Ada' })
    cleanups.push(() => leaveSession(lead))
    const launcher = (await registryForDir(dir)).instance
    cleanups.push(() => closeRegistryForDir(dir))
    const { registry, record } = await seedRegistryWorker(dir, 'late', {
      name: 'Ada+late', room, lead: { participant: 'Ada', room, instance: launcher }, host: 'codex', task: 'bind once', dir, branch: 'main',
      runs: [{ n: 1, mode: 'fresh', intentAt: Date.now(), nonce: 'late-run-1', busFrontier: 0, promptMsgIds: [], launcher, logStart: 0 }],
    })
    const env = workerProcessEnv({ threads: 1, memGb: 1, host: 'codex', server: LOCAL, room, dir,
      tag: 'late', lead: 'Ada', owner: 'Ada', share: 'full', run: 1, nonce: 'late-run-1', registry: registry.root, id: record.id, logDir: dir, isWorker: false })
    const mcp = await startMcp(dir, env)
    // What the SessionStart hook writes once Codex has started the thread, after the MCP is already up.
    await new Promise(r => setTimeout(r, 500))
    writeSessionRecord(path.join(dir, '.git'), { session_id: 'late-thread', host: 'codex', worker_id: record.id, cwd: dir, at: Date.now(), chain: [] })
    await mcp.waitFor(/Ada\+late joined/, 30_000)
    await new Promise(r => setTimeout(r, 2000)) // longer than the record watcher's poll and the binding cache
    const log = mcp.lines.join('\n')
    expect(log).not.toMatch(/host session changed|host session rebound|not bound after/)
    expect(mcp.lines.filter(l => /Ada\+late joined/.test(l))).toHaveLength(1)
    expect(await mcp.call('room_state')).toContain('you: Ada+late')
  }, 60_000)

  it('a live legacy in-session relay is diagnosed and never replaced by a client', async () => {
    const dir = repo()
    const commonDir = path.join(dir, '.git')
    const wedged = await wedgedRelay(commonDir, crypto.randomBytes(16).toString('hex'))
    const mcp = await startMcp(dir)
    await mcp.waitFor(/drain|mixed.*runtime|legacy|in-session/i, 30_000)
    expect(await mcp.call('room_state')).toMatch(/drain|mixed.*runtime|legacy|in-session/i)
    wedged.close()
    expect(await mcp.call('room_leave')).toMatch(/not in|left/)
  }, 60_000)

  it('after room_join, a session whose relay is lost rejoins the room it chose on the next tool call; room_leave keeps it out', async () => {
    const dir = repo()
    const commonDir = path.join(dir, '.git')
    const mcp = await startMcp(dir)
    await mcp.waitFor(/^room-mcp: ready$/, 30_000)
    expect(await mcp.call('room_join', { room: 'picked' })).toContain('joined local/picked as Ada')
    await crashOntoForeignPort(commonDir)
    expect(await mcp.call('room_state')).toContain('you: Ada')
    expect(mcp.lines.join('\n')).not.toMatch(/session will join afresh/)
    expect(await mcp.call('room_leave')).toMatch(/^left local\/picked/)
    expect(await mcp.call('room_state')).toBe('error: not in the local room; room_join to join it.')
  }, 90_000)

  it('a room joined with room_join writes its daemon events to room-mcp.log', async () => {
    const dir = repo()
    const mcp = await startMcp(dir)
    await mcp.waitFor(/^room-mcp: ready$/, 30_000)
    expect(await mcp.call('room_join', { room: 'picked' })).toContain('joined local/picked as Ada')
    execFileSync('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'next'], { stdio: 'pipe' })
    await mcp.waitFor(/^room-mcp: HEAD moved /, 20_000)
    await vi.waitFor(() => expect(fs.readFileSync(path.join(dir, '.git', 'room-mcp.log'), 'utf8')).toMatch(/HEAD moved /), { timeout: 5000 })
  }, 60_000)

  it('automatic reconnect keeps the current sharing policy instead of replaying the startup environment', async () => {
    const dir = repo()
    const commonDir = path.join(dir, '.git')
    const mcp = await startMcp(dir, { ROOM_NAME: 'Source', ROOM_TAG: 'privacy', ROOM_SHARE: 'full' })
    await mcp.waitFor(/^room-mcp: ready$/, 30_000)
    fs.writeFileSync(path.join(dir, 'app.py'), 'PRIVATE-RECONNECT-EDIT\n')
    expect(await mcp.call('room_share', { level: 'intent' })).toContain('only your plans')
    await crashOntoForeignPort(commonDir)
    expect(await mcp.call('room_state')).toContain('you: Source+privacy')

    await vi.waitFor(async () => expect(await mcp.call('room_send', { type: 'note', text: 'recovery complete' })).not.toMatch(/not sent|unreachable|paused/), { timeout: 40_000 })

    // A distinct checkout reads the fresh publication, rather than any cached tool result.
    const observerDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-autojoin-observer-')))
    execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', '--detach', observerDir], { stdio: 'pipe' })
    const observer = await joinSession({ dir: observerDir, server: LOCAL, name: 'Observer', tag: 'reader', share: 'intent' })
    cleanups.push(() => leaveSession(observer))
    const tools = createTools({ cwd: observerDir, getSession: () => observer, setSession: () => {} })
    cleanups.push(() => tools.shutdown())
    await vi.waitFor(() => expect(observer.room.manifestHead.get('Source+privacy')).toBeDefined(), { timeout: 10_000 })
    expect(await tools.call('room_read', { person: 'Source+privacy', path: 'app.py' })).not.toContain('PRIVATE-RECONNECT-EDIT')
    expect(observer.room.manifestHead.get('Source+privacy')?.level).toBe('intent')
    expect(await mcp.call('room_share')).toContain('only your plans')
  }, 90_000)
})

describe('explicit local destination selection', () => {
  it('detaches a different room or clone only for an explicit join; automatic rejoin refuses it intact', async () => {
    const dir = repo(), other = repo()
    const replica = createLocalReplica()
    cleanups.push(() => replica.doc.destroy())
    replica.common = await gitCommonDir(dir)
    replica.room = 'local/original'
    replica.doc.getMap('unsaved').set('only-copy', 'keep me')
    for (const opts of [{ dir, room: 'picked' }, { dir: other, room: 'original' }]) {
      await expect(joinSession({ ...opts, server: LOCAL, name: 'Ada', localReplica: replica }))
        .rejects.toThrow('the retained local replica belongs to a different clone or room')
      const selected = await explicitLocalReplica(opts, replica)
      expect(selected).not.toBe(replica)
      expect(selected.doc.getMap('unsaved').size).toBe(0)
      selected.doc.destroy()
      expect(replica.doc.isDestroyed).toBe(false)
      expect(replica.doc.getMap('unsaved').get('only-copy')).toBe('keep me')
    }
    expect(await explicitLocalReplica({ dir, room: 'original' }, replica)).toBe(replica)
  })

  it.each([false, true])('room_join selects a new replica and preserves the old replica for rollback; failed=%s', async failed => {
    const dir = repo(), common = await gitCommonDir(dir)
    const original = createLocalReplica()
    original.common = common; original.room = 'local/original'
    original.doc.getMap('unsaved').set('only-copy', 'old room only')
    const makeSession = (replica: typeof original, room: string) => ({
      ...memorySession({ name: 'Ada', kind: 'agent' }, dir, new RoomDoc(replica.doc), room),
      local: { url: 'ws://127.0.0.1:9', stop: async () => {} } as Session['local'], localReplica: replica,
    })
    let current: Session | null = makeSession(original, 'local/original')
    let cached = original
    const replicas = [original]
    const attempts: Session['localReplica'][] = []
    const tools = createTools({ cwd: dir, getSession: () => current, setSession: s => { current = s },
      // The MCP keeps a startup replica after rooms.remove; honor the tool's rollback selection.
      join: async opts => {
        cached = await explicitLocalReplica(opts, cached)
        attempts.push(cached); replicas.push(cached)
        cached.common = common; cached.room = opts.room
        if (failed && opts.room === 'local/picked') throw new Error('destination unavailable')
        return makeSession(cached, opts.room!)
      },
    })
    cleanups.push(async () => {
      await tools.shutdown()
      for (const replica of new Set(replicas)) replica.doc.destroy()
    })
    const result = await tools.call('room_join', { where: 'local', room: 'picked' })
    expect(attempts[0]).not.toBe(original)
    expect(original.doc.isDestroyed).toBe(false)
    expect(original.doc.getMap('unsaved').get('only-copy')).toBe('old room only')
    if (failed) {
      expect(result).toContain('back in local/original')
      expect(attempts[1]).toBe(original)
      expect(current!.localReplica).toBe(original)
    } else {
      expect(result).toContain('joined local/picked as Ada')
      expect(current!.room.doc.getMap('unsaved').size).toBe(0)
    }
  })
})

describe('AutoJoin (the ensure step)', () => {
  const fakeSession = (name = 's') => ({ name }) as unknown as Session
  const setup = (attempt: (target?: Session) => Promise<Session | undefined>, over: Partial<ConstructorParameters<typeof AutoJoin>[0]> = {}) => {
    let current: Session | null = null
    const reports: string[] = [], logs: string[] = [], discarded: Session[] = []
    const a = new AutoJoin({ attempt, local: true, delaysMs: [10], deadlineMs: 2000, retryAfterMs: 50,
      adopt: async s => { current = s }, discard: async s => { discarded.push(s) }, joined: () => current !== null,
      log: l => logs.push(l), report: l => reports.push(l), ...over })
    return { a, reports, logs, discarded, current: () => current }
  }

  it('concurrent callers share one run, and a joined session is not joined again', async () => {
    let calls = 0
    const t = setup(async () => { calls++; await new Promise(r => setTimeout(r, 30)); return fakeSession() })
    await Promise.all([t.a.ensure(), t.a.ensure(), t.a.ensure()])
    await t.a.ensure()
    expect(calls).toBe(1)
    expect(t.current()).not.toBeNull()
  })

  it('retries with the latest adopted session even after it was dropped, including its changed policy', async () => {
    const targets: (Session | undefined)[] = []
    let connected = false
    const first = Object.assign(fakeSession('first'), { shareRequested: 'full' })
    const fresh = Object.assign(fakeSession('fresh'), { shareRequested: 'intent' })
    const t = setup(async target => { targets.push(target); return target ? fresh : first }, {
      joined: () => connected, adopt: async () => { connected = true },
    })
    await t.a.ensure()
    first.shareRequested = 'intent'
    connected = false
    await t.a.ensure()
    expect(targets).toEqual([undefined, first])
    connected = false
    await t.a.ensure()
    expect(targets[2]).toBe(fresh)
    expect(targets[2]?.shareRequested).toBe('intent')
    // Runtime host rebinding or replica replacement adopts a different session object.
    const replacement = Object.assign(fakeSession('replacement'), { shareRequested: 'declared' })
    t.a.remember(replacement)
    connected = false
    await t.a.ensure()
    expect(targets[3]).toBe(replacement)
  })

  it('refreshes a replaced session without reviving a cancelled join', async () => {
    const targets: (Session | undefined)[] = []
    const t = setup(async target => { targets.push(target); return fakeSession('joined') })
    t.a.cancel()
    const rebound = Object.assign(fakeSession('rebound'), { shareRequested: 'declared' })
    t.a.remember(rebound)
    await t.a.ensure()
    expect(targets).toEqual([])
    t.a.retarget(rebound)
    await t.a.ensure()
    expect(targets).toEqual([rebound])
  })

  it('retries transient failures with backoff, then reports once with the step that failed and no team advice', async () => {
    let calls = 0
    const t = setup(async () => { calls++; throw Object.assign(new RoomdError('could not sync with ws://127.0.0.1:1/x within 15000ms', 1), { phase: 'sync' }) }, { deadlineMs: 200, delaysMs: [20, 40] })
    await t.a.ensure()
    expect(calls).toBeGreaterThan(2)
    expect(t.reports).toHaveLength(1)
    expect(t.reports[0]).toMatch(/^Room could not join the local room after \d+ attempts \(sync\): could not sync/)
    expect(t.reports[0]).not.toMatch(/teammate|room_create/)
    expect(t.logs[0]).toMatch(/^join attempt 1 failed \(sync\): could not sync .*; retrying in 0s$/)
    // A tool call right after a failed run does not start another; one after retryAfterMs does, and a second failure is not re-reported.
    const before = calls
    await t.a.ensure()
    expect(calls).toBe(before)
    await new Promise(r => setTimeout(r, 60))
    await t.a.ensure()
    expect(calls).toBeGreaterThan(before)
    expect(t.reports).toHaveLength(1)
    expect(t.a.failure).toMatch(/local room/)
  })

  it('does not retry what a human must fix, and stops for good', async () => {
    let calls = 0
    const t = setup(async () => { calls++; throw new NoRoom('github.com/o/r/main', 'no room for github.com/o/r/main yet', 'wss://x') }, { local: false })
    await t.a.ensure()
    await new Promise(r => setTimeout(r, 60))
    await t.a.ensure()
    expect(calls).toBe(1)
    expect(t.reports[0]).toBe('Room could not join: no room for github.com/o/r/main yet; use room_join.')
  })

  it('does not promise automatic retry for a permanent local join failure', async () => {
    let calls = 0
    const t = setup(async () => { calls++; throw new RoomdError('clone mismatch', 2) }, { local: true })
    await t.a.ensure()
    await t.a.ensure()
    expect(calls).toBe(1)
    expect(t.reports[0]).toBe('Room could not join the local room: clone mismatch; room_join to retry now.')
  })

  it('a cancel ends a pending run at once, and a session that arrives afterwards is left', async () => {
    let finish!: (s: Session) => void
    const t = setup(() => new Promise(r => { finish = r }))
    const run = t.a.ensure()
    t.a.cancel()
    await run
    const late = fakeSession('late')
    finish(late)
    await new Promise(r => setTimeout(r, 10))
    expect(t.current()).toBeNull()
    expect(t.discarded).toEqual([late])
    await t.a.ensure()
    expect(t.current()).toBeNull()
  })

  it('deadline exhaustion and internal cancellation dispose late transport without disposing its replica', async () => {
    for (const internalCancel of [false, true]) {
      let finish!: (s: Session) => void
      const discard = vi.fn(async () => {})
      const onCancel = vi.fn()
      const t = setup(() => new Promise(resolve => { finish = resolve }), { deadlineMs: 10, delaysMs: [1000], discard, onCancel })
      const run = t.a.ensure()
      if (internalCancel) t.a.cancel({ explicitLeave: false })
      await run
      finish(fakeSession('retained'))
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(discard).toHaveBeenCalledWith(expect.anything(), 'attempt')
      expect(onCancel).not.toHaveBeenCalled()
    }
  })

  it('a room a human joined becomes the one meant: a stopped join resumes for it, and its failures are reported afresh', async () => {
    const targets: (Session | undefined)[] = []
    let fail = false
    const t = setup(async target => { targets.push(target); if (fail) throw new RoomdError('relay gone', 1); return fakeSession('rejoined') }, { local: false, deadlineMs: 50, delaysMs: [1000] })
    t.a.cancel()
    await t.a.ensure()
    expect(targets).toEqual([])
    const chosen = { name: 'chosen', local: {} } as unknown as Session
    t.a.retarget(chosen)
    await t.a.ensure()
    expect(targets).toEqual([chosen])
    expect(t.current()).toMatchObject({ name: 'rejoined' })
    // A retarget after a failed run clears it: the next call joins at once, and a new failure is reported with the chosen room's kind.
    fail = true
    const u = setup(async target => { targets.push(target); throw new RoomdError('relay gone', 1) }, { local: false, deadlineMs: 50, delaysMs: [1000], retryAfterMs: 60_000 })
    await u.a.ensure()
    expect(u.reports).toEqual(['Room could not join: relay gone; use room_join.'])
    u.a.retarget(chosen)
    expect(u.a.failure).toBeUndefined()
    await u.a.ensure()
    expect(u.reports[1]).toMatch(/^Room could not join the local room: relay gone\. Room tries again/)
  })

  it('a bind wait holds the first join until the host session is bound, once', async () => {
    let bound = false, calls = 0
    const t = setup(async () => { calls++; expect(bound).toBe(true); return fakeSession() }, { bindWait: { bound: () => bound, ms: 2000, pollMs: 5 } })
    setTimeout(() => { bound = true }, 40)
    await t.a.ensure()
    expect(calls).toBe(1)
    expect(t.logs.join('\n')).not.toMatch(/not bound/)
  })

  it('a bind wait that runs out joins anyway and logs it; a cancel during the wait joins nothing', async () => {
    let calls = 0
    const t = setup(async () => { calls++; return fakeSession() }, { bindWait: { bound: () => false, ms: 30, pollMs: 5 } })
    await t.a.ensure()
    expect(calls).toBe(1)
    expect(t.logs).toContain("host session not bound after 30ms; joining under this process's id")
    const u = setup(async () => { calls++; return fakeSession() }, { bindWait: { bound: () => false, ms: 5000, pollMs: 5 } })
    const run = u.a.ensure()
    u.a.cancel()
    await run
    expect(calls).toBe(1)
    expect(u.current()).toBeNull()
  })

  it('a join that overruns the total deadline fails with that cause, and its late session is left', async () => {
    let finish!: (s: Session) => void
    const t = setup(() => new Promise(r => { finish = r }), { deadlineMs: 50, delaysMs: [1000] })
    await t.a.ensure()
    expect(t.reports[0]).toMatch(/did not finish within the 0s join deadline/)
    finish(fakeSession('late'))
    await new Promise(r => setTimeout(r, 10))
    expect(t.discarded).toHaveLength(1)
    expect(t.current()).toBeNull()
  })
})

describe('tools and the ensure step', () => {
  const handle = (failure?: string) => {
    const calls: string[] = []
    return { calls, failure, ensure: async () => { calls.push('ensure') }, settle: async () => { calls.push('settle') }, cancel: () => { calls.push('cancel') }, retarget: () => { calls.push('retarget') } }
  }
  it('every room tool ensures the join first; leaving ends the automatic join', async () => {
    const tools = createTools({ getSession: () => null, setSession: () => {}, cwd: repo(), config: { server: LOCAL } as ResolvedConfig })
    const h = handle()
    tools.setAutoJoin(h)
    expect(await tools.call('room_state', {})).toBe('error: not in the local room; room_join to join it.')
    expect(h.calls).toEqual(['ensure'])
    await tools.call('room_leave', {})
    expect(h.calls).toEqual(['ensure', 'settle', 'cancel'])
  })
  it('names why the automatic join failed instead of generic advice', async () => {
    const tools = createTools({ getSession: () => null, setSession: () => {}, cwd: repo(), config: { server: LOCAL } as ResolvedConfig })
    tools.setAutoJoin(handle('Room could not join the local room (relay): EACCES.'))
    expect(await tools.call('room_spawn', { tag: 'w', task: 't' })).toBe('error: not in a room. Room could not join the local room (relay): EACCES.')
  })
  it('drops a tool call cancelled while its automatic join is queued', async () => {
    let finish!: () => void
    const tools = createTools({ getSession: () => null, setSession: () => {}, cwd: repo(), config: { server: LOCAL } as ResolvedConfig })
    const h = handle()
    h.ensure = () => new Promise<void>(resolve => { finish = resolve })
    tools.setAutoJoin(h)
    const controller = new AbortController()
    const call = tools.call('room_state', {}, controller.signal)
    await vi.waitFor(() => expect(finish).toBeDefined()) // the repository check runs first
    controller.abort()
    finish()
    expect(await call).toBe('error: tool call cancelled')
  })
})

describe('room-mcp.log', () => {
  it('appends lines and rotates to a single .1 file past the cap, so it stays bounded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-log-'))
    const file = path.join(dir, 'room-mcp.log')
    for (let i = 0; i < 50; i++) appendRoomLog(file, `line ${i} ${'x'.repeat(20)}`, 200)
    const current = fs.readFileSync(file, 'utf8'), previous = fs.readFileSync(`${file}.1`, 'utf8')
    expect(current).toContain('line 49')
    expect(fs.statSync(file).size).toBeLessThan(200 + 40)
    expect(fs.statSync(`${file}.1`).size).toBeLessThan(200 + 40)
    expect(previous).not.toContain('line 49')
    expect(fs.readdirSync(dir).sort()).toEqual(['room-mcp.log', 'room-mcp.log.1'])
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
})
