import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { handlers } from '../src/tools/collect.js'
import { handlers as fileHandlers } from '../src/tools/files.js'
import type { HandlerState } from '../src/tools/context.js'
import { RoomDoc } from '@room/shared'
import * as Y from 'yjs'

vi.mock('../src/tools/claims.js', () => ({ releaseClaimsOnDone: vi.fn() }))
let root: string, lead: string, worker: string, base: string
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
const put = (dir: string, p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text) }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-lead-only-'))
  lead = path.join(root, 'lead'); worker = path.join(root, 'worker'); fs.mkdirSync(lead)
  git(lead, 'init', '-q'); git(lead, 'config', 'user.name', 'Lead'); git(lead, 'config', 'user.email', 'lead@example.test')
  put(lead, 'file.txt', 'base\n')
  git(lead, 'add', '.'); git(lead, 'commit', '-qm', 'base'); base = git(lead, 'rev-parse', 'HEAD')
  git(lead, 'worktree', 'add', '-qb', 'room/test', worker)
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

function setup() {
  const w = { tag: 'test', name: 'lead+test', lead: 'lead', dir: worker, branch: 'room/test', status: 'done', exitCode: 0, summary: 'finished', base, host: 'codex', task: 'task', startedAt: 1 }
  const room = new RoomDoc(new Y.Doc())
  room.setMeta({ base, branch: 'main', repo: 'test' })
  room.workers.set('test', w as never)
  const s = { dir: lead, local: {}, me: { name: 'lead', kind: 'agent' }, room, awareness: { getStates: () => new Map() } }
  const state = {
    S: () => s, rooms: { all: () => [s], holding: () => s, holdingWorker: () => s, reserve: () => true, unreserve() {}, retireWorkers: vi.fn(async () => {}) }, workerAlive: () => false,
    others: () => ['lead+test'], presences: () => [], withheld: () => undefined, baseFor: () => base, shareOf: () => 'full', liveText: async () => undefined,
  } as unknown as HandlerState
  return { state }
}

/** The website repo: 13 GB of untracked art in the lead's clone that no worker touches. */
function leadArt(): string[] {
  const files = ['art/scene.blend', 'art/renders/a.exr', 'notes/draft.md']
  for (const p of files) put(lead, p, `lead-only ${p}\n`)
  return files.map(p => path.join(lead, p))
}
const readsOf = (reader: { mock: { calls: unknown[][] } }, files: string[]) => reader.mock.calls.map(([p]) => String(p)).filter(p => files.some(f => p === f || p.endsWith(path.relative(lead, f)) && p.startsWith(fs.realpathSync(lead))))

it('room_preview_merge does not read files only the lead changed', async () => {
  const art = leadArt()
  put(worker, 'new.txt', 'worker change\n')
  const t = setup()
  const reader = vi.spyOn(fs, 'readFileSync')
  const result = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test' })
  expect(result).toContain('new.txt (lead+test only)')
  expect(result).toContain('no conflicts')
  expect(readsOf(reader, art)).toEqual([])
})

it('room_preview_merge still reports a conflict on a file both changed', async () => {
  put(lead, 'file.txt', 'lead\n')
  put(worker, 'file.txt', 'worker\n')
  const t = setup()
  const result = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test' })
  expect(result).toContain('CONFLICTS')
  expect(result).toContain('file.txt')
})

it('credits identical edits to both participants', async () => {
  put(lead, 'file.txt', 'same change\n')
  put(worker, 'file.txt', 'same change\n')
  const t = setup()
  const result = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test' })
  expect(result).toContain('lead and lead+test made the same change: file.txt')
  expect(result).not.toContain('only lead+test changed this file')
})

it('runs a team preview from a shared worker overlay even when its local directory exists', async () => {
  const t = setup()
  const s = t.state.S()
  s.local = undefined
  s.room.setOverlay('lead+test', 'new.txt', 'shared change\n')
  t.state.liveText = async (_session, file, person) => s.room.text(file, person)
  const result = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test', run: 'cat new.txt' })
  expect(result).toContain('shared change')
  expect(result).toContain('exit 0')
})

it('room_collect does not read files only the lead changed and leaves them untouched', async () => {
  const art = leadArt()
  put(worker, 'new.txt', 'worker change\n')
  const t = setup()
  const reader = vi.spyOn(fs, 'readFileSync')
  const result = await handlers(t.state).room_collect({ tag: 'test' })
  expect(result).toContain('Changes from test: new.txt')
  expect(readsOf(reader, art)).toEqual([])
  reader.mockRestore()
  expect(fs.readFileSync(path.join(lead, 'new.txt'), 'utf8')).toBe('worker change\n')
  expect(fs.readFileSync(path.join(lead, 'art/scene.blend'), 'utf8')).toBe('lead-only art/scene.blend\n')
})
