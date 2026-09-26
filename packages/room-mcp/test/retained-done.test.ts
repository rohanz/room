import { afterEach, beforeAll, afterAll, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs'
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

async function setup(beforeBaseRead?: (path: string) => Promise<void>) {
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
    debounceMs: 60_000, trackedRefreshMs: 60_000, basePollMs: 60_000, beforeBaseRead, log: () => {},
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
  const declare = async (path: string) => { scope(path); await daemon.setShare('declared') }
  return { dir, daemon, tools, scope: declare }
}

it('room_done publishes a pending first edit, and room_share reports retained text until the level changes', async () => {
  const { dir, daemon, tools, scope } = await setup()
  await scope('src/a.py')
  writeFileSync(join(dir, 'src', 'a.py'), 'edited\n')
  expect(daemon.retainedDeclared()).toEqual([])
  expect(daemon.roomDoc.overlayText('Rohan', 'src/a.py')).toBeUndefined()
  const done = await tools.call('room_done', { summary: 'edited a' })
  expect(done).toContain('1 changed file(s) you declared earlier stay shared while they differ from your base: src/a.py. A sharing-level change, ignore rule, or size limit withdraws them; declare them again to share. Share plans only withdraws them.')
  expect(daemon.roomDoc.text('src/a.py', 'Rohan')).toBe('edited\n')
  expect(daemon.retainedDeclared()).toEqual(['src/a.py'])
  expect(await tools.call('room_share', { level: 'declared' })).toContain('1 changed file(s) you declared earlier remain shared: src/a.py')
  expect(daemon.roomDoc.text('src/a.py', 'Rohan')).toBe('edited\n')
  expect(await tools.call('room_share', { level: 'intent' })).toContain('changed sharing declared ->')
  expect(daemon.roomDoc.text('src/a.py', 'Rohan')).toBeUndefined()
  expect(daemon.retainedDeclared()).toEqual([])
})

it.each(['commit', 'revert'])('room_done omits a hot file after %s just before completion', async action => {
  const { dir, daemon, tools, scope } = await setup()
  await scope('src/b.py')
  for (let n = 0; n < 6; n++) {
    writeFileSync(join(dir, 'src', 'b.py'), `edited ${n}\n`)
    await daemon.publishCurrent()
  }
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

it('retries when HEAD moves during the flush', async () => {
  let moved = false
  let armed = false
  let dir = ''
  const t = await setup(async path => {
    if (path !== 'src/a.py' || moved || !armed) return
    moved = true
    git(dir, 'add', 'src/b.py')
    git(dir, 'commit', '-q', '-m', 'move HEAD')
  })
  dir = t.dir
  await t.scope('src/a.py')
  writeFileSync(join(dir, 'src', 'a.py'), 'edited\n')
  writeFileSync(join(dir, 'src', 'b.py'), 'committed\n')
  armed = true
  expect(t.daemon.retainedDeclared()).toEqual([])
  const done = await t.tools.call('room_done', { summary: 'edited a' })
  expect(moved).toBe(true)
  expect(done).toContain('stay shared')
  expect(t.daemon.retainedDeclared()).toEqual(['src/a.py'])
  expect(t.daemon.roomDoc.text('src/a.py', 'Rohan')).toBe('edited\n')
})

it('keeps scope and claims when Git fails during done', async () => {
  const { dir, daemon, tools, scope } = await setup()
  await scope('src/a.py')
  const claim = daemon.roomDoc.addClaim({ path: 'src/a.py', from: 1, to: 1, by: 'Rohan', byKind: 'agent', intent: 'edit' })
  writeFileSync(join(dir, 'src', 'a.py'), 'edited\n')
  const gitDir = join(dir, '.git')
  const hidden = join(dir, '.git-hidden')
  renameSync(gitDir, hidden)
  let done: string
  try { done = await tools.call('room_done', { summary: 'edited a' }) }
  finally { renameSync(hidden, gitDir) }
  expect(done!).toContain("Room couldn't confirm your latest changes were shared")
  expect(done!).toContain('Your scope and claims are kept; try done again.')
  expect(daemon.roomDoc.scope('Rohan')).toBeDefined()
  expect(daemon.roomDoc.claims.get(claim.id)).toBeDefined()
  expect(daemon.retainedDeclared()).toEqual([])
})
