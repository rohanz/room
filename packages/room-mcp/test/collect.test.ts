import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handlers } from '../src/tools/collect.js'
import { handlers as fileHandlers } from '../src/tools/files.js'
import type { HandlerState } from '../src/tools/context.js'
import { RoomDoc } from '@room/shared'
import * as Y from 'yjs'
import { workerGitFacts, shouldRetire, workerOwnedPaths } from '../src/workers.js'

const release = vi.hoisted(() => vi.fn())
vi.mock('../src/tools/claims.js', () => ({ releaseClaimsOnDone: release }))
let root: string, lead: string, worker: string, base: string
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
const put = (dir: string, p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text) }

beforeEach(() => {
  release.mockReset()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-collect-'))
  lead = path.join(root, 'lead'); worker = path.join(root, 'worker'); fs.mkdirSync(lead)
  git(lead, 'init', '-q'); git(lead, 'config', 'user.name', 'Lead'); git(lead, 'config', 'user.email', 'lead@example.test')
  put(lead, 'file.txt', 'base\n'); put(lead, '.gitignore', 'artifact.bin\n')
  git(lead, 'add', '.'); git(lead, 'commit', '-qm', 'base'); base = git(lead, 'rev-parse', 'HEAD')
  git(lead, 'worktree', 'add', '-qb', 'room/test', worker)
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function setup(status = 'done') {
  const w = { tag: 'test', name: 'lead+test', lead: 'lead', dir: worker, branch: 'room/test', status, summary: 'finished\nextra', base }
  const room = new RoomDoc(new Y.Doc())
  room.setMeta({ base, branch: 'main', repo: 'test' })
  room.workers.set('test', w as never)
  const s = { dir: lead, local: {}, me: { name: 'lead', kind: 'agent' }, room, awareness: { getStates: () => new Map() } }
  const retireWorkers = vi.fn(async () => {})
  const state = { S: () => s, rooms: { holdingWorker: () => s, reserve: () => true, unreserve() {}, retireWorkers }, workerAlive: () => false } as unknown as HandlerState
  return { call: handlers(state).room_collect, retireWorkers, state, s, w }
}

describe('room_collect', () => {
  it('waits for a done worker to exit without requiring force', async () => {
    const t = setup()
    let at = 0
    const sleep = vi.fn(async (ms: number) => { at += ms })
    t.state.now = () => at
    t.state.ctx = { sleep } as HandlerState['ctx']
    t.state.workerAlive = () => at < 10_000
    put(worker, 'new.txt', 'new')
    expect(await t.call({ tag: 'test' })).toContain('merged room/test')
    expect(sleep).toHaveBeenCalledTimes(40)
    expect(sleep).toHaveBeenCalledWith(250)
  })
  it('bounds the exit wait at 15 seconds and allows an explicit force override', async () => {
    const t = setup()
    let at = 0
    t.state.now = () => at
    t.state.ctx = { sleep: async (ms: number) => { at += ms } } as HandlerState['ctx']
    t.state.workerAlive = () => true
    expect(await t.call({ tag: 'test' })).toContain('reported done but its process has not exited after 15 s; force=true overrides')
    expect(at).toBe(15_000)
    expect(git(worker, 'rev-parse', 'HEAD')).toBe(base)
    expect(await t.call({ tag: 'test', force: true })).toContain('merged room/test')
    expect(at).toBe(15_000)
  })
  it('collects and retires merged work despite an untracked linked input', async () => {
    put(lead, '.gitignore', 'artifact.bin\ndata/\n')
    git(lead, 'commit', '-qam', 'ignore data'); git(worker, 'merge', '--ff-only', git(lead, 'rev-parse', 'HEAD'))
    put(worker, '.gitignore', 'artifact.bin\ndata/\n')
    put(lead, 'data/input', 'private input')
    fs.symlinkSync(path.join(lead, 'data'), path.join(worker, 'data'))
    put(worker, 'new.txt', 'output')
    const t = setup()
    const w = { ...t.s.room.workers.get('test')!, link: ['data'] }
    t.s.room.workers.set('test', w)
    expect(git(worker, 'status', '--porcelain', '--untracked-files=all')).toContain('?? data')
    expect(await t.call({ tag: 'test' })).toContain('merged room/test')
    expect(git(worker, 'ls-files', 'data')).toBe('')
    const facts = await workerGitFacts(lead, w)
    expect(facts).toMatchObject({ clean: true, merged: true, ahead: 0, uncommitted: 0 })
    expect(shouldRetire({ ...facts, exited: true, done: true, dismissed: false })).toBe('merged')
    expect(workerOwnedPaths(w).includes('data/input')).toBe(true)
    expect(workerOwnedPaths(w).includes('database')).toBe(false)
    put(worker, 'database', 'real output')
    expect(await workerGitFacts(lead, w)).toMatchObject({ clean: false, uncommitted: 1 })
  })
  it('commits tracked and untracked output as the lead, excludes ignored artifacts, then merges', async () => {
    put(worker, 'file.txt', 'worker\n'); put(worker, 'new.txt', 'new\n'); put(worker, 'artifact.bin', 'ignored')
    const t = setup()
    release.mockImplementation(() => expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('base\n'))
    const result = await t.call({ tag: 'test' })
    expect(result).toContain('committed '); expect(result).toContain('merged room/test')
    expect(git(worker, 'log', '-1', '--format=%s')).toBe('room: collect test: finished')
    expect(git(worker, 'log', '-1', '--format=%an <%ae>')).toBe('Lead <lead@example.test>')
    expect(fs.existsSync(path.join(lead, 'new.txt'))).toBe(true)
    expect(fs.existsSync(path.join(lead, 'artifact.bin'))).toBe(false)
    expect(release.mock.calls[0][1]({ path: 'file.txt', from: 1, to: 1 })).toBe(false)
    expect(release.mock.calls[0][1]({ path: 'unrelated.txt', from: 1, to: 1 })).toBe(true)
    expect(release.mock.calls[0].slice(2)).toEqual(['lead+test', false])
    expect(t.retireWorkers).toHaveBeenCalledOnce()
  })
  it('aborts conflicts and retains the worker commit, leaving the lead clean', async () => {
    put(lead, 'file.txt', 'lead\n'); git(lead, 'add', '.'); git(lead, 'commit', '-qm', 'lead')
    put(worker, 'file.txt', 'worker\n')
    const result = await setup().call({ tag: 'test' })
    expect(result).toContain('committed '); expect(result).toContain('merge aborted; conflicting files: file.txt')
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('lead\n')
    expect(git(lead, 'status', '--porcelain')).toBe('')
  })
  it('copies ignored and nested artifacts byte-for-byte, without committing', async () => {
    put(worker, 'artifact.bin', 'a\0b'); put(worker, 'out/nested.txt', 'nested')
    const t = setup(), before = git(lead, 'rev-parse', 'HEAD')
    expect(await t.call({ tag: 'test', mode: 'copy', paths: ['artifact.bin', 'out'] })).toBe('copied artifact.bin\ncopied out/nested.txt')
    expect(fs.readFileSync(path.join(lead, 'artifact.bin'))).toEqual(fs.readFileSync(path.join(worker, 'artifact.bin')))
    expect(git(lead, 'rev-parse', 'HEAD')).toBe(before)
    expect(t.retireWorkers).toHaveBeenCalledOnce()
  })
  it('preflights the whole copy before releasing or writing, and requires force for modified destinations', async () => {
    put(worker, 'a.txt', 'a'); put(worker, 'file.txt', 'worker'); put(lead, 'file.txt', 'lead')
    const t = setup()
    expect(await t.call({ tag: 'test', mode: 'copy', paths: ['a.txt', 'file.txt'] })).toContain('lead has modified file.txt')
    expect(fs.existsSync(path.join(lead, 'a.txt'))).toBe(false); expect(release).not.toHaveBeenCalled()
    expect(await t.call({ tag: 'test', mode: 'copy', paths: ['file.txt'], force: true })).toBe('copied file.txt')
  })
  it('guards running workers and invalid modes', async () => {
    const t = setup('running')
    expect(await t.call({ tag: 'test' })).toContain('still running')
    expect(await t.call({ tag: 'test', mode: 'bad' })).toContain('mode must be')
    expect(await t.call({ tag: 'test', force: true })).toContain('merged room/test')
  })
  it('rejects traversal, Git metadata, source and destination symlinks even with force', async () => {
    put(worker, 'out/value', 'value'); fs.symlinkSync(root, path.join(worker, 'escape'))
    fs.symlinkSync(root, path.join(lead, 'out'))
    const t = setup()
    for (const p of ['../escape', '.git/config', 'escape/lead/file.txt', 'out/value']) {
      expect(await t.call({ tag: 'test', mode: 'copy', paths: [p], force: true })).toMatch(/unsafe|symlink/)
    }
    expect(release).not.toHaveBeenCalled()
  })
  it('refuses dirty lead tracked files without committing worker output', async () => {
    put(lead, 'file.txt', 'lead'); put(worker, 'new.txt', 'new')
    expect(await setup().call({ tag: 'test' })).toContain('commit or stash')
    expect(git(worker, 'rev-parse', 'HEAD')).toBe(base)
  })
})

describe('worker preview', () => {
  it.each([true, false])('skips linked and escaping symlinks from both sides (record=%s)', async recorded => {
    put(lead, 'data/input', 'private input')
    put(worker, '.gitignore', 'artifact.bin\ndata/\n')
    fs.symlinkSync(path.join(lead, 'data'), path.join(worker, 'data'))
    put(worker, 'new.txt', 'output')
    const t = setup()
    if (recorded) t.s.room.workers.set('test', { ...t.s.room.workers.get('test')!, link: ['data'] })
    const ws = { ...t.s, dir: worker, me: { name: 'lead+test', kind: 'agent' } }
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [], withheld: () => undefined,
      baseFor: () => base, shareOf: () => 'full', liveText: async () => undefined,
    })
    const reason = recorded ? 'linked input' : 'symlink leaving the worktree'
    const leadResult = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test' })
    expect(leadResult).toContain(`NOT previewed (${reason}, lead+test): data`)
    expect(leadResult).toContain('new.txt (lead+test only)')
    t.state.S = () => ws as unknown as ReturnType<HandlerState['S']>
    const workerResult = await fileHandlers(t.state).room_preview_merge({ person: 'lead' })
    expect(workerResult).toContain(`NOT previewed (${reason}, lead+test): data`)
    expect(workerResult).toContain('no conflicts')
  })
  it('discovers untracked worker paths and explicitly excludes ignored output', async () => {
    put(worker, 'new.txt', 'new\n'); put(worker, 'empty.txt', ''); put(worker, 'artifact.bin', 'artifact')
    const nested = path.join(lead, 'nested'); fs.mkdirSync(nested); git(nested, 'init', '-q')
    const t = setup()
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [], withheld: () => undefined,
      baseFor: () => base, shareOf: () => 'full',
      liveText: async (_s: unknown, p: string, person: string) => {
        try { return fs.readFileSync(path.join(person === 'lead' ? lead : worker, p), 'utf8') }
        catch { return undefined }
      },
    })
    const result = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test', run: 'cat new.txt' })
    expect(result).toContain('new.txt (lead+test only)')
    expect(result).toContain('NOT previewed (gitignored, lead+test): artifact.bin')
    expect(result).toContain('empty.txt (lead+test only)')
    expect(result).toContain('NOT previewed (directory or nested repository): nested/')
    expect(result).toContain('exit 0')
  })
})
