import { mutateWorkerFixture } from './fixtures/worker-record.js'
import { expectRetired, git, lead, put, root, setup, worker } from './collect-fixture.js'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { autoRetire } from '../src/retire.js'
import { registryForDir } from '../src/worker-registry.js'
import { workerByTag } from './registry-fixture.js'

/**
 * Observed 2026-11-10: finished Codex workers spawned with dir= into a checkout that was later removed (its branch
 * deleted with it) stayed active forever. Every plain room_collect printed "skipped <tag>: no local worker capability",
 * discard refused, and the sweep never retired them because a recorded host session keeps a finished worker addressable.
 */
type Setup = ReturnType<typeof setup>

/** A worker spawned with dir= into a checkout outside the repo, on that checkout's branch, finished with a host session. */
async function outsideWorker(t: Setup, tag = 'test') {
  const dir = path.join(root, 'jobs', 'wt-s1')
  fs.mkdirSync(dir, { recursive: true })
  t.pending.delete('test')
  t.set(tag, { ...t.w, tag, name: `lead+${tag}`, dir, branch: 'sqlite-slice1', hostSessionId: `thread-${tag}`, mode: 'here',
    ...(t.w.status === 'running' ? {} : { exitCode: 0, finishedAt: 1 }) })
  await t.sync()
  const registry = await registryForDir(lead)
  const id = `w_${tag}`
  await mutateWorkerFixture(registry, id, prior => ({ ...prior, outside: true, capabilities: { ...prior.capabilities, collect: 'none' }, seq: prior.seq + 1 }))
  await t.state.rooms.project()
  return { dir, id }
}

/** A Room worktree worker whose worktree and branch were both removed by hand, finished with a host session. */
async function goneRoomWorker(t: Setup) {
  t.set('test', { ...t.w, hostSessionId: 'thread-test', exitCode: 0, finishedAt: 1 })
  await t.sync()
  await t.state.rooms.project()
  git(lead, 'worktree', 'remove', '--force', worker)
  git(lead, 'branch', '-D', 'room/test')
}

const rooms = (t: Setup) => ({ ...t.state.rooms, probe: () => undefined, listCwdProcesses: () => [] }) as never
/** The clone's retention pass runs at most hourly per process; step past its window. */
function nextSweepWindow() {
  const real = Date.now
  let offset = (nextSweepWindow as { offset?: number }).offset ?? 0
  offset += 2 * 60 * 60 * 1000
  ;(nextSweepWindow as { offset?: number }).offset = offset
  vi.spyOn(Date, 'now').mockImplementation(() => real.call(Date) + offset)
}
afterEach(() => { vi.restoreAllMocks() })

describe('finished workers with nothing to collect', () => {
  it('plain room_collect retires them with one summary line instead of repeating a skip line', async () => {
    const t = setup()
    await outsideWorker(t, 'one')
    await outsideWorker(t, 'two')
    fs.rmSync(path.join(root, 'jobs'), { recursive: true, force: true })
    const reply = await t.call({})
    expect(reply).not.toContain('no local worker capability')
    expect(reply.split('\n').filter(line => line.includes('nothing to collect'))).toEqual([
      'retired 2 finished workers with nothing to collect (their worktree and branch are gone): one, two',
    ])
    for (const tag of ['one', 'two']) expect((await workerByTag(lead, tag))).toBeUndefined()
    const archived = t.s.room.retiredWorkers().map(r => [r.tag, r.summary, r.disposition])
    expect(archived).toEqual(expect.arrayContaining([
      ['one', 'nothing to collect: its worktree and branch were already gone', 'discarded'],
      ['two', 'nothing to collect: its worktree and branch were already gone', 'discarded'],
    ]))
    expect(await t.call({})).toBe('No finished changes to collect.')
  })

  it('the sweep retires them once, and their final publication stops taking part in conflict checks', async () => {
    const t = setup()
    await goneRoomWorker(t)
    put(lead, 'new.txt', 'lead')
    const name = t.w.name
    t.s.room.setScope({ by: name, byKind: 'agent', area: 'test', summary: 'editing', paths: ['new.txt'] })
    t.s.room.addClaim({ by: name, byKind: 'agent', path: 'new.txt', from: 1, to: 1, intent: 'editing' })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    nextSweepWindow()
    await autoRetire(t.s, rooms(t))
    await expectRetired(t)
    expect(t.s.room.retiredWorkers().map(r => [r.tag, r.summary])).toEqual([['test', 'nothing to collect: its worktree and branch were already gone']])
    const said = stderr.mock.calls.map(call => String(call[0])).filter(line => line.includes('nothing to collect'))
    expect(said).toEqual(['[room] retired 1 finished worker with nothing to collect (its worktree and branch are gone): test\n'])
    await autoRetire(t.s, rooms(t))
    expect(stderr.mock.calls.map(call => String(call[0])).filter(line => line.includes('nothing to collect'))).toHaveLength(1)
  })

  it('discard=true on such a record succeeds and removes it', async () => {
    const t = setup()
    const { id } = await outsideWorker(t)
    fs.rmSync(path.join(root, 'jobs'), { recursive: true, force: true })
    put(lead, '.room/workers/test.log', 'transcript')
    const reply = await t.call({ tag: 'test', discard: true })
    expect(fs.existsSync(path.join(lead, '.room/workers/test.log'))).toBe(false)
    expect(reply).toBe('discarded test: nothing to collect; its worktree and branch were already gone')
    expect((await (await registryForDir(lead)).read(id))?.phase).toBe('retired')
    expect((await workerByTag(lead, 'test'))).toBeUndefined()
  })

  it('collect by tag retires it too, while keep=true (which promises resumption) leaves it alone', async () => {
    const t = setup()
    const { id } = await outsideWorker(t)
    fs.rmSync(path.join(root, 'jobs'), { recursive: true, force: true })
    expect(await t.call({ tag: 'test', keep: true })).toContain('skipped test: no local worker capability')
    expect((await (await registryForDir(lead)).read(id))?.phase).toBe('active')
    expect(await t.call({ tag: 'test' })).toBe('retired 1 finished worker with nothing to collect (its worktree and branch are gone): test')
    expect((await (await registryForDir(lead)).read(id))?.phase).toBe('retired')
  })

  describe('anything recoverable keeps today\'s behaviour', () => {
    it('keeps a worker whose checkout still exists', async () => {
      const t = setup()
      const { id } = await outsideWorker(t)
      nextSweepWindow()
      await autoRetire(t.s, rooms(t))
      expect((await (await registryForDir(lead)).read(id))?.phase).toBe('active')
      expect(await t.call({})).toContain('skipped test: no local worker capability')
    })

    it('keeps a worker whose worktree is gone while its branch remains', async () => {
      const t = setup()
      t.set('test', { ...t.w, hostSessionId: 'thread-test', exitCode: 0, finishedAt: 1 })
      await t.sync()
      put(worker, 'work.txt', 'committed work')
      git(worker, 'add', 'work.txt'); git(worker, 'commit', '-qm', 'work')
      const head = git(lead, 'rev-parse', 'room/test')
      fs.rmSync(worker, { recursive: true, force: true })
      nextSweepWindow()
      await autoRetire(t.s, rooms(t))
      expect((await (await registryForDir(lead)).read('w_test'))?.phase).toBe('active')
      expect(await t.call({})).toContain('skipped test: no local worker capability')
      expect((await (await registryForDir(lead)).read('w_test'))?.phase).toBe('active')
      expect(git(lead, 'rev-parse', 'room/test')).toBe(head)
    })

    it('keeps an outside worker whose branch still exists in this clone', async () => {
      const t = setup()
      git(lead, 'branch', 'sqlite-slice1')
      const { id } = await outsideWorker(t)
      fs.rmSync(path.join(root, 'jobs'), { recursive: true, force: true })
      nextSweepWindow()
      await autoRetire(t.s, rooms(t))
      expect((await (await registryForDir(lead)).read(id))?.phase).toBe('active')
      expect(await t.call({})).toContain('skipped test: no local worker capability')
    })

    it('keeps a worker whose host process is still running', async () => {
      const t = setup('running')
      const { id } = await outsideWorker(t)
      fs.rmSync(path.join(root, 'jobs'), { recursive: true, force: true })
      nextSweepWindow()
      await autoRetire(t.s, rooms(t))
      expect((await (await registryForDir(lead)).read(id))?.phase).toBe('active')
    })
  })
})
