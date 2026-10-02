import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import { manifestKey, manifestPaths, participantRecord } from '@room/shared'
import { startRoomd, type Roomd } from '@room/roomd'
import { policyFromLevel } from '@room/roomd/policy'
import type { WebsocketProvider } from 'y-websocket'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { resolveConfig } from '../src/config.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { seedRegistryWorker } from './registry-fixture.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'

let dir: string, daemon: Roomd | undefined, tools: ReturnType<typeof createTools> | undefined
const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
const incarnationText = (room: Session['room'], name: string, file: string) =>
  room.overlayText(manifestKey(name, room.manifestHead.get(name)!.fence), file)
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await tools?.shutdown()
  await daemon?.stop()
  if (dir) { await closeRegistryForDir(dir); fs.rmSync(dir, { recursive: true, force: true }) }
  tools = undefined; daemon = undefined
})

async function worker() {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-done-publish-')))
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
  fs.writeFileSync(path.join(dir, '.gitignore'), '.room/\n')
  fs.writeFileSync(path.join(dir, 'app.txt'), 'BASE\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD'), name = 'lead+w'
  const { registry, record } = await seedRegistryWorker(dir, 'w', { dir, branch: 'main', base })
  const run = record.runs[0]
  await registry.admit({ id: record.id, run: run.n, nonce: run.nonce, dir, chain: [] })
  daemon = await startRoomd({ dir, name, room: 'ws://memory/local/test', policy: policyFromLevel('full'),
    carried: { name, dir, base }, basePollMs: 0, trackedRefreshMs: 60_000, reconcileIntervalMs: 0,
    log: () => {}, providerFactory: (_s, _n, doc) => ({ synced: true, awareness: new Awareness(doc),
      on() {}, off() {}, destroy() { this.awareness.destroy() } }) as unknown as WebsocketProvider,
  })
  // Make the publication depend on room_done, not on watcher delivery or periodic polling.
  const internal = daemon as Roomd & { watcher: { removeAllListeners(event: string): void } }
  internal.watcher.removeAllListeners('all')
  const room = daemon.roomDoc
  const session = { dir, daemon, room, me: { name, kind: 'agent', owner: 'lead', label: 'w' },
    awareness: daemon.provider.awareness, provider: daemon.provider, policyStore: testPolicyStore(),
    ...hubSeam(room), roomName: 'local/test', roomUrl: 'ws://memory/local/test', browserUrl: 'http://memory',
    shareMax: 'full', shareRequested: 'full',
  } as Session
  tools = createTools({ cwd: dir, getSession: () => session, setSession() {}, listCwdProcesses: () => [],
    config: { ...await resolveConfig({ dir }), workerId: record.id } })
  room.addClaim({ path: 'app.txt', from: 1, to: 1, by: name, byKind: 'agent', intent: 'edit app' })
  return { room, name, registry, record, session }
}

it('publishes a commit and overlay before room_done releases claims and reports', async () => {
  const { room, name, registry, record, session } = await worker()
  fs.writeFileSync(path.join(dir, 'app.txt'), 'COMMITTED\n')
  git('add', 'app.txt'); git('commit', '-qm', 'worker edit')
  const head = git('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(dir, 'extra.txt'), 'UNCOMMITTED\n')
  expect(participantRecord(room, name)?.git?.head).not.toBe(head)
  const post = session.post
  session.post = ((...args: Parameters<Session['post']>) => {
    if (args[1].type === 'done') {
      expect(participantRecord(room, name)?.git?.head).toBe(head)
      expect(incarnationText(room, name, 'app.txt')?.toString()).toBe('COMMITTED\n')
      expect(incarnationText(room, name, 'extra.txt')?.toString()).toBe('UNCOMMITTED\n')
    }
    return post(...args)
  }) as Session['post']
  expect(await tools!.call('room_done', { summary: 'finished' })).toContain('marked done')
  expect(participantRecord(room, name)?.git?.head).toBe(head)
  expect(room.manifestHead.get(name)?.complete).toBe(true)
  expect(manifestPaths(room, name)).toEqual(['app.txt', 'extra.txt'])
  expect(registry.reports(record.id)[0].done?.changed).toEqual(['app.txt', 'extra.txt'])
  expect(room.openClaims().filter(c => c.by === name)).toEqual([])
})

it('keeps claims and records no report when publication exceeds its bound', async () => {
  const { room, name, registry, record } = await worker()
  expect(room.openClaims().some(c => c.by === name)).toBe(true)
  let entered!: () => void, reject!: (error: Error) => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>((_, fail) => { reject = fail })
  vi.spyOn(daemon!, 'reconcileGitChanges').mockImplementation(() => { entered(); return held })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const done = tools!.call('room_done', { summary: 'finished' })
    await started
    expect(room.openClaims().some(c => c.by === name)).toBe(true)
    expect(registry.reports(record.id).some(report => report.done)).toBe(false)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await done).toContain('publication did not settle within 15 s')
    expect(room.openClaims().some(c => c.by === name)).toBe(true)
    expect(registry.reports(record.id).some(report => report.done)).toBe(false)
    expect(room.messages().some(message => message.type === 'done')).toBe(false)
  } finally { reject(new Error('test publication stopped')); vi.useRealTimers() }
})

it('refuses an incomplete publication even when daemon reconciliation resolves', async () => {
  const { room, name, registry, record } = await worker()
  vi.spyOn(daemon!, 'reconcileGitChanges').mockResolvedValue()
  room.manifestHead.set(name, { ...room.manifestHead.get(name)!, complete: false })
  expect(await tools!.call('room_done', { summary: 'finished' })).toContain('current HEAD and overlay are not published yet')
  expect(room.openClaims().some(c => c.by === name)).toBe(true)
  expect(registry.reports(record.id).some(report => report.done)).toBe(false)
})

it('uses the checkout publisher when the worker is a secondary session', async () => {
  const { room, name } = await worker()
  vi.spyOn(daemon!, 'reconcileGitChanges').mockResolvedValue()
  const head = room.manifestHead.get(name)!, published = participantRecord(room, name)!.git!
  room.participants.set('primary\0git', { ...published, fence: 'primary-fence' })
  room.manifestHead.set('primary', { ...head, fence: 'primary-fence' })
  room.participants.delete(`${name}\0git`)
  room.manifestHead.set(name, { ...head, coverage: { kind: 'none', reason: 'not-publisher' }, publisher: 'primary' })
  expect(await tools!.call('room_done', { summary: 'finished' })).toContain('marked done')
})
