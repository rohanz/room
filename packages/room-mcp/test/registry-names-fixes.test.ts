import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import { Rooms } from '../src/registry.js'
import { PresenceEnd, IDLE_CLAIMS_MS, nextIdleEpisode } from '../src/presence-end.js'
import { WorkerRegistry, closeRegistryForDir, registryForDir } from '../src/worker-registry.js'
import type { Session } from '../src/session.js'
import type { WorkerRecord } from '../src/worker-status.js'
import { registerWorkers } from './registry-fixture.js'

const scratch: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of scratch.splice(0)) {
    await closeRegistryForDir(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-names-fixes-'))
  scratch.push(dir)
  return dir
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
}

async function finishedWorker() {
  const dir = temp()
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@test')
  git(dir, 'config', 'user.name', 'test')
  fs.writeFileSync(path.join(dir, 'app.py'), 'x = 1\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'initial')
  const workerDir = path.join(dir, '.room', 'workers', 'retry')
  fs.mkdirSync(path.dirname(workerDir), { recursive: true })
  git(dir, 'worktree', 'add', '-q', '-b', 'room/retry', workerDir, 'HEAD')
  const room = new RoomDoc(new Y.Doc())
  room.setMeta({ repo: 'x', branch: 'main', base: git(dir, 'rev-parse', 'HEAD') })
  const awareness = new Awareness(room.doc)
  const me = { name: 'lead', kind: 'agent' as const, owner: 'lead' }
  awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
  const session = { dir, room, awareness, me, roomName: 'local/x/main',
    local: { url: 'ws://127.0.0.1:1', port: 1, owned: true }, post: vi.fn(),
    daemon: { fence: 'test-fence', touch() {} } } as unknown as Session
  const registry = await registerWorkers(session, [{ tag: 'retry', name: 'lead+retry', lead: 'lead',
    host: 'claude', hostSessionId: '550e8400-e29b-41d4-a716-446655440000', task: 'test',
    dir: workerDir, branch: 'room/retry', pid: -1, startedAt: 1, status: 'done', exitCode: 0 }])
  const record = registry.list().find(value => value.tag === 'retry')!
  const rooms = new Rooms({ primary: () => session, setPrimary: () => {}, attach: () => ({ stop() {} }) })
  return { dir, room, session, registry, record, rooms }
}

describe('whole redesign registry and names regressions', () => {
  it('M1 releases the operation lease after a refused follow-up and a throwing post, then resumes in the same MCP', async () => {
    const t = await finishedWorker()
    const worker = { id: t.record.id, tag: t.record.tag, host: t.record.host }
    const neverSpawn = vi.fn(() => { throw new Error('must not spawn') })
    expect(await t.rooms.resumeWorker(t.session, worker, 'again', neverSpawn, undefined, 1,
      () => {}, Date.now, 30_000, async () => 'error: hub full')).toBe('error: hub full')
    expect(t.registry.read(worker.id)?.runs.at(-1)?.launch).toEqual({ outcome: 'never', error: 'error: hub full' })
    expect(fs.existsSync(path.join(t.registry.root, 'workers', `${worker.id}.op`))).toBe(false)
    await expect(t.rooms.resumeWorker(t.session, worker, 'again', neverSpawn, undefined, 1,
      () => {}, Date.now, 30_000, async () => { throw new Error('post unavailable') })).rejects.toThrow('post unavailable')
    expect(fs.existsSync(path.join(t.registry.root, 'workers', `${worker.id}.op`))).toBe(false)
    const spawned = vi.fn(() => ({ pid: 8001, started: Promise.resolve(), onExit: () => {}, kill: () => true }))
    const result = await t.rooms.resumeWorker(t.session, worker, 'again', spawned, undefined, 1,
      () => {}, Date.now, 30_000, async () => ({ ids: ['follow-up-id'], prompt: 'again' }))
    expect(result).toContain('resumed retry')
    expect(spawned).toHaveBeenCalledOnce()
  })

  it.each(['absent', 'ambiguous'] as const)('M2 recovers the admitted host, not its MCP, from an %s launch handoff', async prior => {
    const dir = temp()
    const launcher = { pid: 100, startTime: 'launcher', executable: '/bin/lead', sessionId: 'lead', nonce: 'launch' }
    const mcp = { pid: 200, startTime: 'mcp', executable: '/bin/room-mcp' }
    const host = { pid: 300, startTime: 'host', executable: '/bin/codex' }
    const alive = new Set([mcp.pid, host.pid])
    const registry = await WorkerRegistry.open(dir, { migrate: false, watch: false,
      liveness: identity => alive.has(identity.pid) ? 'alive' : 'dead' })
    const record: WorkerRecord = { v: 1, id: 'w_handoff', tag: 'handoff', name: 'lead+handoff', mode: 'local',
      room: 'local/x/main', lead: { participant: 'lead', room: 'local/x/main', instance: launcher }, host: 'codex',
      budget: { threads: 1, memGb: 1, nice: 0 }, share: 'intent', task: 'test', dir: path.join(dir, 'worker'),
      outside: false, branch: 'room/handoff', prep: { step: 'prepared' },
      capabilities: { resume: true, signal: true, collect: 'copy' }, phase: 'prepared',
      runs: [{ n: 1, mode: 'fresh', intentAt: 1, nonce: 'run', busFrontier: 0, promptMsgIds: [],
        launcher, logStart: 0 }],
      createdAt: 1, seq: 1 }
    fs.mkdirSync(record.dir)
    await registry.writeIntent(record)
    await registry.finishOperation(record.id)
    if (prior === 'ambiguous') await registry.update(record.id, old => ({ ...old,
      runs: [{ ...old.runs[0], launch: { outcome: 'ambiguous', at: 2 } }], seq: old.seq + 1 }))
    await registry.admit({ id: record.id, run: 1, nonce: 'run', dir: record.dir,
      chain: [mcp, host], hostProcess: host, hostSessionId: 'host-session' })
    await registry.reconcile()
    expect(registry.read(record.id)?.runs[0].launch).toMatchObject({ outcome: 'launched', pid: host.pid, process: host })
    alive.delete(mcp.pid)
    await registry.writeReport(record.id, { run: 1, nonce: 'run', chain: [{ ...mcp, pid: 201 }, host],
      hostProcess: null, joinedAt: 4, hostSessionId: 'host-session' })
    expect(registry.reports(record.id)[0].hostProcess).toEqual(host)
    await registry.reconcile()
    expect(registry.exits(record.id)).toEqual([])
    expect(registry.status(record.id)?.status).toBe('running')
    registry.close()
  })

  it('M8 gives a restarted MCP a fresh idle episode, including after a completed H1 release', async () => {
    const dir = temp()
    const registry = await WorkerRegistry.open(dir, { migrate: false, watch: false })
    const room = new RoomDoc()
    room.participants.set('ben\0holder', { sessionId: 'same-host', epoch: 22 })
    room.claims.set('first', { id: 'first', path: 'first.ts', from: 1, to: 2, by: 'ben', byKind: 'agent', intent: 'first', at: 1 })
    let now = 0
    const notices: string[] = []
    const makePresence = async () => new PresenceEnd({ hostKind: 'shared-app-server', tickMs: 0, mono: () => now,
      episodeId: await nextIdleEpisode(dir),
      hostAlive: () => true, holds: () => room.openClaims().length > 0, leadsWorkers: () => false,
      waiting: () => false, hostEnded: () => {}, leave: async () => {},
      releaseHeld: async (idle, epoch) => registry.reconcileIdleClaims({ roomKey: 'local/x/main',
        sessionId: 'same-host', participant: 'ben', idleEpoch: epoch,
        epoch: String(room.participants.get('ben\0holder')?.epoch), host: 'shared-app-server',
        lastActivityMs: now - idle, monotonicMs: () => now, doc: room, ownsParticipant: () => true,
        postNotice: id => { notices.push(id) } }) })
    const first = await makePresence()
    now = IDLE_CLAIMS_MS
    await first.tick()
    first.stop()
    expect(room.claims.has('first')).toBe(false)
    room.participants.set('ben\0holder', { sessionId: 'same-host', epoch: 23 })
    room.claims.set('second', { id: 'second', path: 'second.ts', from: 3, to: 4, by: 'ben', byKind: 'agent', intent: 'second', at: 2 })
    const restarted = await makePresence()
    now = 2 * IDLE_CLAIMS_MS
    await restarted.tick()
    restarted.stop()
    expect(room.claims.has('second')).toBe(false)
    expect(notices).toHaveLength(2)
    expect(new Set(notices).size).toBe(2)
    registry.close()
  })

  it('M8 replays a pending notice under its original ID before releasing a new idle episode', async () => {
    const dir = temp()
    const registry = await WorkerRegistry.open(dir, { migrate: false, watch: false })
    const room = new RoomDoc()
    room.participants.set('ben\0holder', { sessionId: 'same-host', epoch: 22 })
    room.claims.set('first', { id: 'first', path: 'first.ts', from: 1, to: 1, by: 'ben', byKind: 'agent', intent: 'first', at: 1 })
    const first = `idle-${await nextIdleEpisode(dir)}-1`
    const notices: string[] = []
    const action = (idleEpoch: string) => ({ roomKey: 'local/x/main', sessionId: 'same-host', participant: 'ben',
      idleEpoch, epoch: String(room.participants.get('ben\0holder')?.epoch), host: 'shared-app-server' as const,
      lastActivityMs: 0, monotonicMs: () => IDLE_CLAIMS_MS, doc: room, ownsParticipant: () => true,
      postNotice: (id: string) => { notices.push(id) } })
    await expect(registry.reconcileIdleClaims({ ...action(first), postNotice: () => { throw new Error('post unavailable') } }))
      .rejects.toThrow('post unavailable')
    expect(room.claims.has('first')).toBe(false)
    room.participants.set('ben\0holder', { sessionId: 'same-host', epoch: 23 })
    room.claims.set('second', { id: 'second', path: 'second.ts', from: 2, to: 2, by: 'ben', byKind: 'agent', intent: 'second', at: 2 })
    const second = `idle-${await nextIdleEpisode(dir)}-1`
    expect(await registry.reconcileIdleClaims(action(second))).toBe(true)
    expect(notices).toEqual([`idle-claims:same-host:${first}`])
    expect(room.claims.has('second')).toBe(true)
    expect(await registry.reconcileIdleClaims(action(second))).toBe(true)
    expect(room.claims.has('second')).toBe(false)
    expect(notices).toEqual([`idle-claims:same-host:${first}`, `idle-claims:same-host:${second}`])
    registry.close()
  })
})
