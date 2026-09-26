import { afterEach, beforeAll, afterAll, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Awareness } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd, type Roomd, type RoomdOptions } from '@room/roomd'
import { RoomDoc } from '@room/shared'
import { createTools } from '../src/tools.js'
import { sharingSentence } from '../src/tools/join.js'
import type { Session } from '../src/session.js'

beforeAll(() => { vi.stubEnv('CHOKIDAR_USEPOLLING', '1'); vi.stubEnv('ROOM_MACHINE_ID', 'retained-test') })
afterAll(() => vi.unstubAllEnvs())

const active: Array<{ daemon: Roomd; tools: ReturnType<typeof createTools>; dir: string }> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const { daemon, tools, dir } of active.splice(0)) {
    await tools.shutdown()
    await daemon.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
}

async function setup(existing?: string, extra: Partial<RoomdOptions> = {}, scopeOnConnect = false, onDoc?: (room: RoomDoc) => void) {
  const dir = existing ?? mkdtempSync(join(tmpdir(), 'room-retained-done-'))
  if (!existing) {
    mkdirSync(join(dir, 'src'))
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'config', 'user.email', 'test@example.com')
    git(dir, 'config', 'user.name', 'Test')
    writeFileSync(join(dir, 'src', 'a.py'), 'base\n')
    writeFileSync(join(dir, 'src', 'b.py'), 'base\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'init')
  }
  const daemon = await startRoomd({ dir, name: 'Rohan', room: 'ws://memory/retained-done', share: 'declared',
    debounceMs: 20, hotThrottleMs: 100, trackedRefreshMs: 60_000, basePollMs: 60_000, log: () => {},
    ...extra,
    providerFactory: (_server, _name, doc) => {
      const room = new RoomDoc(doc)
      onDoc?.(room)
      if (scopeOnConnect) room.setScope({ by: 'Rohan', byKind: 'agent', area: 'src', summary: 'edit', paths: ['src/a.py'] })
      const awareness = new Awareness(doc)
      const provider = { synced: true, awareness, on() { return provider }, off() { return provider }, destroy() { awareness.destroy() } }
      return provider as unknown as WebsocketProvider
    },
  })
  const s: Session = {
    room: daemon.roomDoc, daemon, awareness: daemon.provider.awareness, provider: daemon.provider,
    me: { name: 'Rohan', kind: 'agent' }, dir, roomUrl: 'ws://memory/retained-done', roomName: 'retained-done',
    browserUrl: 'http://memory', shareMax: 'full', shareRequested: 'declared',
  }
  const tools = createTools({ cwd: dir, getSession: () => s, setSession: () => {} })
  active.push({ daemon, tools, dir })
  const scope = (path: string) => daemon.roomDoc.setScope({ by: 'Rohan', byKind: 'agent', area: 'src', summary: 'edit', paths: [path] })
  const pending = (path: string) => (daemon as unknown as { batch: { add(path: string, fresh: boolean): void } }).batch.add(path, false)
  return { dir, daemon, tools, session: s, scope, pending }
}

it('retains an edit already pending in the batch at done and publishes it later', async () => {
  const { dir, daemon, tools, scope, pending } = await setup()
  scope('src/a.py')
  writeFileSync(join(dir, 'src/a.py'), 'edited\n')
  pending('src/a.py')
  expect(daemon.roomDoc.text('src/a.py', 'Rohan')).toBeUndefined()
  const done = await tools.call('room_done', { summary: 'edited a' })
  expect(done).toContain('1 changed file(s) you declared earlier stay shared while they differ from your base: src/a.py.')
  expect(daemon.retainedDeclared()).toEqual(['src/a.py'])
  await vi.waitFor(() => expect(daemon.roomDoc.text('src/a.py', 'Rohan')).toBe('edited\n'))
  expect(await tools.call('room_share', { level: 'declared' })).toContain('1 changed file(s) you declared earlier remain shared: src/a.py')
  expect(await tools.call('room_share', {})).toContain('; still shared from earlier: src/a.py')
})

it('retains a withheld edit while a new scope publication waits on its base read', async () => {
  let release!: () => void, entered!: () => void, armed = false
  const held = new Promise<void>(resolve => { release = resolve })
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const first = await setup()
  await first.tools.shutdown(); await first.daemon.stop()
  active.splice(active.findIndex(entry => entry.daemon === first.daemon), 1)
  writeFileSync(join(first.dir, 'src/a.py'), 'edited\n')
  const { daemon, scope } = await setup(first.dir, { beforeBaseRead: async path => {
    if (armed && path === 'src/a.py') { armed = false; entered(); await held }
  } })
  expect(daemon.skipped().share).toContain('src/a.py')
  armed = true
  scope('src/a.py')
  await waiting
  daemon.roomDoc.clearScope('Rohan')
  expect(daemon.retainedDeclared()).toEqual(['src/a.py'])
  release()
  await vi.waitFor(() => expect(daemon.roomDoc.text('src/a.py', 'Rohan')).toBe('edited\n'))
})

it('retains a scope transition during startup seeding', async () => {
  const first = await setup()
  await first.tools.shutdown(); await first.daemon.stop()
  active.splice(active.findIndex(entry => entry.daemon === first.daemon), 1)
  writeFileSync(join(first.dir, 'src/a.py'), 'edited\n')
  let daemonDoc: RoomDoc | undefined
  let changed = false
  const next = await setup(first.dir, { beforeBaseRead: async path => {
    if (changed || path !== 'src/a.py' || !daemonDoc) return
    changed = true
    daemonDoc.setScope({ by: 'Rohan', byKind: 'agent', area: 'src', summary: 'edit', paths: ['src/a.py'] })
    daemonDoc.clearScope('Rohan')
  } }, false, room => { daemonDoc = room })
  expect(next.daemon.retainedDeclared()).toEqual(['src/a.py'])
  await vi.waitFor(() => expect(next.daemon.roomDoc.text('src/a.py', 'Rohan')).toBe('edited\n'))
})

it('retains a changed file when a scope shrinks from A to B', async () => {
  const { dir, daemon, scope, pending } = await setup()
  scope('src/a.py')
  writeFileSync(join(dir, 'src/a.py'), 'edited\n')
  pending('src/a.py')
  await vi.waitFor(() => expect(daemon.roomDoc.text('src/a.py', 'Rohan')).toBe('edited\n'))
  scope('src/b.py')
  expect(daemon.retainedDeclared()).toEqual(['src/a.py'])
  expect(daemon.roomDoc.text('src/a.py', 'Rohan')).toBe('edited\n')
})

it('retries failed queued disk reconciliation with bounded backoff', async () => {
  const retries: Array<{ run: () => void; delay: number }> = []
  let fail = false
  const { dir, daemon, scope, pending } = await setup(undefined, {
    beforeBaseRead: async () => { if (fail) { fail = false; throw new Error('injected git read failure') } },
    retrySchedule: (run, delay) => { retries.push({ run, delay }); return () => {} },
  })
  scope('src/a.py')
  await vi.waitFor(() => expect(daemon.roomDoc.scope('Rohan')).toBeDefined())
  writeFileSync(join(dir, 'src/a.py'), 'recovered\n')
  fail = true
  pending('src/a.py')
  await vi.waitFor(() => expect(retries).toHaveLength(1))
  expect(retries[0].delay).toBe(1000)
  retries[0].run()
  await vi.waitFor(() => expect(daemon.roomDoc.text('src/a.py', 'Rohan')).toBe('recovered\n'))
  expect(retries).toHaveLength(1)
})

it('retains published deletion marks when explicit scope paths shrink', async () => {
  const { dir, daemon, pending } = await setup()
  await daemon.setShare('declared', ['src/a.py'])
  rmSync(join(dir, 'src/a.py'))
  pending('src/a.py')
  await vi.waitFor(() => expect(daemon.roomDoc.deletedFor('Rohan').has('src/a.py')).toBe(true))
  await daemon.setShare('declared', ['src/b.py'])
  expect(daemon.retainedDeclared()).toEqual(['src/a.py'])
  expect(daemon.roomDoc.deletedFor('Rohan').has('src/a.py')).toBe(true)
})

it('drops a retained file after its revert is reconciled', async () => {
  const { dir, daemon, tools, scope, pending } = await setup()
  scope('src/a.py')
  writeFileSync(join(dir, 'src/a.py'), 'edited\n')
  pending('src/a.py')
  await tools.call('room_done', { summary: 'edited a' })
  await vi.waitFor(() => expect(daemon.roomDoc.text('src/a.py', 'Rohan')).toBe('edited\n'))
  writeFileSync(join(dir, 'src/a.py'), 'base\n')
  pending('src/a.py')
  await vi.waitFor(() => expect(daemon.retainedDeclared()).toEqual([]))
  expect(daemon.roomDoc.text('src/a.py', 'Rohan')).toBeUndefined()
})

it('retains a hot file pending at done until throttled publication', async () => {
  let release!: () => void, entered!: () => void, armed = false
  const held = new Promise<void>(resolve => { release = resolve })
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const { dir, daemon, tools, scope, pending } = await setup(undefined, {
    beforePublishWrite: async path => { if (armed && path === 'src/a.py') { armed = false; entered(); await held } },
  })
  scope('src/a.py')
  await daemon.setShare('declared')
  const batch = (daemon as unknown as { batch: { published(path: string): void } }).batch
  for (let i = 0; i < 6; i++) batch.published('src/a.py')
  armed = true
  writeFileSync(join(dir, 'src/a.py'), 'hot\n')
  pending('src/a.py')
  await waiting
  const done = await tools.call('room_done', { summary: 'edited a' })
  expect(done).toContain('stay shared')
  expect(daemon.roomDoc.text('src/a.py', 'Rohan')).toBeUndefined()
  release()
  await vi.waitFor(() => expect(daemon.roomDoc.text('src/a.py', 'Rohan')).toBe('hot\n'))
})

it('a level change withdraws retained text', async () => {
  const { dir, daemon, tools, scope, pending } = await setup()
  scope('src/a.py')
  writeFileSync(join(dir, 'src/a.py'), 'edited\n')
  pending('src/a.py')
  await tools.call('room_done', { summary: 'edited a' })
  await vi.waitFor(() => expect(daemon.roomDoc.text('src/a.py', 'Rohan')).toBe('edited\n'))
  expect(await tools.call('room_share', { level: 'intent' })).toContain('changed sharing declared ->')
  expect(daemon.retainedDeclared()).toEqual([])
  expect(daemon.roomDoc.text('src/a.py', 'Rohan')).toBeUndefined()
})

it('retention survives a daemon restart', async () => {
  const first = await setup()
  first.scope('src/a.py')
  writeFileSync(join(first.dir, 'src/a.py'), 'edited\n')
  first.pending('src/a.py')
  await first.tools.call('room_done', { summary: 'edited a' })
  await vi.waitFor(() => expect(first.daemon.roomDoc.text('src/a.py', 'Rohan')).toBe('edited\n'))
  await first.tools.shutdown()
  await first.daemon.stop()
  active.splice(active.findIndex(entry => entry.daemon === first.daemon), 1)
  const next = await setup(first.dir)
  expect(next.daemon.retainedDeclared()).toEqual(['src/a.py'])
  expect(next.daemon.roomDoc.text('src/a.py', 'Rohan')).toBe('edited\n')
})

it('retains the active scope on restart when stale session state is cleared', async () => {
  const first = await setup()
  first.scope('src/a.py')
  writeFileSync(join(first.dir, 'src/a.py'), 'edited\n')
  first.pending('src/a.py')
  await vi.waitFor(() => expect(first.daemon.roomDoc.text('src/a.py', 'Rohan')).toBe('edited\n'))
  await first.tools.shutdown(); await first.daemon.stop()
  active.splice(active.findIndex(entry => entry.daemon === first.daemon), 1)
  const next = await setup(first.dir, {}, true)
  next.tools.clearStale({ room: next.daemon.roomDoc, daemon: next.daemon, awareness: next.daemon.provider.awareness,
    provider: next.daemon.provider, me: { name: 'Rohan', kind: 'agent' }, dir: first.dir, roomUrl: 'ws://memory/retained-done',
    roomName: 'retained-done', browserUrl: 'http://memory', shareMax: 'full', shareRequested: 'declared' })
  expect(next.daemon.retainedDeclared()).toEqual(['src/a.py'])
  expect(next.daemon.roomDoc.text('src/a.py', 'Rohan')).toBe('edited\n')
})

it('a declared secondary describes the full primary in done, share and join disclosures', async () => {
  const { daemon, tools, session, scope } = await setup()
  scope('src/a.py')
  const awareness = daemon.provider.awareness
  awareness.getStates().set(999, { ...awareness.getLocalState(), user: { name: 'Alice', kind: 'agent' }, status: 'synced', publishUnder: undefined, share: 'full' })
  ;(daemon as unknown as { choosePublisher(): void }).choosePublisher()
  const done = await tools.call('room_done', { summary: 'finished' })
  expect(done).toContain("This checkout's file text is published by Alice and follows Alice's sharing settings (full).")
  expect(done).not.toContain('stay shared')
  expect(done).not.toContain('changed files declared earlier')
  const share = await tools.call('room_share', { level: 'declared' })
  expect(share).toContain("This checkout's file text is published by Alice and follows Alice's sharing settings (full).")
  expect(share).not.toContain('changed files declared earlier')
  expect(await tools.call('room_share', {})).toContain("This checkout's file text is published by Alice and follows Alice's sharing settings (full).")
  expect(sharingSentence(session)).toContain("This checkout's file text is published by Alice and follows Alice's sharing settings (full).")
  await daemon.setShare('intent')
  expect(await tools.call('room_share', {})).toContain("This checkout's file text is published by Alice and follows Alice's sharing settings (full).")
  await daemon.setShare('full')
  expect(await tools.call('room_share', {})).toContain("This checkout's file text is published by Alice and follows Alice's sharing settings (full).")
})
