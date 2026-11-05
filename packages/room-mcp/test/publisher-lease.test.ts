import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InstanceToken } from '../src/leases.js'
import { attachPublisher, PublisherLease } from '../src/publisher-lease.js'

const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function commonDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-publisher-'))
  dirs.push(dir)
  return dir
}
const self = { startTime: 'fixture-start', executable: 'fixture-node' }
const fixtureProbe = (pid: number) => pid === process.pid ? self : undefined
const token = (sessionId: string, pid = process.pid): InstanceToken => ({ pid, ...self, sessionId, nonce: randomUUID() })
const lease = (common: string, sessionId: string, pid = process.pid) => new PublisherLease(common, '/w', token(sessionId, pid), fixtureProbe)

describe('publisher lease (registry §16)', () => {
  it('five sessions in one checkout: exactly one publishes, and the others name it', async () => {
    const common = commonDir()
    const sessions = ['ann', 'ben', 'cy', 'di', 'ed'].map(name => ({ name, lease: lease(common, `s-${name}`) }))
    const won = await Promise.all(sessions.map(s => s.lease.attach('local/r', s.name)))
    expect(won.filter(Boolean)).toHaveLength(1)
    const publisher = sessions[won.indexOf(true)]
    for (const s of sessions) {
      expect(s.lease.holds()).toBe(s === publisher)
      expect(s.lease.publisher('local/r')).toBe(s === publisher ? undefined : publisher.name)
    }
    // Ticks of the others take nothing while the holder lives.
    expect((await Promise.all(sessions.map(s => s.lease.tick()))).filter(Boolean)).toHaveLength(1)
  })

  it('the publisher leaves: the next tick of an attached session takes over, never two at once (row 24)', async () => {
    const common = commonDir()
    const a = lease(common, 'sa'), b = lease(common, 'sb'), c = lease(common, 'sc')
    expect(await a.attach('local/r', 'ann')).toBe(true)
    expect(await b.attach('local/r', 'ben')).toBe(false)
    expect(await c.attach('local/r', 'cy')).toBe(false)
    const changes: boolean[] = []
    a.onChange(() => changes.push(a.holds()))
    // Until the leaver (which withdrew first) detaches, nobody else can publish.
    expect(await b.tick()).toBe(false)
    await a.detach('local/r')
    expect(a.holds()).toBe(false)
    expect(changes).toEqual([false])
    const took = await Promise.all([b.tick(), c.tick()])
    expect(took.filter(Boolean)).toHaveLength(1)
    expect([b.holds(), c.holds()].filter(Boolean)).toHaveLength(1)
  })

  it('recovers the lease from a dead holder only', async () => {
    const common = commonDir()
    const dead = lease(common, 'sd', 2 ** 22 + 31)
    // A holder whose process is gone (written as it would have been before it died).
    expect(await dead.attach('local/r', 'dee')).toBe(true)
    const live = lease(common, 'sl')
    expect(await live.attach('local/r', 'lee')).toBe(true)
    expect(live.publisher('local/r')).toBeUndefined()
  })

  it('publishes one worktree in every room its process attaches, and the last detach releases it', async () => {
    const common = commonDir()
    const lead = lease(common, 'lead')
    const other = lease(common, 'other')
    await lead.attach('https://room.example/github.com/o/r', 'rohan')
    await lead.attach('local/r-workers', 'rohan')
    await other.attach('local/r-workers', 'rohan+codex')
    expect(other.publisher('https://room.example/github.com/o/r')).toBe('rohan')
    expect(other.publisher('local/r-workers')).toBe('rohan')
    await lead.detach('local/r-workers')
    expect(lead.holds()).toBe(true)
    // Never redirect readers into another room's participant namespace.
    expect(other.publisher('local/r-workers')).toBeUndefined()
    await lead.detach('https://room.example/github.com/o/r')
    expect(fs.readdirSync(path.join(common, 'room', 'publishers')).filter(f => f.endsWith('.json'))).toEqual([])
    expect(await other.tick()).toBe(true)
  })
})

it('an active second session requests an idle publisher to yield before taking over', async () => {
  const common = commonDir()
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const idle = lease(common, 'idle')
  await idle.attach('local/r', 'idle')
  // Reproduce a live process that has not received a tool call for eight hours.
  now += 8 * 60 * 60_000
  const active = lease(common, 'active')
  await active.attach('local/r', 'active')
  const demotions: boolean[] = []
  idle.onChange(() => demotions.push(idle.holds()))
  expect(active.holds()).toBe(false)
  await idle.tick()
  expect(idle.holds()).toBe(false)
  expect(demotions).toEqual([false])
  expect(await active.tick()).toBe(true)
  expect(idle.publisher('local/r')).toBe('active')
  // A still-idle old process cannot steal it back.
  expect(await idle.tick()).toBe(false)
})

it('verified activity cancels an idle handoff request; publication ticks do not count as activity', async () => {
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const common = commonDir(), idle = lease(common, 'idle')
  await idle.attach('team/r', 'idle')
  now += 121_000
  const active = lease(common, 'active')
  await active.attach('team/r', 'active')
  expect(JSON.parse(fs.readFileSync(idle.file, 'utf8')).requested).toBeDefined()
  await idle.activity()
  expect(idle.holds()).toBe(true)
  expect(await active.tick()).toBe(false)
  expect(JSON.parse(fs.readFileSync(idle.file, 'utf8')).lastActive).toBe(now)
  now += 121_000
  await active.activity()
  await idle.tick()
  expect(idle.holds()).toBe(false)
  expect(await active.tick()).toBe(true)
})

it('withdraws every attached room synchronously before the successor can publish', async () => {
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const common = commonDir(), old = lease(common, 'old')
  const publishing = new Set<string>()
  const attach = (l: PublisherLease, roomKey: string, participant: string) => attachPublisher({
    lease: l, roomKey, participant, named: () => true,
    setPublisher: value => { if (value) publishing.add(participant); else publishing.delete(participant) },
  })
  const team = await attach(old, 'team/r', 'old-team')
  const local = await attach(old, 'local/r', 'old-local')
  now += 121_000
  const next = lease(common, 'next')
  const active = await attach(next, 'team/r', 'active')
  expect(publishing).toEqual(new Set(['old-team', 'old-local']))
  // A listener runs inside withdrawal, while the old lease file still exists.
  old.onChange(() => {
    if (!old.holds()) {
      expect(fs.existsSync(old.file)).toBe(true)
      expect(publishing.size).toBe(0)
      expect(next.holds()).toBe(false)
    }
  })
  await old.tick()
  expect(publishing.size).toBe(0)
  await next.tick()
  expect(publishing).toEqual(new Set(['active']))
  await team.detach(); await local.detach(); await active.detach()
})
