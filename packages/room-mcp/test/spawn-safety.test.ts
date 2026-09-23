import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import { createTools } from '../src/tools.js'
import { GraphIndex } from '../src/graph-index.js'
import type { Session } from '../src/session.js'

let root: string, repo: string, head: string
const shutdowns: (() => Promise<void>)[] = []
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-spawn-safety-'))
  repo = path.join(root, 'lead'); fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Lead'); git('config', 'user.email', 'lead@example.test')
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base'); head = git('rev-parse', 'HEAD')
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.room/\n')
})
afterEach(async () => {
  for (const stop of shutdowns.splice(0)) await stop().catch(() => {})
  fs.rmSync(root, { recursive: true, force: true })
})

function tool(roomName = 'local/a/main', spawner: (spec: { env: Record<string, string> }) => any = () => ({ pid: 4000000, onExit() {}, kill: () => true })) {
  const room = new RoomDoc()
  room.setMeta({ repo: 'a', branch: 'main', base: head })
  const me = { name: 'lead', kind: 'agent' as const, owner: 'lead' }
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
  const graph = new GraphIndex(room, me.name, repo); graph.start()
  let session: Session | null = {
    graph, room, awareness, me, dir: repo, roomName, roomUrl: `ws://127.0.0.1:1/${encodeURIComponent(roomName)}`, browserUrl: 'http://x',
    provider: { synced: true, awareness } as Session['provider'],
    daemon: { share: 'full', touch() {}, async stop() {}, dir: repo, name: me.name, roomDoc: room, provider: null, branch: 'main', base: head } as never,
    shareMax: 'full', shareRequested: 'full', local: { url: 'ws://127.0.0.1:1', port: 1, owned: true, async stop() {} },
  } as Session
  const tools = createTools({ getSession: () => session, setSession: value => { session = value }, cwd: repo, probe: () => undefined, spawner })
  shutdowns.push(async () => { await tools.shutdown(); graph.stop(); room.doc.destroy() })
  return { room, call: (args: Record<string, unknown>) => tools.call('room_spawn', { tag: 'w', task: 'test task', ...args }) as Promise<string> }
}

it('validates untracked link inputs before carrying and leaves them as links', async () => {
  fs.mkdirSync(path.join(repo, 'data'))
  fs.writeFileSync(path.join(repo, 'data', 'input.bin'), 'lead input')
  fs.writeFileSync(path.join(repo, '.roomlinks'), 'data\n')
  const t = tool()
  const reply = await t.call({})
  expect(reply).toContain('spawned w:')
  const worker = t.room.workers.get('w')!
  expect(fs.lstatSync(path.join(worker.dir, 'data')).isSymbolicLink()).toBe(true)
  expect(worker.link).toEqual(['data'])
})

it('rejects an invalid link before creating a worktree', async () => {
  fs.writeFileSync(path.join(repo, '.roomlinks'), '../outside\n')
  const t = tool()
  expect(await t.call({})).toContain('invalid link path')
  expect(fs.existsSync(path.join(repo, '.room', 'workers', 'w'))).toBe(false)
  expect(git('branch', '--list', 'room/w')).toBe('')
})

it('removes a newly carried worktree and branch when the process cannot start', async () => {
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'lead WIP\n')
  const t = tool('local/a/main', () => { throw new Error('simulated start failure') })
  expect(await t.call({})).toContain('simulated start failure')
  expect(fs.existsSync(path.join(repo, '.room', 'workers', 'w'))).toBe(false)
  expect(git('branch', '--list', 'room/w')).toBe('')
  expect(t.room.workers.has('w')).toBe(false)
})

it('reports the number of files actually carried from an untracked directory', async () => {
  fs.mkdirSync(path.join(repo, 'newpkg'))
  for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(repo, 'newpkg', `file${i}.txt`), String(i))
  const reply = await tool().call({})
  expect(reply).toContain('carried your 7 uncommitted changes')
})

it('reports each spawn’s own carried file count', async () => {
  const t = tool()
  fs.writeFileSync(path.join(repo, 'first.txt'), 'one')
  expect(await t.call({ tag: 'one' })).toContain('carried your 1 uncommitted change')
  fs.writeFileSync(path.join(repo, 'second.txt'), 'two')
  expect(await t.call({ tag: 'two' })).toContain('carried your 2 uncommitted changes')
})

it('names a file excluded by the carry budget in the spawn reply', async () => {
  fs.writeFileSync(path.join(repo, 'huge.bin'), Buffer.alloc(6 * 1024 * 1024))
  const reply = await tool().call({})
  expect(reply).toContain('huge.bin (size budget)')
})

it('refuses a second room that targets an occupied worktree tag', async () => {
  const first = tool('local/a/main')
  expect(await first.call({})).toContain('spawned w:')
  const second = tool('local/b/main')
  expect(await second.call({})).toMatch(/error:.*(?:owned|occupied|in use|another room)/i)
  expect(second.room.workers.has('w')).toBe(false)
})

it('respawns the same lead into a kept worktree and recovers its carry record', async () => {
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'lead WIP\n')
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked WIP\n')
  const t = tool('local/a/main')
  expect(await t.call({})).toContain('spawned w:')
  const first = t.room.workers.get('w')!
  expect(first.carriedUntracked?.map(f => f.path)).toContain('untracked.txt')
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'ignored-output.txt\n')
  fs.writeFileSync(path.join(first.dir, 'ignored-output.txt'), 'retained worker output')
  t.room.updateWorker('w', { status: 'done', finishedAt: Date.now() })
  t.room.retireParticipant(first.name, {
    name: first.name, tag: first.tag, lead: first.lead, host: first.host, task: first.task,
    summary: 'kept output', files: [], fileCount: 0, startedAt: first.startedAt,
    finishedAt: Date.now(), retiredAt: Date.now(), outcome: 'dismissed',
  })
  expect(t.room.workers.has('w')).toBe(false)
  expect(await t.call({})).toContain('spawned w:')
  const second = t.room.workers.get('w')!
  expect(second.gen).toBeGreaterThan(first.gen!)
  expect(second).toMatchObject({ dir: first.dir, base: first.base, carriedUntracked: first.carriedUntracked })
  expect(fs.readFileSync(path.join(second.dir, 'ignored-output.txt'), 'utf8')).toBe('retained worker output')
  const otherRoom = tool('local/b/main')
  expect(await otherRoom.call({})).toMatch(/error:.*(?:owned|another room)/i)
})
