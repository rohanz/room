import { afterEach, beforeAll, afterAll, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Awareness } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd, type Roomd } from '@room/roomd'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'

beforeAll(() => { vi.stubEnv('CHOKIDAR_USEPOLLING', '1'); vi.stubEnv('ROOM_MACHINE_ID', 'retained-test') })
afterAll(() => vi.unstubAllEnvs())

const active: Array<{ daemon: Roomd; tools: ReturnType<typeof createTools>; dir: string }> = []
afterEach(async () => {
  for (const { daemon, tools, dir } of active.splice(0)) {
    await tools.shutdown()
    await daemon.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
}

async function setup(existing?: string) {
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
    providerFactory: (_server, _name, doc) => {
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
  return { dir, daemon, tools, scope, pending }
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
  const { dir, daemon, tools, scope, pending } = await setup()
  scope('src/a.py')
  const batch = (daemon as unknown as { batch: { published(path: string): void } }).batch
  for (let i = 0; i < 6; i++) batch.published('src/a.py')
  writeFileSync(join(dir, 'src/a.py'), 'hot\n')
  pending('src/a.py')
  const done = await tools.call('room_done', { summary: 'edited a' })
  expect(done).toContain('stay shared')
  expect(daemon.roomDoc.text('src/a.py', 'Rohan')).toBeUndefined()
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

it('a secondary session names the publishing session in done and share replies', async () => {
  const { daemon, tools, scope } = await setup()
  scope('src/a.py')
  const awareness = daemon.provider.awareness
  awareness.getStates().set(999, { ...awareness.getLocalState(), user: { name: 'Alice', kind: 'agent' }, status: 'synced', publishUnder: undefined })
  ;(daemon as unknown as { choosePublisher(): void }).choosePublisher()
  const done = await tools.call('room_done', { summary: 'finished' })
  expect(done).toContain("This checkout's file text is published by Alice and follows Alice's declared area.")
  expect(done).not.toContain('stay shared')
  expect(done).not.toContain('changed files declared earlier')
  const share = await tools.call('room_share', { level: 'declared' })
  expect(share).toContain("This checkout's file text is published by Alice and follows Alice's declared area.")
  expect(share).not.toContain('changed files declared earlier')
  expect(await tools.call('room_share', {})).toContain("This checkout's file text is published by Alice and follows Alice's declared area.")
})
