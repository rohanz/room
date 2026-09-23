import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc, type Worker } from '@room/shared'
import { handlers } from '../src/tools/collect.js'
import type { HandlerState } from '../src/tools/context.js'
import { prepareWorktree, persistWorkerStopReason } from '../src/workers.js'
import { finishWorkerProcess, Rooms } from '../src/registry.js'
import type { Session } from '../src/session.js'

vi.mock('../src/tools/claims.js', async original => ({ ...await original<typeof import('../src/tools/claims.js')>(), releaseClaimsOnDone: vi.fn() }))

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
const put = (dir: string, rel: string, content: string) => { const file = path.join(dir, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8')
const temp: string[] = []
afterEach(() => { for (const dir of temp.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

function collect(room: RoomDoc, dir: string, name: string, workerAlive: (w: Worker) => boolean = () => false) {
  const s = { dir, me: { name, kind: 'agent' }, room, local: {}, roomName: 'local/shop', awareness: { getStates: () => new Map() } }
  const state = {
    S: () => s, rooms: { all: () => [s], holding: () => s, holdingWorker: () => s, reserve: () => true, unreserve() {}, retireWorkers: async () => {}, handle: () => undefined },
    workerAlive: (_s: Session, w: Worker) => workerAlive(w), now: Date.now, ctx: { sleep: async () => {} },
  } as unknown as HandlerState
  return handlers(state).room_collect
}

async function batch() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-collect-guard-'))); temp.push(root)
  git(root, 'init', '-q', '-b', 'shop'); git(root, 'config', 'user.name', 'Human'); git(root, 'config', 'user.email', 'human@example.test')
  put(root, '.gitignore', '.room/\n'); put(root, 'lead.txt', 'base lead\n'); put(root, 'cat.txt', 'base cat\n')
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'base')
  const lead = await prepareWorktree(root, 'lead', 'rohanz', [], 'local/shop|rohanz')
  const cat = await prepareWorktree(lead.dir, 'cat', 'rohanz+lead', [], 'local/shop|rohanz+lead')
  put(lead.dir, 'lead.txt', 'partial lead\n')
  put(cat.dir, 'cat.txt', 'finished cat\n')
  const room = new RoomDoc(new Y.Doc())
  room.setMeta({ base: git(root, 'rev-parse', 'HEAD'), branch: 'shop', repo: 'shop' })
  const worker = (tag: string, owner: string, prepared: typeof lead): Worker => ({
    id: `${owner}/${tag}#1`, tag, name: `rohanz+${tag}`, lead: owner, host: 'codex', task: tag,
    dir: prepared.dir, branch: prepared.branch, base: prepared.base, pid: -1, startedAt: 1,
    status: 'done', finishedAt: 2, exitCode: 0,
  })
  const leadWorker = worker('lead', 'rohanz', lead)
  const catWorker = worker('cat', 'rohanz+lead', cat)
  room.setWorker(leadWorker); room.setWorker(catWorker)
  return { root, lead, cat, room, leadWorker, catWorker }
}

it('keeps a live lead-worker responsible for its finished grand-worker, including tagged apply, copy, and discard', async () => {
  const { root, cat, room, leadWorker } = await batch()
  leadWorker.status = 'running'; room.setWorker(leadWorker)
  const humanCollect = collect(room, root, 'rohanz', w => w.tag === 'lead')
  const all = await humanCollect({})
  expect(all).not.toContain('Changes from cat:')
  expect(read(root, 'cat.txt')).toBe('base cat\n')
  expect(read(root, 'lead.txt')).toBe('base lead\n')
  for (const args of [
    { tag: 'cat' },
    { tag: 'cat', mode: 'copy', paths: ['cat.txt'] },
    { tag: 'cat', discard: true },
  ]) {
    const out = await humanCollect(args)
    expect(out).toContain('cat belongs to rohanz+lead, which is still running')
    expect(out).toContain('ask it with room_send, or discard rohanz+lead\'s worker first')
  }
  expect(read(root, 'cat.txt')).toBe('base cat\n')
  expect(room.workers.has('cat')).toBe(true)
  expect(fs.existsSync(cat.dir)).toBe(true)
})

it('lets the human collect an orphaned grand-worker after the intermediate lead process exits', async () => {
  const { root, room, leadWorker } = await batch()
  leadWorker.status = 'running'; room.setWorker(leadWorker)
  const out = await collect(room, root, 'rohanz')({ tag: 'cat' })
  expect(out).toContain('Changes from cat:')
  expect(read(root, 'cat.txt')).toBe('finished cat\n')
})

it('uses the lead-worker PID when its process handle is unavailable', async () => {
  const { root, room, leadWorker } = await batch()
  leadWorker.status = 'running'
  leadWorker.pid = process.pid
  room.setWorker(leadWorker)
  const humanCollect = collect(room, root, 'rohanz')
  expect(await humanCollect({})).not.toContain('Changes from cat:')
  expect(await humanCollect({ tag: 'cat' })).toContain('cat belongs to rohanz+lead, which is still running')
  expect(read(root, 'cat.txt')).toBe('base cat\n')
})

it.each(['running', 'dismissed'] as const)('skips a %s worker stopped mid-task in collect-all, but accepts an explicit tag', async status => {
  const { root, room, leadWorker } = await batch()
  leadWorker.status = status
  leadWorker.stopReason = 'lead-session-ended'
  delete leadWorker.finishedAt
  delete leadWorker.exitCode
  room.setWorker(leadWorker)
  const humanCollect = collect(room, root, 'rohanz')
  const all = await humanCollect({})
  expect(all).toContain('skipped lead: stopped before finishing')
  expect(all).toContain('the lead\'s session ended')
  expect(all).toContain('room_collect tag=lead')
  expect(all).toContain('mode=copy')
  expect(all).toContain('discard=true')
  expect(all).toContain('Changes from cat:')
  expect(read(root, 'cat.txt')).toBe('finished cat\n')
  expect(read(root, 'lead.txt')).toBe('base lead\n')
  expect(room.workers.has('lead')).toBe(true)
  const named = await humanCollect({ tag: 'lead' })
  expect(named).toContain('Changes from lead:')
  expect(read(root, 'lead.txt')).toBe('partial lead\n')
})

it('copies named partial edits from a stopped worker when explicitly tagged', async () => {
  const { root, room, leadWorker } = await batch()
  room.workers.delete('cat')
  leadWorker.status = 'dismissed'
  leadWorker.stopReason = 'lead-session-ended'
  room.setWorker(leadWorker)
  const out = await collect(room, root, 'rohanz')({ tag: 'lead', mode: 'copy', paths: ['lead.txt'] })
  expect(out).toContain('copied lead.txt')
  expect(read(root, 'lead.txt')).toBe('partial lead\n')
  expect(room.workers.has('lead')).toBe(true)
})

it('collects grand-worker edits through a lead once while preserving the human carry bytes and clearing both levels', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-nested-collect-'))); temp.push(root)
  const top = path.join(root, 'top'); fs.mkdirSync(top)
  git(top, 'init', '-q', '-b', 'shop'); git(top, 'config', 'user.name', 'Human'); git(top, 'config', 'user.email', 'human@example.test')
  put(top, '.gitignore', '.room/\n'); put(top, 'README.md', 'shop\n'); put(top, 'tax.py', 'RATES = {}\n'); put(top, 'catalog.py', 'def price():\n    return 1\n')
  git(top, 'add', '.'); git(top, 'commit', '-qm', 'base')
  const humanTracked = 'shop\nHuman WIP: café ☕\n', humanUntracked = 'human untracked\n\0bytes\n'
  put(top, 'README.md', humanTracked); put(top, 'notes.txt', humanUntracked)
  const lead = await prepareWorktree(top, 'lead', 'rohanz', [], 'local/shop|rohanz')
  put(lead.dir, 'tax.py', 'RATES = {"sg": 9}\n')
  const cat = await prepareWorktree(lead.dir, 'cat', 'rohanz+lead', [], 'local/shop|rohanz+lead')
  put(cat.dir, 'catalog.py', 'def price():\n    """Return the product price."""\n    return 1\n')
  put(cat.dir, 'README.md', humanTracked + 'Cat adds a usage note.\n')
  const room = new RoomDoc(new Y.Doc())
  room.setMeta({ base: git(top, 'rev-parse', 'HEAD'), branch: 'shop', repo: 'shop' })
  const mk = (tag: string, owner: string, prepared: typeof lead): Worker => ({
    id: `${owner}/${tag}#1`, tag, name: `rohanz+${tag}`, lead: owner, host: 'codex', task: tag,
    dir: prepared.dir, branch: prepared.branch, base: prepared.base, carriedUntracked: prepared.carriedUntracked,
    pid: -1, startedAt: 1, finishedAt: 2, exitCode: 0, status: 'done',
  })
  room.setWorker(mk('lead', 'rohanz', lead)); room.setWorker(mk('cat', 'rohanz+lead', cat))
  const childResult = await collect(room, lead.dir, 'rohanz+lead')({ tag: 'cat' })
  expect(childResult).toContain('Changes from cat:')
  expect(read(lead.dir, 'catalog.py')).toContain('Return the product price.')
  expect(read(lead.dir, 'README.md')).toBe(humanTracked + 'Cat adds a usage note.\n')
  put(lead.dir, '.room/discarded/older-child.patch', 'recover an earlier child\n')
  const leadResult = await collect(room, top, 'rohanz')({ tag: 'lead' })
  expect(leadResult).toContain('Changes from lead:')
  expect(read(top, 'README.md')).toBe(humanTracked + 'Cat adds a usage note.\n')
  expect(read(top, 'notes.txt')).toBe(humanUntracked)
  expect(read(top, 'tax.py')).toBe('RATES = {"sg": 9}\n')
  expect(read(top, 'catalog.py')).toContain('Return the product price.')
  expect(read(top, '.room/discarded/older-child.patch')).toBe('recover an earlier child\n')
  expect(room.workers.size).toBe(0)
  expect(git(top, 'worktree', 'list', '--porcelain')).not.toContain('room/workers')
  for (const tag of ['lead', 'cat']) {
    expect(git(top, 'branch', '--list', `room/${tag}`)).toBe('')
    expect(git(top, 'for-each-ref', '--format=%(refname)', `refs/room/carry/${tag}`, `refs/room/carry-untracked/${tag}`)).toBe('')
    expect(fs.existsSync(path.join(top, '.git', 'room-carry', `${tag}.json`))).toBe(false)
  }
})

it('recovers the intentional shutdown reason for both worker levels after the relay disappears', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-stop-reason-'))); temp.push(root)
  git(root, 'init', '-q', '-b', 'shop'); git(root, 'config', 'user.name', 'Human'); git(root, 'config', 'user.email', 'human@example.test')
  put(root, '.gitignore', '.room/\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'base')
  const lead = await prepareWorktree(root, 'lead', 'rohanz')
  const cat = await prepareWorktree(lead.dir, 'cat', 'rohanz+lead')
  persistWorkerStopReason(root, 'lead', 'lead-session-ended')
  persistWorkerStopReason(lead.dir, 'cat', 'lead-session-ended')
  const room = new RoomDoc(new Y.Doc())
  for (const [tag, owner, prepared] of [['lead', 'rohanz', lead], ['cat', 'rohanz+lead', cat]] as const) {
    const worker = { id: `${owner}/${tag}#1`, tag, name: `rohanz+${tag}`, lead: owner, host: 'codex', task: tag, dir: prepared.dir, branch: prepared.branch, pid: -1, startedAt: 1, status: 'running' } as Worker
    room.setWorker(worker)
    await finishWorkerProcess({ dir: tag === 'lead' ? root : lead.dir, room } as Session, worker, null, Date.now(), undefined, true)
    expect(room.workers.get(tag)).toMatchObject({ status: 'dismissed', stopReason: 'lead-session-ended' })
    expect(room.workers.get(tag)?.summary).toContain('lead-session-ended')
    const fresh = new RoomDoc(new Y.Doc())
    fresh.setWorker(worker)
    const session = { dir: tag === 'lead' ? root : lead.dir, room: fresh } as Session
    const registry = new Rooms({ primary: () => session, setPrimary: () => {}, observeClaims: () => {}, attach: () => ({ stop() {} }) })
    registry.track(session)
    expect(fresh.workers.get(tag)).toMatchObject({ status: 'dismissed', stopReason: 'lead-session-ended' })
    registry.remove(session)
  }
})

it('force discard saves a grand-worker patch and removes both levels of Git bookkeeping', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-nested-discard-'))); temp.push(root)
  git(root, 'init', '-q', '-b', 'shop'); git(root, 'config', 'user.name', 'Human'); git(root, 'config', 'user.email', 'human@example.test')
  put(root, '.gitignore', '.room/\n'); put(root, 'catalog.py', 'base\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'base')
  const lead = await prepareWorktree(root, 'lead', 'rohanz', [], 'local/shop|rohanz')
  const cat = await prepareWorktree(lead.dir, 'cat', 'rohanz+lead', [], 'local/shop|rohanz+lead')
  put(cat.dir, 'catalog.py', 'grand-worker output\n')
  const room = new RoomDoc(new Y.Doc())
  for (const [tag, owner, prepared] of [['lead', 'rohanz', lead], ['cat', 'rohanz+lead', cat]] as const) {
    room.setWorker({ id: `${owner}/${tag}#1`, tag, name: `rohanz+${tag}`, lead: owner, host: 'codex', task: tag, dir: prepared.dir, branch: prepared.branch, base: prepared.base, pid: -1, startedAt: 1, status: 'running' })
  }
  const result = await collect(room, root, 'rohanz')({ tag: 'lead', discard: true, force: true })
  expect(result).toContain('discarded cat')
  expect(result).toContain('discarded lead')
  const patches = fs.readdirSync(path.join(root, '.room', 'discarded')).map(name => read(root, '.room/discarded/' + name))
  expect(patches.some(patch => patch.includes('grand-worker output'))).toBe(true)
  expect(room.workers.size).toBe(0)
  expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain('prunable')
  expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain('room/workers')
  for (const tag of ['lead', 'cat']) {
    expect(git(root, 'branch', '--list', `room/${tag}`)).toBe('')
    expect(git(root, 'for-each-ref', '--format=%(refname)', `refs/room/carry/${tag}`, `refs/room/carry-untracked/${tag}`)).toBe('')
    expect(fs.existsSync(path.join(root, '.git', 'room-carry', `${tag}.json`))).toBe(false)
  }
})
