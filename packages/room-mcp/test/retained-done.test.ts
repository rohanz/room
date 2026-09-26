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

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'room-retained-done-'))
  mkdirSync(join(dir, 'src'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  writeFileSync(join(dir, 'src', 'a.py'), 'base\n')
  writeFileSync(join(dir, 'src', 'b.py'), 'base\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  const daemon = await startRoomd({ dir, name: 'Rohan', room: 'ws://memory/retained-done', share: 'declared',
    debounceMs: 500, trackedRefreshMs: 10_000, basePollMs: 10_000, log: () => {},
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
  return { dir, daemon, tools, scope }
}

it('room_done publishes a pending first edit, and room_share reports retained text until the level changes', async () => {
  const { dir, daemon, tools, scope } = await setup()
  scope('src/a.py')
  writeFileSync(join(dir, 'src', 'a.py'), 'edited\n')
  const done = await tools.call('room_done', { summary: 'edited a' })
  expect(done).toContain('1 changed file(s) you declared earlier stay shared while they differ from your base: src/a.py. To withdraw them, say: share plans only.')
  expect(daemon.roomDoc.text('src/a.py', 'Rohan')).toBe('edited\n')
  expect(daemon.retainedDeclared()).toEqual(['src/a.py'])
  expect(await tools.call('room_share', { level: 'declared' })).toContain('1 changed file(s) you declared earlier remain shared: src/a.py')
  expect(daemon.roomDoc.text('src/a.py', 'Rohan')).toBe('edited\n')
  expect(await tools.call('room_share', { level: 'intent' })).toContain('changed sharing declared ->')
  expect(daemon.roomDoc.text('src/a.py', 'Rohan')).toBeUndefined()
  expect(daemon.retainedDeclared()).toEqual([])
})

it.each(['commit', 'revert'])('room_done omits a file after %s just before completion', async action => {
  const { dir, daemon, tools, scope } = await setup()
  scope('src/b.py')
  writeFileSync(join(dir, 'src', 'b.py'), 'edited\n')
  await daemon.publishCurrent()
  expect(daemon.retainedDeclared()).toEqual(['src/b.py'])
  if (action === 'commit') {
    git(dir, 'add', 'src/b.py')
    git(dir, 'commit', '-q', '-m', 'edit b')
  } else writeFileSync(join(dir, 'src', 'b.py'), 'base\n')
  const done = await tools.call('room_done', { summary: `${action} b` })
  expect(done).not.toContain('stay shared')
  expect(daemon.retainedDeclared()).toEqual([])
  expect(daemon.roomDoc.changedPaths('Rohan')).toEqual([])
})
