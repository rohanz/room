import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handlers } from '../src/tools/collect.js'
import { handlers as fileHandlers, linkSharedDirs, materializeMergedFile } from '../src/tools/files.js'
import type { HandlerState } from '../src/tools/context.js'
import { signalWorker, pidAlive } from '../src/workers.js'
import { RoomDoc } from '@room/shared'
import * as Y from 'yjs'

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
  put(lead, 'file.txt', 'base\n'); put(lead, '.gitignore', 'artifact.bin\nnode_modules/\n')
  git(lead, 'add', '.'); git(lead, 'commit', '-qm', 'base'); base = git(lead, 'rev-parse', 'HEAD')
  git(lead, 'worktree', 'add', '-qb', 'room/test', worker)
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function setup(status = 'done') {
  const w = { tag: 'test', name: 'lead+test', lead: 'lead', dir: worker, branch: 'room/test', status, summary: 'finished\nextra', base, host: 'codex', task: 'task', startedAt: 1 }
  const room = new RoomDoc(new Y.Doc())
  room.setMeta({ base, branch: 'main', repo: 'test' })
  room.workers.set('test', w as never)
  const s = { dir: lead, local: {}, me: { name: 'lead', kind: 'agent' }, room, awareness: { getStates: () => new Map() } }
  const retireWorkers = vi.fn(async () => {})
  const state = { S: () => s, rooms: { all: () => [s], holding: () => s, holdingWorker: () => s, reserve: () => true, unreserve() {}, retireWorkers }, workerAlive: () => false } as unknown as HandlerState
  return { call: handlers(state).room_collect, retireWorkers, state, s, w }
}

const LINES = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n'
/** Commit LINES as app.py in the lead and bring the worker's branch up to it; returns that HEAD. */
function commitLines() {
  put(lead, 'app.py', LINES); git(lead, 'add', '.'); git(lead, 'commit', '-qm', 'lines')
  const head = git(lead, 'rev-parse', 'HEAD')
  git(worker, 'merge', '-q', '--ff-only', head)
  return head
}
/** Commit files on a worker's branch the way spawn carries the lead's uncommitted work, and record that commit as the worker's base. */
function carry(t: ReturnType<typeof setup>, dir: string, tag: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) put(dir, p, text)
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'room: carried-in uncommitted work from lead')
  t.s.room.workers.set(tag, { ...t.s.room.workers.get(tag)!, base: git(dir, 'rev-parse', 'HEAD') })
}

describe('room_collect', () => {
  function second(t: ReturnType<typeof setup>, status = 'done') {
    const dir = path.join(root, 'second')
    git(lead, 'worktree', 'add', '-qb', 'room/second', dir)
    t.s.room.workers.set('second', { ...t.w, tag: 'second', name: 'lead+second', dir, branch: 'room/second', status, exitCode: 0, finishedAt: 1 } as never)
    t.s.room.workers.set('test', { ...t.w, exitCode: 0, finishedAt: 2 } as never)
    return dir
  }
  it('collects all finished workers in finish order, unstaged, cleans both and leaves history unchanged', async () => {
    const t = setup(), other = second(t), history = git(lead, 'log', '--oneline')
    put(worker, 'a.txt', 'a'); put(other, 'b.txt', 'b')
    const result = await t.call({})
    expect(result).toContain('Changes from second, test: a.txt, b.txt')
    expect(git(lead, 'log', '--oneline')).toBe(history)
    expect(git(lead, 'diff', '--cached')).toBe('')
    expect(git(lead, 'status', '--porcelain')).toContain('?? a.txt')
    expect(git(lead, 'status', '--porcelain')).toContain('?? b.txt')
    for (const dir of [worker, other]) expect(fs.existsSync(dir)).toBe(false)
    for (const tag of ['test', 'second']) expect(git(lead, 'branch', '--list', 'room/' + tag)).toBe('')
    expect(release).toHaveBeenCalledTimes(2)
    expect(t.s.room.workers.size).toBe(0)
  })
  it('keeps both workers and all lead files when their same-line changes conflict', async () => {
    const t = setup(), other = second(t)
    put(worker, 'file.txt', 'first\n'); put(other, 'file.txt', 'second\n'); put(worker, 'new.txt', 'new')
    const result = await t.call({})
    expect(result).toContain('file.txt (second, test)')
    expect(result).toContain('room_read')
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('base\n')
    expect(fs.existsSync(path.join(lead, 'new.txt'))).toBe(false)
    for (const dir of [worker, other]) expect(fs.existsSync(dir)).toBe(true)
    expect(release).not.toHaveBeenCalled()
  })
  it('collects deletion and addition together', async () => {
    const t = setup(), other = second(t)
    fs.unlinkSync(path.join(worker, 'file.txt')); put(other, 'added.txt', 'new')
    expect(await t.call({})).toContain('Nothing committed or staged')
    expect(fs.existsSync(path.join(lead, 'file.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(lead, 'added.txt'), 'utf8')).toBe('new')
  })
  it('skips running and failed workers even with force', async () => {
    const t = setup('running'), other = second(t, 'failed')
    t.s.room.workers.set('test', { ...t.w, status: 'running' } as never)
    put(worker, 'running.txt', 'no'); put(other, 'failed.txt', 'no')
    const result = await t.call({ force: true })
    expect(result).toContain('skipped test: running'); expect(result).toContain('skipped second: failed')
    expect(git(lead, 'status', '--porcelain')).toBe('')
  })
  it('a tag collects just that worker', async () => {
    const t = setup(), other = second(t)
    put(worker, 'one.txt', 'one'); put(other, 'two.txt', 'two')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test: one.txt')
    expect(fs.existsSync(path.join(lead, 'two.txt'))).toBe(false)
    expect(fs.existsSync(other)).toBe(true)
  })
  it('collects a worker recorded in a team session when its worktree belongs to the lead clone', async () => {
    const t = setup()
    delete (t.s as { local?: unknown }).local
    put(worker, 'team.txt', 'team work\n')
    const result = await t.call({ tag: 'test' })
    expect(result).toContain('Changes from test: team.txt')
    expect(fs.readFileSync(path.join(lead, 'team.txt'), 'utf8')).toBe('team work\n')
  })
  it('breaks equal finish times by tag and leaves unrelated workers untouched', async () => {
    const t = setup(), other = second(t)
    t.s.room.workers.set('test', { ...t.s.room.workers.get('test')!, finishedAt: 1 })
    t.s.room.workers.set('foreign', { ...t.w, tag: 'foreign', lead: 'someone-else' } as never)
    put(worker, 'a.txt', 'a'); put(other, 'b.txt', 'b')
    expect(await t.call({})).toContain('Changes from second, test:')
    expect(t.s.room.workers.has('foreign')).toBe(true)
    expect(t.retireWorkers).not.toHaveBeenCalled()
  })
  it('preserves deletion versus an empty-file edit as a conflict', async () => {
    const t = setup(), other = second(t)
    fs.unlinkSync(path.join(worker, 'file.txt')); put(other, 'file.txt', '')
    expect(await t.call({})).toContain('file.txt (second, test)')
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('base\n')
    expect(fs.existsSync(worker)).toBe(true); expect(fs.existsSync(other)).toBe(true)
  })
  it('rejects the removed commit argument as unknown', async () => {
    expect(await setup().call({ commit: true })).toBe('error: unknown argument commit')
    expect(await setup().call({ tag: 'test', commit: false })).toBe('error: unknown argument commit')
  })

  it.each([false, true])('preserves lead edits (staged=%s) without moving either HEAD or index', async staged => {
    const text = 'one\ntwo\nthree\nfour\nfive\n'; put(lead, 'file.txt', text); git(lead, 'commit', '-qam', 'lines'); git(worker, 'merge', '--ff-only', git(lead, 'rev-parse', 'HEAD'))
    const before = git(lead, 'rev-parse', 'HEAD')
    put(lead, 'file.txt', text.replace('one', 'LEAD')); if (staged) git(lead, 'add', 'file.txt')
    const index = git(lead, 'write-tree')
    put(worker, 'file.txt', text.replace('five', 'WORKER')); put(worker, 'new.txt', 'new'); put(worker, 'artifact.bin', 'ignored')
    expect(await setup().call({ tag: 'test' })).toContain('Changes from test:')
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe(text.replace('one', 'LEAD').replace('five', 'WORKER'))
    expect(git(lead, 'write-tree')).toBe(index); expect(git(lead, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(worker, 'rev-parse', 'HEAD')).toBe(before)
    expect(fs.existsSync(path.join(lead, 'artifact.bin'))).toBe(false)
    expect(git(lead, 'status', '--porcelain')).toContain('?? new.txt')
  })
  it('applies binary output, executable bits and deletions, excluding linked inputs', async () => {
    const t = setup(); t.s.room.workers.set('test', { ...t.w, link: ['data'] } as never)
    put(lead, 'data/input', 'private'); fs.symlinkSync(path.join(lead, 'data'), path.join(worker, 'data'))
    fs.unlinkSync(path.join(worker, 'file.txt')); fs.writeFileSync(path.join(worker, 'binary'), Buffer.from([0, 255, 128, 1]))
    put(worker, 'run.sh', '#!/bin/sh\n'); fs.chmodSync(path.join(worker, 'run.sh'), 0o755)
    expect(await t.call({ tag: 'test' })).toContain('Changes from test:')
    expect(fs.existsSync(path.join(lead, 'file.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(lead, 'binary'))).toEqual(Buffer.from([0, 255, 128, 1]))
    expect(fs.statSync(path.join(lead, 'run.sh')).mode & 0o111).toBe(0o111)
    expect(fs.readFileSync(path.join(lead, 'data/input'), 'utf8')).toBe('private')
  })
  it('skips failed workers without touching their output', async () => {
    const t = setup('failed'); t.s.room.workers.set('test', { ...t.w, exitCode: 1 } as never)
    put(worker, 'new.txt', 'new'); expect(await t.call({ tag: 'test' })).toContain('skipped test: failed')
    expect(fs.existsSync(path.join(lead, 'new.txt'))).toBe(false)
    expect(fs.existsSync(worker)).toBe(true); expect(git(lead, 'branch', '--list', 'room/test')).toContain('room/test')
  })
  it('discards a dirty running worker and restores committed, staged, unstaged and untracked output from one patch', async () => {
    const t = setup('running')
    put(worker, 'committed.txt', 'commit\n'); git(worker, 'add', '.'); git(worker, 'commit', '-qm', 'worker commit')
    put(worker, 'staged.txt', 'stage\n'); git(worker, 'add', '.')
    put(worker, 'file.txt', 'dirty\n'); put(worker, 'new.txt', 'untracked\n')
    fs.writeFileSync(path.join(worker, 'binary'), Buffer.from([0, 255, 128]))
    put(worker, 'node_modules/pkg/cache.bin', 'dependency cache')
    for (const suffix of ['.log', '.mcp.log']) put(lead, '.room/workers/test' + suffix, 'log')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    await new Promise<void>(resolve => child.once('spawn', resolve))
    t.state.workerAlive = () => pidAlive(child.pid!)
    t.state.dismissWorker = () => {
      signalWorker(child.pid!)
      t.s.room.workers.set('test', { ...t.w, status: 'dismissed' } as never)
      return 'signalled'
    }
    try {
      const result = await t.call({ tag: 'test', discard: true })
      expect(result).toMatch(/^discarded test; recovery patch: .*kept for a week/)
      expect(result.split('\n')).toHaveLength(1)
      expect(pidAlive(child.pid!)).toBe(false)
      expect(fs.existsSync(worker)).toBe(false)
      expect(git(lead, 'branch', '--list', 'room/test')).toBe('')
      expect(fs.existsSync(path.join(lead, '.room/workers'))).toBe(false)
      expect(t.s.room.workers.size).toBe(0); expect(release).toHaveBeenCalled()
      const patches = fs.readdirSync(path.join(lead, '.room/discarded'))
      expect(patches).toHaveLength(1); expect(patches[0]).toMatch(/^test-\d{8}-\d{6}\.patch$/)
      const fresh = path.join(root, 'fresh')
      git(lead, 'worktree', 'add', '--detach', fresh, base)
      git(fresh, 'apply', path.join(lead, '.room/discarded', patches[0]))
      for (const [p, text] of [['committed.txt', 'commit\n'], ['staged.txt', 'stage\n'], ['file.txt', 'dirty\n'], ['new.txt', 'untracked\n']]) expect(fs.readFileSync(path.join(fresh, p), 'utf8')).toBe(text)
      expect(fs.readFileSync(path.join(fresh, 'binary'))).toEqual(Buffer.from([0, 255, 128]))
      expect(fs.existsSync(path.join(fresh, 'node_modules'))).toBe(false)
    } finally { if (pidAlive(child.pid!)) child.kill('SIGKILL') }
  })
  it('refuses discard when ignored artifacts are outside the recovery patch and names what was kept', async () => {
    const t = setup('failed')
    put(worker, 'artifact.bin', 'generated model')
    put(worker, 'node_modules/pkg/cache.bin', 'dependency cache')
    const result = await t.call({ tag: 'test', discard: true })
    expect(result).toContain('ignored artifacts not covered by a recovery patch: artifact.bin')
    expect(result).toContain(`kept artifact.bin at ${path.join(worker, 'artifact.bin')}`)
    expect(result).toContain(`retained worktree: ${worker}`)
    expect(result).not.toContain('node_modules')
    expect(fs.readFileSync(path.join(worker, 'artifact.bin'), 'utf8')).toBe('generated model')
    expect(t.s.room.workers.has('test')).toBe(true)
  })
  it('names an ignored directory once and discards it only when the lead repeats with force', async () => {
    const t = setup('failed')
    put(worker, '.gitignore', 'dist/\n')
    put(worker, 'dist/a.js', 'a'); put(worker, 'dist/b.js', 'b')
    const refused = await t.call({ tag: 'test', discard: true })
    expect(refused).toContain('not covered by a recovery patch: dist/\n')
    expect(refused).toContain('force=true')
    expect(fs.existsSync(path.join(worker, 'dist/a.js'))).toBe(true)
    const forced = await t.call({ tag: 'test', discard: true, force: true })
    expect(forced).toContain('deleted without a copy: dist/')
    expect(fs.existsSync(worker)).toBe(false)
  })
  it('discards a clean failed worker without a patch and prunes old patches and empty folders', async () => {
    const t = setup('failed')
    put(lead, '.room/discarded/old.patch', 'old')
    const old = new Date(Date.now() - 8 * 86400_000)
    fs.utimesSync(path.join(lead, '.room/discarded/old.patch'), old, old)
    put(lead, '.room/workers/test.log', 'log')
    expect(await t.call({ tag: 'test', discard: true })).toBe('discarded test')
    expect(fs.existsSync(path.join(lead, '.room'))).toBe(false)
  })
  it('keeps recent patches and another worker folder until the last cleanup', async () => {
    const t = setup(); second(t)
    put(lead, '.room/workers/second.log', 'log'); put(lead, '.room/workers/test.log', 'log')
    expect(await t.call({ tag: 'test', discard: true })).toBe('discarded test')
    expect(fs.existsSync(path.join(lead, '.room/workers'))).toBe(true)
    expect(await t.call({ tag: 'second' })).toContain('cleaned up second')
    expect(fs.existsSync(path.join(lead, '.room'))).toBe(false)
  })
  it('retains recovery patches younger than a week', async () => {
    const t = setup(); put(lead, '.room/discarded/recent.patch', 'recent')
    expect(await t.call({ tag: 'test', discard: true })).toBe('discarded test')
    expect(fs.readFileSync(path.join(lead, '.room/discarded/recent.patch'), 'utf8')).toBe('recent')
  })
  it('leaves all files and indexes untouched on a conflict', async () => {
    put(lead, 'file.txt', 'lead\n'); put(worker, 'file.txt', 'worker\n'); put(worker, 'new.txt', 'new')
    const before = git(lead, 'write-tree')
    expect(await setup().call({ tag: 'test' })).toContain('Nothing written; conflicting files: file.txt')
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('lead\n')
    expect(fs.existsSync(path.join(lead, 'new.txt'))).toBe(false)
    expect(git(lead, 'write-tree')).toBe(before); expect(git(worker, 'rev-parse', 'HEAD')).toBe(base)
  })
  it('cleans successful fully applied workers and their logs', async () => {
    const t = setup(); t.s.room.workers.set('test', { ...t.w, exitCode: 0 } as never)
    put(worker, 'new.txt', 'new'); put(lead, '.room/workers/test.log', 'log'); put(lead, '.room/workers/test.mcp.log', 'log')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test:')
    expect(fs.existsSync(worker)).toBe(false); expect(git(lead, 'branch', '--list', 'room/test')).toBe('')
    expect(fs.existsSync(path.join(lead, '.room'))).toBe(false)
  })
  it('applies ordinary changes but retains uncopied ignored artifacts and their worktree', async () => {
    const t = setup(); t.s.room.workers.set('test', { ...t.w, exitCode: 0 } as never)
    put(worker, 'new.txt', 'new'); put(worker, 'artifact.bin', 'diagnostic output')
    const result = await t.call({ tag: 'test' })
    expect(result).toContain('Changes from test: new.txt')
    expect(result).toContain(`kept artifact.bin at ${path.join(worker, 'artifact.bin')}`)
    expect(result).toContain(`retained worktree: ${worker}`)
    expect(result).not.toContain('cleaned up test')
    expect(fs.readFileSync(path.join(lead, 'new.txt'), 'utf8')).toBe('new')
    expect(fs.readFileSync(path.join(worker, 'artifact.bin'), 'utf8')).toBe('diagnostic output')
    expect(t.s.room.workers.has('test')).toBe(true)
    expect(await t.call({ tag: 'test', force: true })).toContain(`retained worktree: ${worker}`)
    expect(fs.existsSync(worker)).toBe(true)
  })

  it('merges a worker against its carried-in commit: the lead\'s later edits to carried lines survive and only the worker\'s lines land', async () => {
    commitLines()
    const t = setup(); t.s.room.workers.set('test', { ...t.w, exitCode: 0 } as never)
    put(lead, 'app.py', LINES.replace('two', 'W')); put(lead, 'notes.txt', 'draft\n')
    carry(t, worker, 'test', { 'app.py': LINES.replace('two', 'W'), 'notes.txt': 'draft\n' })
    put(lead, 'app.py', LINES.replace('two', 'W2')); put(lead, 'notes.txt', 'draft 2\n')
    put(worker, 'app.py', LINES.replace('two', 'W').replace('five', 'WORKER'))
    const result = await t.call({ tag: 'test' })
    expect(result).toContain('Changes from test: app.py. Nothing committed or staged.')
    expect(fs.readFileSync(path.join(lead, 'app.py'), 'utf8')).toBe(LINES.replace('two', 'W2').replace('five', 'WORKER'))
    expect(fs.readFileSync(path.join(lead, 'notes.txt'), 'utf8')).toBe('draft 2\n')
    expect(t.s.room.retiredWorkers().map(r => r.files)).toEqual([['app.py']])
  })
  it('merges each of two workers against its own carried-in commit', async () => {
    commitLines()
    const t = setup(), other = second(t)
    put(lead, 'app.py', LINES.replace('two', 'W'))
    carry(t, worker, 'test', { 'app.py': LINES.replace('two', 'W') })
    put(lead, 'app.py', LINES.replace('two', 'W2').replace('three', 'X'))
    carry(t, other, 'second', { 'app.py': LINES.replace('two', 'W2').replace('three', 'X') })
    put(lead, 'app.py', LINES.replace('two', 'W3').replace('three', 'X2'))
    put(worker, 'app.py', LINES.replace('two', 'W').replace('seven', 'A'))
    put(other, 'app.py', LINES.replace('two', 'W2').replace('three', 'X').replace('five', 'B'))
    expect(await t.call({})).toContain('Changes from second, test: app.py.')
    expect(fs.readFileSync(path.join(lead, 'app.py'), 'utf8')).toBe('one\nW3\nX2\nfour\nB\nsix\nA\n')
  })
  it('does not treat unchanged CRLF carried files as worker edits', async () => {
    commitLines()
    git(lead, 'config', 'core.autocrlf', 'true')
    const t = setup(); t.s.room.workers.set('test', { ...t.w, exitCode: 0 } as never)
    const crlf = (value: string) => value.replace(/\n/g, '\r\n')
    put(lead, 'app.py', crlf(LINES.replace('two', 'W')))
    put(worker, 'app.py', crlf(LINES.replace('two', 'W')))
    git(worker, 'add', 'app.py'); git(worker, 'commit', '-qm', 'room: carried-in uncommitted work from lead')
    t.s.room.workers.set('test', { ...t.s.room.workers.get('test')!, base: git(worker, 'rev-parse', 'HEAD') })
    put(lead, 'app.py', crlf(LINES.replace('two', 'W2')))
    put(worker, 'new.txt', 'worker output\n')
    const result = await t.call({ tag: 'test' })
    expect(result).toContain('Changes from test: new.txt.')
    expect(fs.readFileSync(path.join(lead, 'app.py'), 'utf8')).toBe(crlf(LINES.replace('two', 'W2')))
  })
  it('does not collect unchanged carried untracked files over later lead edits', async () => {
    const t = setup(); t.s.room.workers.set('test', { ...t.w, exitCode: 0 } as never)
    put(lead, 'notes.txt', 'lead draft\n')
    put(worker, 'notes.txt', 'lead draft\n')
    const sha = git(worker, 'hash-object', '-w', 'notes.txt')
    t.s.room.workers.set('test', { ...t.s.room.workers.get('test')!, carriedUntracked: [{ path: 'notes.txt', sha }] })
    put(lead, 'notes.txt', 'lead revised draft\n')
    put(worker, 'new.txt', 'worker output\n')
    const result = await t.call({ tag: 'test' })
    expect(result).toContain('Changes from test: new.txt.')
    expect(fs.readFileSync(path.join(lead, 'notes.txt'), 'utf8')).toBe('lead revised draft\n')
  })
  it('preserves a later lead mode change on an unchanged carried untracked file', async () => {
    const t = setup(); t.s.room.workers.set('test', { ...t.w, exitCode: 0 } as never)
    put(lead, 'run.sh', '#!/bin/sh\necho lead\n')
    put(worker, 'run.sh', '#!/bin/sh\necho lead\n')
    const sha = git(worker, 'hash-object', '-w', 'run.sh')
    t.s.room.workers.set('test', { ...t.s.room.workers.get('test')!, carriedUntracked: [{ path: 'run.sh', sha }] })
    fs.chmodSync(path.join(lead, 'run.sh'), 0o755)
    put(worker, 'new.txt', 'worker output\n')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test: new.txt.')
    expect(fs.statSync(path.join(lead, 'run.sh')).mode & 0o777).toBe(0o755)
  })
  it('merges a changed carried untracked file against the lead copy', async () => {
    const t = setup(); t.s.room.workers.set('test', { ...t.w, exitCode: 0 } as never)
    put(lead, 'notes.txt', LINES)
    put(worker, 'notes.txt', LINES)
    const sha = git(worker, 'hash-object', '-w', 'notes.txt')
    t.s.room.workers.set('test', { ...t.s.room.workers.get('test')!, carriedUntracked: [{ path: 'notes.txt', sha }] })
    put(lead, 'notes.txt', LINES.replace('two', 'LEAD'))
    put(worker, 'notes.txt', LINES.replace('six', 'WORKER'))
    const result = await t.call({ tag: 'test' })
    expect(result).toContain('Changes from test: notes.txt.')
    expect(fs.readFileSync(path.join(lead, 'notes.txt'), 'utf8')).toBe(LINES.replace('two', 'LEAD').replace('six', 'WORKER'))
  })
  it('refuses a changed carried untracked file when its private base blob is missing', async () => {
    const t = setup(); t.s.room.workers.set('test', { ...t.w, exitCode: 0 } as never)
    put(lead, 'notes.txt', 'lead revised\n')
    put(worker, 'notes.txt', 'worker revised\n')
    t.s.room.workers.set('test', { ...t.s.room.workers.get('test')!, carriedUntracked: [{ path: 'notes.txt', sha: 'f'.repeat(40) }] })
    const result = await t.call({ tag: 'test' })
    expect(result).toMatch(/Nothing written;.*missing private base blob: notes\.txt/i)
    expect(fs.readFileSync(path.join(lead, 'notes.txt'), 'utf8')).toBe('lead revised\n')
    expect(fs.existsSync(worker)).toBe(true)
  })
  it('keeps the lead\'s later file-mode change to a carried file the worker left alone', async () => {
    put(lead, 'run.sh', '#!/bin/sh\n'); git(lead, 'add', '.'); git(lead, 'commit', '-qm', 'script'); git(worker, 'merge', '-q', '--ff-only', git(lead, 'rev-parse', 'HEAD'))
    const t = setup()
    fs.chmodSync(path.join(lead, 'run.sh'), 0o755); fs.chmodSync(path.join(worker, 'run.sh'), 0o755)
    carry(t, worker, 'test', {})
    fs.chmodSync(path.join(lead, 'run.sh'), 0o644)
    put(worker, 'new.txt', 'new\n')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test: new.txt.')
    expect(fs.statSync(path.join(lead, 'run.sh')).mode & 0o777).toBe(0o644)
  })

  it('waits for a done worker to exit without requiring force', async () => {
    const t = setup()
    let at = 0
    const sleep = vi.fn(async (ms: number) => { at += ms })
    t.state.now = () => at
    t.state.ctx = { sleep } as HandlerState['ctx']
    t.state.workerAlive = () => at < 10_000
    put(worker, 'new.txt', 'new')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test:')
    expect(sleep).toHaveBeenCalledTimes(40)
    expect(sleep).toHaveBeenCalledWith(250)
  })
  it('uses the confirmed exit record after waiting when cleaning up', async () => {
    const t = setup(); let alive = true
    t.state.workerAlive = () => alive
    t.state.ctx = { sleep: async () => { alive = false; t.s.room.workers.set('test', { ...t.w, exitCode: 0 } as never) } } as HandlerState['ctx']
    put(worker, 'new.txt', 'new')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test:')
    expect(fs.existsSync(worker)).toBe(false)
  })
  it('bounds the exit wait at 15 seconds and never collects a live process', async () => {
    const t = setup()
    let at = 0
    t.state.now = () => at
    t.state.ctx = { sleep: async (ms: number) => { at += ms } } as HandlerState['ctx']
    t.state.workerAlive = () => true
    expect(await t.call({ tag: 'test' })).toContain('skipped test: process has not exited after 15 s')
    expect(at).toBe(15_000)
    expect(git(worker, 'rev-parse', 'HEAD')).toBe(base)
    expect(await t.call({ tag: 'test', force: true })).toContain('skipped test: process has not exited')
    expect(at).toBe(30_000)
  })



  it('copies ignored and nested artifacts byte-for-byte, without committing', async () => {
    put(worker, 'artifact.bin', 'a\0b'); put(worker, 'out/nested.txt', 'nested')
    const t = setup(), before = git(lead, 'rev-parse', 'HEAD')
    expect(await t.call({ tag: 'test', mode: 'copy', paths: ['artifact.bin', 'out'] })).toBe('copied artifact.bin\ncopied out/nested.txt')
    expect(fs.readFileSync(path.join(lead, 'artifact.bin'))).toEqual(fs.readFileSync(path.join(worker, 'artifact.bin')))
    expect(git(lead, 'rev-parse', 'HEAD')).toBe(before)
    expect(fs.existsSync(worker)).toBe(true)
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
    expect(await t.call({ tag: 'test' })).toContain('skipped test: running')
    expect(await t.call({ tag: 'test', mode: 'bad' })).toContain('mode must be')
    expect(await t.call({ tag: 'test', force: true })).toContain('skipped test: running')
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

})

describe('worker preview', () => {
  it('does not link dependencies through an archived symlink ancestor', () => {
    const scratch = path.join(root, 'scratch'), outside = path.join(root, 'outside')
    fs.mkdirSync(path.join(lead, 'packages', 'pkg', 'node_modules', 'dep'), { recursive: true })
    fs.mkdirSync(path.join(scratch, 'packages'), { recursive: true })
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(scratch, 'packages', 'pkg'))
    expect(() => linkSharedDirs(lead, scratch)).toThrow(/unsafe merged ancestor|escapes scratch tree/)
    expect(fs.existsSync(path.join(outside, 'node_modules'))).toBe(false)
  })

  it('refuses a symlink ancestor in the extracted scratch tree', () => {
    const scratch = path.join(root, 'scratch'), outside = path.join(root, 'outside')
    fs.mkdirSync(scratch); fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(scratch, 'config'))
    expect(() => materializeMergedFile(scratch, 'config/value.txt', Buffer.from('secret'))).toThrow('unsafe merged ancestor')
    expect(fs.existsSync(path.join(outside, 'value.txt'))).toBe(false)
  })

  it('does not write through a symlink restored from the ancestor archive', async () => {
    const external = path.join(root, 'external.txt')
    put(root, 'external.txt', 'outside stays intact\n')
    fs.symlinkSync(external, path.join(lead, 'config.txt'))
    git(lead, 'add', 'config.txt'); git(lead, 'commit', '-qm', 'symlink ancestor')
    const head = git(lead, 'rev-parse', 'HEAD')
    git(worker, 'merge', '-q', '--ff-only', head)
    fs.unlinkSync(path.join(lead, 'config.txt'))
    fs.unlinkSync(path.join(worker, 'config.txt'))
    put(lead, 'config.txt', 'safe lead version\n')
    put(worker, 'config.txt', 'safe lead version\n')
    put(worker, 'file.txt', 'worker edit\n')
    const t = setup()
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [], withheld: () => undefined,
      baseFor: () => head, shareOf: () => 'full', liveText: async () => undefined,
    })
    await fileHandlers(t.state).room_preview_merge({ person: 'lead+test', run: 'cat config.txt && echo "1 passed"' })
    expect(fs.readFileSync(external, 'utf8')).toBe('outside stays intact\n')
  })

  it('runs against the same binary bytes and executable mode that collect applies', async () => {
    const t = setup()
    fs.writeFileSync(path.join(worker, 'fixture.bin'), Buffer.from([0, 255, 1]))
    put(worker, 'run.sh', '#!/bin/sh\necho run\n')
    fs.chmodSync(path.join(worker, 'run.sh'), 0o755)
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [], withheld: () => undefined,
      baseFor: () => base, shareOf: () => 'full', liveText: async () => undefined,
    })
    const result = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test', run: 'test "$(od -An -tu1 fixture.bin | tr -s " " | xargs)" = "0 255 1" && test -x run.sh && echo "1 passed"' })
    expect(result).toContain('tests: PASSED (exit 0)')
  })
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
  it('previews a worker against its carried-in commit, not the lead\'s HEAD', async () => {
    const head = commitLines()
    const t = setup()
    put(lead, 'app.py', LINES.replace('two', 'W')); put(lead, 'notes.txt', 'draft\n')
    carry(t, worker, 'test', { 'app.py': LINES.replace('two', 'W'), 'notes.txt': 'draft\n' })
    put(lead, 'app.py', LINES.replace('two', 'W2')); put(lead, 'notes.txt', 'draft 2\n')
    put(worker, 'app.py', LINES.replace('two', 'W').replace('five', 'WORKER'))
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [], withheld: () => undefined,
      baseFor: (_s: unknown, person: string) => person === 'lead' ? head : t.s.room.workers.get('test')!.base, shareOf: () => 'full',
      liveText: async () => undefined,
    })
    const result = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test', run: 'cat app.py notes.txt' })
    expect(result).toContain('both changed, merge cleanly: app.py')
    expect(result).not.toContain('notes.txt (lead+test')
    expect(result).toContain('no conflicts')
    expect(result).toContain('one\nW2\nthree\nfour\nWORKER\nsix\nseven\ndraft 2')
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
