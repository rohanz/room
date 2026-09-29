/**
 * The lead-side writers of worker facts (registry §12–§13): views in the room a worker joined, retirement
 * keyed by worker ID in every room it joined or was projected into, and `projectable()` as their input.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { RoomDoc, type Identity } from '@room/shared'
import { closeRegistryForDir, registryForDir, type WorkerRegistry } from '../src/worker-registry.js'
import { projectWorkers } from '../src/worker-projector.js'
import type { WorkerRecord } from '../src/worker-status.js'
import type { Session } from '../src/session.js'
import { memorySession } from './fixtures/session.js'
import { seedRegistryWorker } from './registry-fixture.js'

// Seeding a registry worker takes seconds (lease guards and process probes).
vi.setConfig({ testTimeout: 30_000 })

const TEAM = 'github.com/rohanz/x/main', LOCAL = 'local/x/main'
const lead: Identity = { name: 'rohanz', kind: 'agent', owner: 'rohanz' }
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-projector-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'rohanz')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
})
afterEach(async () => { await closeRegistryForDir(dir) })

function session(roomName: string, fence: string, room = new RoomDoc(new Y.Doc())): Session {
  const s = memorySession(lead, dir, room, roomName)
  ;(s.daemon as unknown as { fence: string }).fence = fence
  return s
}
async function worker(registry: WorkerRegistry, tag: string, patch: Partial<WorkerRecord> = {}): Promise<WorkerRecord> {
  return (await seedRegistryWorker(dir, tag, { name: `rohanz+${tag}`, mode: 'local', room: LOCAL, projectedInto: TEAM,
    lead: { participant: lead.name, room: LOCAL, instance: registry.instance }, ...patch })).record
}
/** Live state a worker's own session would have written under its name. */
function live(room: RoomDoc, name: string, workerId: string): void {
  room.participants.set(`${name}\u0000holder`, { sessionId: `${workerId}-s`, machine: 'm', pid: 1, startTime: 't', executable: 'e', workerId })
  room.setScope({ by: name, byKind: 'agent', area: 'a', summary: 's', paths: ['app.py'] })
  room.addClaim({ path: 'app.py', from: 1, to: 1, by: name, byKind: 'agent', intent: 'edit' })
}

describe('projectable(lead, roomKey) and the joined-room projector', () => {
  it('M10 recovers an unposted witnessed failure after the first completion post fails', async () => {
    const registry = await registryForDir(dir)
    const w = await worker(registry, 'recover')
    const s = session(LOCAL, 'lead-s1')
    await registry.writeExit(w.id, { run: 1, code: 1, at: 5, witnessed: true })
    const original = registry.postObservedFailure.bind(registry)
    const spy = vi.spyOn(registry, 'postObservedFailure').mockRejectedValueOnce(new Error('hub unreachable'))
    await projectWorkers(s, registry, lead.name, 'joined')
    expect(s.room.messages().filter(m => m.id === `wk:${w.id}:1`)).toHaveLength(0)
    spy.mockImplementation(original)
    await projectWorkers(s, registry, lead.name, 'joined')
    expect(s.room.messages().filter(m => m.id === `wk:${w.id}:1`)).toHaveLength(1)
    expect(registry.read(w.id)?.runs[0].posted).toBe(`wk:${w.id}:1`)
  })

  it('M10 recovers an unposted room_done report after an outage', async () => {
    const registry = await registryForDir(dir)
    const w = await worker(registry, 'done')
    const s = session(LOCAL, 'lead-s1')
    await registry.writeReport(w.id, { run: 1, nonce: w.runs[0].nonce, chain: [], joinedAt: 2,
      done: { at: 5, summary: 'finished safely', changed: ['app.py'] } })
    await registry.writeExit(w.id, { run: 1, code: 0, at: 6, witnessed: true })
    const original = registry.postCompletion.bind(registry)
    const spy = vi.spyOn(registry, 'postCompletion').mockRejectedValueOnce(new Error('hub unreachable'))
    await projectWorkers(s, registry, lead.name, 'joined')
    expect(s.room.messages().filter(m => m.id === `wk:${w.id}:1`)).toHaveLength(0)
    spy.mockImplementation(original)
    await projectWorkers(s, registry, lead.name, 'joined')
    expect(s.room.messages().filter(m => m.id === `wk:${w.id}:1`)).toMatchObject([{ type: 'done', summary: 'finished safely' }])
    expect(registry.reports(w.id)[0].posted).toBe(`wk:${w.id}:1`)
  })
  it('N1 replays a successful resumed turn from an earlier done report with a deterministic ID', async () => {
    const registry = await registryForDir(dir)
    const w = await worker(registry, 'follow-up', { host: 'codex' })
    await registry.writeReport(w.id, { run: 1, nonce: w.runs[0].nonce, chain: [], joinedAt: 2,
      done: { at: 3, summary: 'original task done', changed: ['app.py'] } })
    await registry.writeExit(w.id, { run: 1, code: 0, at: 4, witnessed: true })
    await registry.update(w.id, old => ({ ...old, runs: [...old.runs, { ...old.runs[0], n: 2, mode: 'resume', nonce: 'next',
      launch: { outcome: 'launched', pid: 0 }, logStart: 0 }], seq: old.seq + 1 }))
    await registry.writeExit(w.id, { run: 2, code: 0, at: 5, witnessed: true })
    const logFile = join(dir, '.room', 'workers', 'follow-up.log')
    mkdirSync(join(dir, '.room', 'workers'), { recursive: true })
    writeFileSync(logFile, JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'follow-up answered' } }) + '\n')
    const s = session(LOCAL, 'lead-s1')
    const post = s.post
    let refused = false
    s.post = ((...args: Parameters<typeof post>) => {
      if (!refused && args[2]?.id === `wk:${w.id}:2`) { refused = true; throw new Error('hub unreachable') }
      return post(...args)
    }) as typeof post
    await projectWorkers(s, registry, lead.name, 'joined')
    expect(s.room.messages().filter(m => m.id === `wk:${w.id}:2`)).toHaveLength(0)
    expect(registry.status(w.id)?.followUp).toBe('follow-up answered')
    expect(s.room.workerViews.get(w.id)?.followUp).toBe('follow-up answered')
    await registry.beginRetirement(w.id, registry.archiveOf(registry.read(w.id)!, { summary: 'original task done' }))
    await projectWorkers(s, registry, lead.name, 'joined')
    expect(s.room.messages().filter(m => m.id === `wk:${w.id}:2`)).toMatchObject([{ type: 'done', summary: 'follow-up answered' }])
    expect(registry.read(w.id)?.runs[1].posted).toBe(`wk:${w.id}:2`)
  })
  it('keeps a failed resume notice within that run\'s log instead of quoting the previous done', async () => {
    const registry = await registryForDir(dir)
    const w = await worker(registry, 'failed-follow-up', { host: 'codex' })
    await registry.writeReport(w.id, { run: 1, nonce: w.runs[0].nonce, chain: [], joinedAt: 2,
      done: { at: 3, summary: 'original task done', changed: [] } })
    await registry.writeExit(w.id, { run: 1, code: 0, at: 4, witnessed: true })
    const previous = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done. marked done' } }) + '\n'
    const current = JSON.stringify({ type: 'turn.failed', error: { message: 'Current run failed' } }) + '\n'
    mkdirSync(join(dir, '.room', 'workers'), { recursive: true })
    writeFileSync(join(dir, '.room', 'workers', 'failed-follow-up.log'), previous + current)
    await registry.update(w.id, old => ({ ...old, runs: [...old.runs, { ...old.runs[0], n: 2, mode: 'resume', nonce: 'next',
      launch: { outcome: 'launched', pid: 0 }, logStart: Buffer.byteLength(previous) }], seq: old.seq + 1 }))
    await registry.writeExit(w.id, { run: 2, code: 1, at: 5, witnessed: true })
    const s = session(LOCAL, 'lead-s1')
    await projectWorkers(s, registry, lead.name, 'joined')
    const note = s.room.messages().find(m => m.id === `wk:${w.id}:2`)
    expect(note).toMatchObject({ type: 'note' })
    expect((note as { text: string }).text).toContain('Current run failed')
    expect((note as { text: string }).text).not.toContain('Done. marked done')
  })

  it('M10 posts a witnessed failure before retiring its last room record', async () => {
    const registry = await registryForDir(dir)
    const w = await worker(registry, 'retire-failure')
    const s = session(LOCAL, 'lead-s1')
    await registry.writeExit(w.id, { run: 1, code: 1, at: 5, witnessed: true })
    await registry.beginRetirement(w.id, registry.archiveOf(w, { summary: 'failed', disposition: 'discarded' }))
    await projectWorkers(s, registry, lead.name, 'joined')
    expect(s.room.messages().filter(m => m.id === `wk:${w.id}:1`)).toHaveLength(1)
    expect(s.room.workerViews.has(w.id)).toBe(false)
  })
  it('M10 keeps retirement cleanup pending until a failed completion post can replay', async () => {
    const registry = await registryForDir(dir)
    const w = await worker(registry, 'retire-retry')
    const s = session(LOCAL, 'lead-s1')
    await registry.writeExit(w.id, { run: 1, code: 1, at: 5, witnessed: true })
    await registry.beginRetirement(w.id, registry.archiveOf(w, { summary: 'failed', disposition: 'discarded' }))
    const original = registry.postObservedFailure.bind(registry)
    const spy = vi.spyOn(registry, 'postObservedFailure').mockRejectedValueOnce(new Error('hub unreachable'))
    await projectWorkers(s, registry, lead.name, 'joined')
    expect(s.room.messages().filter(m => m.id === `wk:${w.id}:1`)).toHaveLength(0)
    expect(registry.read(w.id)?.cleanup?.[LOCAL]).toBe('pending')
    spy.mockImplementation(original)
    await projectWorkers(s, registry, lead.name, 'joined')
    expect(s.room.messages().filter(m => m.id === `wk:${w.id}:1`)).toHaveLength(1)
    expect(registry.read(w.id)?.cleanup?.[LOCAL]).toBe('done')
  })
  it('writes one fenced view per non-retiring worker, updates it on change, and drops views of workers in neither list', async () => {
    const registry = await registryForDir(dir)
    const w = await worker(registry, 'money')
    const s = session(LOCAL, 'lead-s1')
    await projectWorkers(s, registry, lead.name, 'joined')
    expect(s.room.workerViews.get(w.id)).toMatchObject({ id: w.id, tag: 'money', name: 'rohanz+money', lead: lead.name, mode: 'local', fence: 'lead-s1', run: 1 })
    expect(registry.projectable(lead.name, LOCAL).write.map(x => x.record.id)).toEqual([w.id])
    expect(registry.projectable(lead.name, TEAM).write.map(x => x.record.id)).toEqual([w.id])
    expect(registry.projectable('someone-else', LOCAL).write).toEqual([])
    // A dead incarnation's view, and a view left by an older session of this lead, are replaced or removed.
    s.room.workerViews.set('w_gone', { ...s.room.workerViews.get(w.id)!, id: 'w_gone', fence: 'lead-s0' })
    ;(s.daemon as unknown as { fence: string }).fence = 'lead-s2'
    await projectWorkers(s, registry, lead.name, 'joined')
    expect([...s.room.workerViews.keys()]).toEqual([w.id])
    expect(s.room.workerViews.get(w.id)?.fence).toBe('lead-s2')
    await registry.writeExit(w.id, { run: 1, code: 1, at: 5, witnessed: true })
    await projectWorkers(s, registry, lead.name, 'joined')
    expect(s.room.workerViews.get(w.id)).toMatchObject({ status: 'failed', exitCode: 1, finishedAt: 5 })
  })

  it("clears a stopped worker's claims and scope once its host ended without reporting, and only its own", async () => {
    const registry = await registryForDir(dir)
    const w = await worker(registry, 'money')
    const s = session(LOCAL, 'lead-s1')
    live(s.room, w.name, w.id)
    await projectWorkers(s, registry, lead.name, 'joined')
    expect(s.room.openClaims()).toHaveLength(1)
    await registry.writeExit(w.id, { run: 1, code: 1, at: 5, witnessed: true })
    await projectWorkers(s, registry, lead.name, 'joined')
    expect(s.room.openClaims()).toEqual([])
    expect(s.room.scope(w.name)).toBeUndefined()
    await vi.waitFor(() => expect(s.room.messages().filter(m => m.type === 'release').map(m => (m as { summary: string }).summary)).toEqual(['worker stopped']))
  })

  it("row 18: in the team room the lead session writes only its 'here' workers; the bridge's 'local' views are not its to delete", async () => {
    const registry = await registryForDir(dir)
    const local = await worker(registry, 'money')
    const here = await worker(registry, 'here', { mode: 'here', room: TEAM, projectedInto: undefined,
      lead: { participant: lead.name, room: TEAM, instance: registry.instance } })
    const team = session(TEAM, 'lead-s1')
    await projectWorkers(team, registry, lead.name, 'projected')
    await projectWorkers(team, registry, lead.name, 'joined')
    expect(team.room.workerViews.get(here.id)).toMatchObject({ mode: 'here' })
    expect(team.room.workerViews.get(local.id)).toMatchObject({ mode: 'local' })
    await projectWorkers(team, registry, lead.name, 'joined')
    expect(team.room.workerViews.has(local.id)).toBe(true)
  })
})

describe('retirement keyed by worker ID (registry §12)', () => {
  it('retires in each room exactly once, marks that room done, and goes to retired when every room is', async () => {
    const registry = await registryForDir(dir)
    const w = await worker(registry, 'money')
    const localRoom = session(LOCAL, 'lead-s1'), teamRoom = session(TEAM, 'lead-s1')
    live(localRoom.room, w.name, w.id)
    await projectWorkers(localRoom, registry, lead.name, 'joined')
    await registry.beginRetirement(w.id, registry.archiveOf(w, { summary: 'collected', disposition: 'collected' }))
    expect(registry.read(w.id)).toMatchObject({ phase: 'retiring', cleanup: { [LOCAL]: 'pending', [TEAM]: 'pending' } })
    expect(registry.projectable(lead.name, LOCAL)).toMatchObject({ write: [], retire: [{ id: w.id }] })
    await projectWorkers(localRoom, registry, lead.name, 'joined')
    expect(localRoom.room.openClaims()).toEqual([])
    expect(localRoom.room.workerViews.has(w.id)).toBe(false)
    expect(localRoom.room.retiredWorkers()).toMatchObject([{ id: w.id, name: w.name, summary: 'collected' }])
    expect(registry.read(w.id)?.cleanup).toEqual({ [LOCAL]: 'done', [TEAM]: 'pending' })
    expect(registry.projectable(lead.name, LOCAL)).toEqual({ write: [], retire: [] })
    await projectWorkers(teamRoom, registry, lead.name, 'projected')
    expect(registry.read(w.id)).toMatchObject({ phase: 'retired', cleanup: { [LOCAL]: 'done', [TEAM]: 'done' } })
    await projectWorkers(localRoom, registry, lead.name, 'joined')
    expect(localRoom.room.retiredWorkers()).toHaveLength(1)
  })

  it('row 17: an offline room keeps the tag reserved; the old view is never recreated; cleanup never touches the newer worker', async () => {
    const registry = await registryForDir(dir)
    const w1 = await worker(registry, 'tests')
    const localRoom = session(LOCAL, 'lead-s1')
    live(localRoom.room, w1.name, w1.id)
    await projectWorkers(localRoom, registry, lead.name, 'joined')
    await registry.beginRetirement(w1.id, registry.archiveOf(w1, { summary: 'collected' }))
    await projectWorkers(localRoom, registry, lead.name, 'joined') // the team room is offline: its cleanup stays pending
    await projectWorkers(localRoom, registry, lead.name, 'joined')
    expect(localRoom.room.workerViews.has(w1.id)).toBe(false)
    await expect(worker(registry, 'tests')).rejects.toThrow(/tag in use/)
    // The team room comes back: its cleanup finishes and frees the tag for W2.
    await projectWorkers(session(TEAM, 'lead-s1'), registry, lead.name, 'projected')
    expect(registry.read(w1.id)?.phase).toBe('retired')
    const w2 = await worker(registry, 'tests')
    expect(w2.id).not.toBe(w1.id)
    live(localRoom.room, w2.name, w2.id)
    await projectWorkers(localRoom, registry, lead.name, 'joined')
    // A replayed retirement of W1 in this room leaves W2's name, claims and view alone.
    localRoom.room.retireWorker(w1.id, { ...registry.archiveOf(w1, { summary: 'collected' }), id: w1.id }, () => {})
    expect(localRoom.room.openClaims().map(c => c.by)).toEqual([w2.name])
    expect(localRoom.room.workerViews.get(w2.id)).toMatchObject({ name: w2.name })
    expect(localRoom.room.retiredWorkers().filter(r => r.id === w1.id)).toHaveLength(1)
  })
})
