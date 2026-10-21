import { LINES, base, carry, collectRefHook, commitLines, expectRetired, git, gitPathCalls, lead, ownershipEvidence, put, release, reportedRunning, root, second, seedPresence, setup, startWorktreeProcess, useLegacyWorker, worker } from './collect-fixture.js'
import { git as roomGit } from '@room/roomd/git'
import { workerLines } from '@room/shared'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PolicyStore, sharingFile } from '../src/policy-store.js'
import { autoRetire } from '../src/retire.js'
import { ToolTiming, ToolTimingTracker, currentToolTiming } from '../src/timing.js'
import type { HandlerState } from '../src/tools/context.js'
import { ignoredWorkerArtifacts } from '../src/worker-git.js'
import { pidAlive, signalWorker } from '../src/worker-process.js'
import { localWorkers, registryForDir } from '../src/worker-registry.js'
import { finishWorker, workerByTag } from './registry-fixture.js'
describe('room_collect', () => {

  it('preserves scratch handling and stays finished through automatic retirement after keep', async () => {
    const t = setup()
    t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'file.txt', 'worker output\n')
    put(worker, 'debug.log', 'scratch output\n')
    const result = await t.call({ tag: 'test', keep: true })
    expect(result).toContain('scratch')
    expect(fs.existsSync(path.join(lead, 'debug.log'))).toBe(false)
    expect(fs.readFileSync(path.join(lead, '.room/scratch/test/debug.log'), 'utf8')).toBe('scratch output\n')
    const rooms = { ...t.state.rooms, probe: () => undefined } as never
    await autoRetire(t.s, rooms)
    expect(workerByTag(lead, 'test')?.status).toBe('done')
    expect(fs.existsSync(path.join(worker, 'debug.log'))).toBe(true)
    const kept = (await registryForDir(lead)).read('w_test')!
    expect(git(lead, 'ls-tree', '--name-only', kept.base!)).not.toContain('debug.log')
    expect(await t.call({ tag: 'test' })).toContain('cleaned up test')
  })

  it('does not mistake an aborted normal collect ref for an intentional keep', async () => {
    const t = setup()
    t.set('test', { ...t.w, exitCode: 0 })
    await t.sync()
    // A normal collect can publish this ref before the final destination gate aborts.
    git(lead, 'update-ref', 'refs/room/collect-head/test/w_test', base)
    await autoRetire(t.s, { ...t.state.rooms, probe: () => undefined } as never)
    expect((await registryForDir(lead)).read('w_test')?.phase).toBe('retired')
    expect(fs.existsSync(worker)).toBe(false)
  })

  it('absorbs carried baselines without applying the lead work again on repeated keep', async () => {
    const t = setup()
    carry(t, worker, 'test', { 'file.txt': 'lead carried edit\n' })
    // Use a real carried untracked blob, as spawn does without adding it to the worker index.
    put(worker, 'carried.txt', 'lead carried untracked\n')
    const sha = git(worker, 'hash-object', '-w', 'carried.txt')
    t.set('test', { ...t.get('test'), exitCode: 0, carriedUntracked: [{ path: 'carried.txt', sha, mode: 0o644 }] })
    put(lead, 'file.txt', 'lead carried edit\n')
    put(lead, 'carried.txt', 'lead carried untracked\n')
    put(worker, 'new.txt', 'first output\n')
    expect(await t.call({ keep: true })).toContain('Changes from test: new.txt')
    const record = (await registryForDir(lead)).read('w_test')!
    expect(record.carriedUntracked).toBeUndefined()
    expect(record.carriedBase).toBeUndefined()
    expect(git(lead, 'show', `${record.base}:carried.txt`)).toBe('lead carried untracked')
    put(lead, 'carried.txt', 'lead revises carried work\n')
    put(worker, 'new.txt', 'second output\n')
    expect(await t.call({ keep: true })).toContain('Changes from test: new.txt')
    expect(fs.readFileSync(path.join(lead, 'carried.txt'), 'utf8')).toBe('lead revises carried work\n')
    expect(await t.call({})).toContain('cleaned up test')
  })

  it.each([{ mode: 'copy', paths: ['file.txt'] }, { discard: true }])('refuses keep outside apply: %j', async args => {
    const t = setup()
    expect(await t.call({ tag: 'test', ...args, keep: true })).toContain('keep is only supported in apply mode without discard')
    expect(fs.existsSync(worker)).toBe(true)
  })

  it('writes nothing and keeps the previous baseline when kept collection conflicts', async () => {
    const t = setup()
    put(worker, 'file.txt', 'worker edit\n')
    put(lead, 'file.txt', 'conflicting lead edit\n')
    expect(await t.call({ keep: true })).toContain('Nothing written; conflicting files: file.txt')
    expect((await registryForDir(lead)).read('w_test')).toMatchObject({ phase: 'active', base })
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('conflicting lead edit\n')
    expect(fs.existsSync(worker)).toBe(true)
  })

  it('refuses a source that changes after snapshot without advancing the kept baseline', async () => {
    const t = setup()
    put(worker, 'file.txt', 'first output\n')
    collectRefHook.call = () => put(worker, 'file.txt', 'changed during collect\n')
    expect(await t.call({ keep: true })).toContain('changed during collection; nothing written')
    expect((await registryForDir(lead)).read('w_test')).toMatchObject({ phase: 'active', base })
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('base\n')
    collectRefHook.call = undefined
    expect(await t.call({ keep: true })).toContain('Changes from test: file.txt')
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('changed during collect\n')
  })

  it.each([false, true])('refuses discard before a recovery snapshot when cwd inspection fails (retired: %s)', async retired => {
    const t = setup()
    t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'new.txt', 'worker change')
    if (retired) {
      put(worker, 'artifact.bin', 'ignored output')
      const collected = await t.call({ tag: 'test' })
      expect(collected, await ownershipEvidence(t)).toContain('Changes from test: new.txt')
      expect(workerByTag(lead, 'test')).toBeUndefined()
    }
    t.state.ctx!.listCwdProcesses = () => { throw new Error('worktree process inspection is unsupported on win32') }
    const result = await t.call({ tag: 'test', discard: true, force: true })
    expect(result, await ownershipEvidence(t)).toContain('worktree process inspection is unsupported on win32')
    expect(fs.existsSync(path.join(lead, '.git/room/registry/patches/w_test.patch'))).toBe(false)
    expect(fs.readFileSync(path.join(worker, 'new.txt'), 'utf8')).toBe('worker change')
    expect(git(lead, 'rev-parse', '--verify', 'room/test')).toBe(base)
  })

  it('collects edits but retains the worktree when cwd inspection fails', async () => {
    const t = setup()
    t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'new.txt', 'worker change')
    t.state.ctx!.listCwdProcesses = () => { throw new Error('worktree process inspection is unsupported on win32') }
    const result = await t.call({ tag: 'test' })
    expect(result, await ownershipEvidence(t)).toContain('Changes from test: new.txt')
    expect(result).toContain('worktree process inspection is unsupported on win32')
    expect(fs.readFileSync(path.join(lead, 'new.txt'), 'utf8')).toBe('worker change')
    expect(fs.existsSync(worker)).toBe(true)
    expect(t.s.room.retiredWorkers()[0].keptWorktree).toBe(worker)
  })

  it('checks Git operation markers in one call per checkout and reports collect phases', async () => {
    const t = setup()
    put(worker, 'new.txt', 'worker output\n')
    let timing: ToolTiming | undefined
    const result = await new ToolTimingTracker({ log: () => {} }).run('room_collect', async () => {
      timing = currentToolTiming()
      return t.call({ tag: 'test' })
    })
    expect(result).toContain('Changes from test: new.txt.')
    expect(gitPathCalls).toHaveLength(2)
    for (const args of gitPathCalls) expect(args.filter(arg => arg === '--git-path')).toHaveLength(5)
    expect(timing?.slowLine(0, 0)).toMatch(/lease .*inspect .*merge .*prepare .*cleanup /)
  })

  it.each(['done', 'dismissed', 'running'] as const)('keeps a %s worker when its live pid cannot be verified', async status => {
    const t = setup(status)
    const current = { ...t.w, id: 'worker-id', pid: process.pid, startedAt: Date.now(), exitCode: status === 'running' ? undefined : 0 }
    t.set('test', current)
    t.state.ctx = { listCwdProcesses: () => [], probe: () => ({}) } as never
    t.state.dismissWorker = vi.fn(async () => 'signalled')
    put(worker, 'new.txt', 'worker change')
    for (const args of [{ tag: 'test' }, { tag: 'test', discard: true }]) {
      const reply = await t.call(args)
      expect(reply).toContain(`could not verify test's process (pid ${process.pid}); left running, not stopped`)
      expect(workerByTag(lead, 'test')).toMatchObject({ tag: 'test', status, pid: process.pid })
      expect(fs.existsSync(worker)).toBe(true)
    }
    expect(t.state.dismissWorker).not.toHaveBeenCalled()
    expect(t.s.room.retiredWorkers()).toHaveLength(0)
  })

  it('discards a finished worker whose pid now belongs to another process', async () => {
    const t = setup()
    t.set('test', { ...t.w, pid: process.pid, processStartTime: 'worker-start' })
    t.state.ctx = { listCwdProcesses: () => [], probe: () => ({ startTime: 'stranger-start', executable: 'ContainerMetadataExtractor' }) } as never
    // The runtime's dismissWorker refuses to signal a pid another process holds; the discard still completes.
    t.state.dismissWorker = vi.fn(async () => `pid ${process.pid} belongs to another process; not signalled`) as never
    const reply = await t.call({ tag: 'test', discard: true })
    expect(reply).toContain('discarded test')
    expect(reply).not.toContain('could not verify')
    expect(pidAlive(process.pid)).toBe(true)
    expect(workerByTag(lead, 'test')).toBeUndefined()
    expect(fs.existsSync(worker)).toBe(false)
  })

  it('retires collected worker with ignored output and shows only its kept worktree', async () => {
    const t = setup()
    t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'new.txt', 'worker change')
    put(worker, 'artifact.bin', 'ignored output')
    // The worker's declared grant ended while new.txt was shared, so its policy retains that path.
    const policy = await PolicyStore.open({ dir: worker, room: t.s.roomName, participant: t.w.name, server: 'ws://127.0.0.1:1', requested: 'declared' })
    await policy.declare(['new.txt'])
    await policy.settle(await policy.declare([]), new Map([['new.txt', { state: 'shared', change: 'A' }]]), [])
    expect(policy.retained).toEqual(['new.txt'])
    const retained = await sharingFile(worker, t.s.roomName, t.w.name)
    expect(fs.existsSync(retained)).toBe(true)
    seedPresence(t)
    expect(await t.call({ tag: 'test' })).toContain(`kept artifact.bin at ${path.join(worker, 'artifact.bin')}`)
    expect(fs.existsSync(worker)).toBe(true)
    expect(fs.existsSync(retained)).toBe(false)
    expectRetired(t)
    expect(t.s.room.retiredWorkers()[0].keptWorktree).toBe(worker)
    expect(workerLines([], { retiredWorkers: t.s.room.retiredWorkers() }).join('\n')).toContain('kept: uncopied ignored artifacts')
    const lines = workerLines([], { all: true, retiredWorkers: t.s.room.retiredWorkers() }).join('\n')
    expect(lines).toContain(`kept for ignored output at ${worker}`)
    expect(lines).not.toContain('uncommitted')
    expect(lines).toContain('workers (1):')
  })

  it('refuses to stop a worker in an unmanaged existing directory', async () => {
    const t = setup('running')
    t.set('test', { ...t.w, dir: lead, branch: 'main', model: 'worker-model' })
    let alive = true
    const stopped = vi.fn(async () => { alive = false; return 'pid signalled' })
    t.state.workerAlive = () => alive
    t.state.dismissWorker = stopped as never
    const result = await t.call({ tag: 'test', discard: true })
    expect(stopped).not.toHaveBeenCalled()
    expect(result).toContain('no local worker capability')
    expect(fs.existsSync(lead)).toBe(true)
    expect(t.s.room.retiredWorkers()).toEqual([])
  })

  it('keeps a finished worker when process ownership becomes unknown during discard', async () => {
    const t = setup()
    t.set('test', { ...t.w, pid: 4242, processStartTime: 'fixed-start' })
    let readable = true
    t.state.ctx = { listCwdProcesses: () => [], probe: () => readable ? { startTime: 'fixed-start', executable: 'codex' } : {} } as never
    t.state.dismissWorker = vi.fn(async () => {
      readable = false
      return "could not verify test's process; left running, not stopped"
    }) as never
    const reply = await t.call({ tag: 'test', discard: true })
    expect(reply).toContain("could not verify test's process")
    expect(reply).toContain('left running, not stopped')
    expect(workerByTag(lead, 'test')).toBeDefined()
    expect(t.s.room.retiredWorkers()).toHaveLength(0)
    expect(fs.existsSync(worker)).toBe(true)
  })

  it('stops worktree processes even when ignored output keeps the collected worktree', async () => {
    const t = setup()
    t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'new.txt', 'worker change')
    put(worker, 'artifact.bin', 'ignored output')
    const child = await startWorktreeProcess()
    t.state.ctx.listCwdProcesses = () => [{ pid: child.pid!, cwd: worker, command: 'node' }]
    try {
      const reply = await t.call({ tag: 'test' })
      expect(reply).toContain('kept test: uncopied ignored artifacts')
      expect(reply).toContain(`pid ${child.pid}`)
      expect(reply).toContain('stopped processes from test:')
      expect(fs.existsSync(worker)).toBe(true)
    } finally { child.kill('SIGKILL') }
  })

  it('cleans regenerable ignored output while retaining other ignored artifacts', async () => {
    fs.appendFileSync(path.join(lead, '.git/info/exclude'), 'dist/\n.astro/\ntest-results/\n.venv/\n')
    const t = setup()
    t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'new.txt', 'worker change')
    for (const p of ['dist/app.js', '.astro/cache.json', 'test-results/trace.zip']) put(worker, p, 'regenerable')
    const reply = await t.call({ tag: 'test' })
    expect(reply).toContain('cleaned up test')
    expect(reply).not.toContain('uncopied ignored artifacts')
    expect(reply).not.toContain('dist/app.js')
    expect(fs.existsSync(path.join(lead, 'dist/app.js'))).toBe(false)
    expect(fs.existsSync(worker)).toBe(false)

    const other = path.join(lead, '.room', 'workers', 'other')
    git(lead, 'worktree', 'add', '-qb', 'room/other', other)
    t.set('other', { ...t.w, tag: 'other', name: 'lead+other', dir: other, branch: 'room/other', exitCode: 0 })
    put(other, '.venv/lib.py', 'unrecoverable')
    const kept = await t.call({ tag: 'other' })
    expect(kept).toContain('kept .venv/')
    expect(fs.existsSync(other)).toBe(true)
  })

  it('collects and cleans a generated Python virtual environment', async () => {
    fs.appendFileSync(path.join(lead, '.git/info/exclude'), '.venv/\n')
    const t = setup()
    t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'new.txt', 'worker change')
    put(worker, '.venv/pyvenv.cfg', 'home = /python/bin\nversion_info = 3.12.0.final.0\n')
    put(root, 'python', 'interpreter')
    fs.mkdirSync(path.join(worker, '.venv/bin'))
    fs.symlinkSync(path.join(root, 'python'), path.join(worker, '.venv/bin/python'))
    put(worker, '.venv/.gitignore', '*\n')
    put(worker, '.venv/CACHEDIR.TAG', 'Signature: 8a477f597d28d172789f06886806bc55\n')
    put(worker, '.venv/lib/python3.12/site-packages/dependency.py', 'installed dependency')
    fs.symlinkSync('lib', path.join(worker, '.venv/lib64'))
    expect(await ignoredWorkerArtifacts(t.w)).toEqual([])
    expect(await t.call({ tag: 'test' })).toContain('cleaned up test')
    expect(fs.existsSync(worker)).toBe(false)
    expect(fs.readFileSync(path.join(lead, 'new.txt'), 'utf8')).toBe('worker change')
    expect(fs.existsSync(path.join(lead, '.venv'))).toBe(false)
    expect(fs.readFileSync(path.join(root, 'python'), 'utf8')).toBe('interpreter')
  })

  it.each(['unknown file', 'linked config', 'linked directory', 'missing interpreter', 'file named share', 'directory named .lock'])('retains a virtual environment with %s', async kind => {
    fs.appendFileSync(path.join(lead, '.git/info/exclude'), '.venv\n')
    const t = setup()
    put(worker, '.venv/pyvenv.cfg', 'home = /python/bin\nversion = 3.12.0\n')
    put(worker, '.venv/bin/python', 'interpreter')
    if (kind === 'unknown file') put(worker, '.venv/notes.txt', 'keep this')
    if (kind === 'file named share') put(worker, '.venv/share', 'keep this')
    if (kind === 'directory named .lock') put(worker, '.venv/.lock/state', 'keep this')
    if (kind === 'missing interpreter') fs.unlinkSync(path.join(worker, '.venv/bin/python'))
    if (kind === 'linked config') {
      fs.renameSync(path.join(worker, '.venv/pyvenv.cfg'), path.join(root, 'pyvenv.cfg'))
      fs.symlinkSync(path.join(root, 'pyvenv.cfg'), path.join(worker, '.venv/pyvenv.cfg'))
    }
    if (kind === 'linked directory') {
      fs.renameSync(path.join(worker, '.venv'), path.join(root, 'external-env'))
      fs.symlinkSync(path.join(root, 'external-env'), path.join(worker, '.venv'))
    }
    expect(await ignoredWorkerArtifacts(t.w)).not.toEqual([])
  })

  it('names a worktree server before the worker host exits during collect', async () => {
    const t = setup()
    t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'file.txt', 'worker edit\n')
    const child = await startWorktreeProcess()
    let live = true
    t.state.workerAlive = () => live
    t.state.ctx = { listCwdProcesses: () => [{ pid: child.pid!, cwd: worker, command: 'node' }], sleep: async () => { child.kill('SIGTERM'); live = false } } as never
    try {
      const reply = await t.call({ tag: 'test' })
      expect(reply).toMatch(new RegExp(`stopped processes from test: [^\\n]+ \\(pid ${child.pid}\\)`))
    } finally { child.kill('SIGKILL') }
  })

  it('names a worktree server before dismissing the host during discard', async () => {
    const t = setup('running')
    put(worker, 'file.txt', 'worker edit\n')
    const child = await startWorktreeProcess()
    t.state.ctx.listCwdProcesses = () => [{ pid: child.pid!, cwd: worker, command: 'node' }]
    let live = true
    t.state.workerAlive = () => live
    t.state.dismissWorker = async () => { child.kill('SIGTERM'); live = false; return 'worker signalled' }
    try {
      const reply = await t.call({ tag: 'test', discard: true })
      expect(reply).toMatch(new RegExp(`stopped processes: [^\\n]+ \\(pid ${child.pid}\\)`))
    } finally { child.kill('SIGKILL') }
  })

  it('discards ignored output from a retired collected worker with force', async () => {
    const t = setup()
    t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'new.txt', 'worker change')
    put(worker, 'artifact.bin', 'ignored output')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test: new.txt')
    expect(workerByTag(lead, 'test')).toBeUndefined()
    expect(await t.call({ tag: 'test', discard: true })).toContain('discard refused; ignored artifacts')
    expect(fs.existsSync(worker)).toBe(true)
    expect(await t.call({ tag: 'test', discard: true, force: true })).toContain('discarded test')
    expect(fs.existsSync(worker)).toBe(false)
    expect(t.s.room.retiredWorkers()[0].keptWorktree).toBeUndefined()
    expectRetired(t)
  }, 30_000)

  it('refuses, then force-discards, a worker whose carried path lies under an ignored directory', async () => {
    // Live (databricks, 2026-09-28): force=true failed in `git add -A` because a carried path sat under data/raw/.
    const t = setup('failed')
    put(worker, 'data/raw/static/stops.csv', 'id\n1\n')
    const sha = git(worker, 'hash-object', 'data/raw/static/stops.csv')
    t.set('test', { ...t.w, status: 'failed', carriedUntracked: [{ path: 'data/raw/static/stops.csv', sha, mode: 0o644 }] })
    put(worker, '.gitignore', 'artifact.bin\nnode_modules/\n.room/\ndata/raw/\n.venv/\ndata/tmp/\n')
    put(worker, '.venv/bin/python', 'x'); put(worker, 'data/tmp/scratch.parquet', 'y'); put(worker, 'file.txt', 'worker edit\n')
    const refused = await t.call({ tag: 'test', discard: true })
    expect(refused).toMatch(/^error: discard refused; ignored artifacts not covered by a recovery patch: .*\.venv\/.*data\/tmp\//)
    expect(fs.existsSync(path.join(lead, '.room', 'discarded'))).toBe(false)
    expect(fs.existsSync(worker)).toBe(true)
    const forced = await t.call({ tag: 'test', discard: true, force: true })
    expect(forced).toMatch(/^discarded test; recovery patch: \S+\.patch \(kept for a week\); deleted without a copy: .*\.venv\/.*data\/tmp\//)
    const patch = fs.readFileSync(forced.match(/recovery patch: (\S+\.patch)/)![1], 'utf8')
    expect(patch.match(/^diff --git .*$/gm)).toEqual(['diff --git a/.gitignore b/.gitignore', 'diff --git a/file.txt b/file.txt'])
    expect(fs.existsSync(worker)).toBe(false)
  })

  it('refuses to forget a kept worktree that is no longer an owned Room worktree', async () => {
    const t = setup()
    t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'new.txt', 'worker change')
    put(worker, 'artifact.bin', 'ignored output')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test: new.txt')
    expect(t.s.room.retiredWorkers()[0].keptWorktree).toBe(worker)
    git(worker, 'checkout', '-qb', 'elsewhere')
    expect(await t.call({ tag: 'test', discard: true, force: true })).toBe(`error: worker is not an owned Room worktree; retained ${worker}`)
    expect(fs.existsSync(path.join(worker, 'artifact.bin'))).toBe(true)
    expect(t.s.room.retiredWorkers()[0].keptWorktree).toBe(worker)
  })

  it('preflights ignored output before stopping worktree processes', async () => {
    const t = setup('failed')
    put(worker, 'artifact.bin', 'ignored output')
    const child = await startWorktreeProcess()
    t.state.ctx.listCwdProcesses = () => [{ pid: child.pid!, cwd: worker, command: 'node' }]
    try {
      const reply = await t.call({ tag: 'test', discard: true })
      expect(reply).toContain('discard refused; ignored artifacts')
      expect(reply).not.toContain(`pid ${child.pid}`)
      expect(pidAlive(child.pid!)).toBe(true)
      expect(fs.existsSync(worker)).toBe(true)
    } finally { child.kill('SIGKILL') }
  })

  it('discards worker and clears its overlay, claims, scope and presence', async () => {
    const t = setup('failed')
    seedPresence(t)
    expect(await t.call({ tag: 'test', discard: true })).toBe('discarded test')
    expectRetired(t)
  })

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
    expect(localWorkers(lead)).toEqual([]); expect(t.s.room.workerViews.size).toBe(0)
  }, 30_000)

  it('skips a vanished worktree with its reason and still collects the other worker', async () => {
    const t = setup(), other = second(t)
    put(other, 'survived.txt', 'kept')
    fs.rmSync(worker, { recursive: true, force: true })
    const result = await t.call({})
    expect(result).toContain('skipped test: no local worker capability (worktree missing or unmanaged)')
    expect(result).toContain('Changes from second: survived.txt')
    expect(fs.readFileSync(path.join(lead, 'survived.txt'), 'utf8')).toBe('kept')
    expect(workerByTag(lead, 'test')).toBeDefined()
  })

  it.each([false, true])('discards a vanished worktree with merged commits (pruned first: %s)', async pruned => {
    const t = setup()
    seedPresence(t)
    git(lead, 'branch', 'room/og-cards')
    const otherBranch = git(lead, 'rev-parse', 'room/og-cards')
    put(worker, 'landed.txt', 'landed')
    git(worker, 'add', '.'); git(worker, 'commit', '-qm', 'worker work')
    const commit = git(worker, 'rev-parse', 'HEAD')
    git(lead, 'merge', '-q', '--ff-only', commit)
    fs.rmSync(worker, { recursive: true, force: true })
    if (pruned) git(lead, 'worktree', 'prune')
    const reply = await t.call({ tag: 'test', discard: true })
    expect(reply).toContain('discarded test; its worktree was already gone')
    expect(git(lead, 'branch', '--list', 'room/test')).toBe('')
    expect(git(lead, 'rev-parse', 'room/og-cards')).toBe(otherBranch)
    expect(workerByTag(lead, 'test')).toBeUndefined()
  })

  it('removes both worker logs when discarding an already vanished worktree', async () => {
    const t = setup()
    for (const suffix of ['.log', '.mcp.log']) put(lead, `.room/workers/test${suffix}`, 'log')
    fs.rmSync(worker, { recursive: true, force: true })
    expect(await t.call({ tag: 'test', discard: true })).toContain('discarded test; its worktree was already gone')
    expect(fs.existsSync(path.join(lead, '.room/workers/test.log'))).toBe(false)
    expect(fs.existsSync(path.join(lead, '.room/workers/test.mcp.log'))).toBe(false)
    expect(t.s.room.retiredWorkers()).toHaveLength(1)
  })

  it('keeps unmerged branch commits when discarding a vanished worktree', async () => {
    const t = setup()
    seedPresence(t)
    for (const name of ['one', 'two']) {
      put(worker, `${name}.txt`, name)
      git(worker, 'add', '.'); git(worker, 'commit', '-qm', name)
    }
    fs.rmSync(worker, { recursive: true, force: true })
    const reply = await t.call({ tag: 'test', discard: true })
    expect(reply).toContain('discarded test; its worktree was already gone')
    expect(git(lead, 'branch', '--list', 'room/test')).toContain('room/test')
    expect(workerByTag(lead, 'test')).toBeUndefined()
  })

  it('keeps a user commit at the worker base after the lead resets behind it', async () => {
    const t = setup()
    put(lead, 'user.txt', 'user commit')
    git(lead, 'add', 'user.txt'); git(lead, 'commit', '-qm', 'user commit')
    const userCommit = git(lead, 'rev-parse', 'HEAD')
    git(worker, 'merge', '--ff-only', userCommit)
    t.set('test', { ...t.w, base: userCommit })
    git(lead, 'reset', '--hard', 'HEAD^')
    fs.rmSync(worker, { recursive: true, force: true })
    const reply = await t.call({ tag: 'test', discard: true })
    expect(reply).toContain('discarded test; its worktree was already gone')
    expect(git(lead, 'rev-parse', 'room/test')).toBe(userCommit)
  })

  it('deletes a vanished worker branch containing only the carried base', async () => {
    const t = setup()
    put(lead, 'carried.txt', 'lead edit')
    carry(t, worker, 'test', { 'carried.txt': 'lead edit' })
    fs.rmSync(worker, { recursive: true, force: true })
    const reply = await t.call({ tag: 'test', discard: true })
    expect(reply).toContain('discarded test; its worktree was already gone')
    expect(git(lead, 'branch', '--list', 'room/test')).toBe('')
    expect(fs.readFileSync(path.join(lead, 'carried.txt'), 'utf8')).toBe('lead edit')
    expect(workerByTag(lead, 'test')).toBeUndefined()
  })

  it('keeps a vanished worker branch with a commit after the carried base', async () => {
    const t = setup()
    put(lead, 'carried.txt', 'lead edit')
    carry(t, worker, 'test', { 'carried.txt': 'lead edit' })
    put(worker, 'worker.txt', 'worker edit')
    git(worker, 'add', 'worker.txt'); git(worker, 'commit', '-qm', 'worker work')
    const workerCommit = git(worker, 'rev-parse', 'HEAD')
    fs.rmSync(worker, { recursive: true, force: true })
    const reply = await t.call({ tag: 'test', discard: true })
    expect(reply).toContain('discarded test; its worktree was already gone')
    expect(git(lead, 'rev-parse', 'room/test')).toBe(workerCommit)
    expect(workerByTag(lead, 'test')).toBeUndefined()
  })

  it('discards a legacy replacement record when its worktree and branch are already absent', async () => {
    const t = setup()
    useLegacyWorker(t, 'og-sections')
    seedPresence(t)
    fs.rmSync(worker, { recursive: true, force: true })
    git(lead, 'worktree', 'prune')
    git(lead, 'branch', '-D', 'room/og-sections')
    const reply = await t.call({ tag: 'og-sections-2', discard: true })
    expect(reply).toContain('discarded og-sections-2; its worktree was already gone')
    expect(workerByTag(lead, t.w.tag)).toBeUndefined()
  })

  it('keeps commits on a legacy replacement branch after its worktree vanishes', async () => {
    const t = setup()
    useLegacyWorker(t, 'e2e-static')
    seedPresence(t)
    put(worker, 'worker.txt', 'unmerged')
    git(worker, 'add', 'worker.txt'); git(worker, 'commit', '-qm', 'worker work')
    const branchCommit = git(lead, 'rev-parse', 'room/e2e-static')
    fs.rmSync(worker, { recursive: true, force: true })
    git(lead, 'worktree', 'prune')
    const reply = await t.call({ tag: 'e2e-static-2', discard: true })
    expect(reply).toContain('discarded e2e-static-2; its worktree was already gone')
    expect(git(lead, 'rev-parse', 'room/e2e-static')).toBe(branchCommit)
    expect(workerByTag(lead, t.w.tag)).toBeUndefined()
  })

  it('explains that plain collect cannot collect a vanished worktree and leaves its record', async () => {
    const t = setup()
    put(worker, 'not-landed.txt', 'worker commit')
    git(worker, 'add', 'not-landed.txt'); git(worker, 'commit', '-qm', 'worker commit')
    const branchHead = git(lead, 'rev-parse', 'room/test')
    fs.rmSync(worker, { recursive: true, force: true })
    expect(await t.call({ tag: 'test' })).toContain('no local worker capability')
    expect(workerByTag(lead, 'test')).toBeDefined()
    expect(git(lead, 'rev-parse', 'room/test')).toBe(branchHead)
  })

  it('names a missing cwd in the shared git helper error', async () => {
    fs.rmSync(worker, { recursive: true, force: true })
    await expect(roomGit(worker, ['status'])).rejects.toThrow(`worktree ${worker} no longer exists`)
  })

  it('skips one worker with an internal git ls-files error and collects the other', async () => {
    const t = setup(), other = second(t)
    put(worker, 'broken.txt', 'broken'); put(other, 'survived.txt', 'kept')
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nif [ "$1" = ls-files ] && [ "$(pwd)" = "$ROOM_TEST_FAIL_DIR" ]; then echo "injected ls-files error" >&2; exit 3; fi\nexec /usr/bin/git "$@"\n', { mode: 0o755 })
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
    vi.stubEnv('ROOM_TEST_FAIL_DIR', fs.realpathSync(worker))
    let result: string
    try { result = await t.call({}) }
    finally { vi.unstubAllEnvs() }
    expect(result).toContain('skipped test: git ls-files -z failed: injected ls-files error')
    expect(result).toContain('Changes from second: survived.txt')
  }, 30_000)

  it('reports Directory not empty during cleanup and retains the worktree for recovery', async () => {
    const t = setup()
    t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'new.txt', 'worker edit')
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin)
    const marker = path.join(root, 'remove-failed')
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\ncase " $* " in *" worktree remove "*) if [ ! -f "$ROOM_TEST_MARKER" ]; then touch "$ROOM_TEST_MARKER"; echo "Directory not empty" >&2; exit 1; fi;; esac\nexec /usr/bin/git "$@"\n', { mode: 0o755 })
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
    vi.stubEnv('ROOM_TEST_MARKER', marker)
    let result: string
    try { result = await t.call({ tag: 'test' }) }
    finally { vi.unstubAllEnvs() }
    expect(result).toContain('Changes from test: new.txt')
    expect(result).toContain('Directory not empty')
    expect(result).toContain('cleanup incomplete')
    expect(fs.existsSync(worker)).toBe(true)
    expect(t.s.room.retiredWorkers()[0].keptWorktree).toBe(worker)
  })

  it('serializes parallel collects through the worktree lease', async () => {
    const t = setup(), other = second(t)
    put(worker, 'first.txt', 'first'); put(other, 'second.txt', 'second')
    const [first, queued] = await Promise.all([t.call({ tag: 'test' }), t.call({ tag: 'second' })])
    expect(first).toContain('Changes from test: first.txt')
    expect(queued).toContain('Changes from second: second.txt')
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
    t.set('test', { ...t.get('test'), finishedAt: 1 })
    t.set('foreign', { ...t.w, tag: 'foreign', lead: 'someone-else' })
    put(worker, 'a.txt', 'a'); put(other, 'b.txt', 'b')
    expect(await t.call({})).toContain('Changes from second, test:')
    expect(workerByTag(lead, 'foreign')).toBeDefined()
    expect(t.autoRetire).not.toHaveBeenCalled()
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
    const t = setup(); t.set('test', { ...t.w, link: ['data'] })
    put(lead, 'data/input', 'private'); fs.symlinkSync(path.join(lead, 'data'), path.join(worker, 'data'))
    fs.unlinkSync(path.join(worker, 'file.txt')); fs.writeFileSync(path.join(worker, 'binary'), Buffer.from([0, 255, 128, 1]))
    put(worker, 'run.sh', '#!/bin/sh\n'); fs.chmodSync(path.join(worker, 'run.sh'), 0o755)
    expect(await t.call({ tag: 'test' })).toContain('Changes from test:')
    expect(fs.existsSync(path.join(lead, 'file.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(lead, 'binary'))).toEqual(Buffer.from([0, 255, 128, 1]))
    expect(fs.statSync(path.join(lead, 'run.sh')).mode & 0o111).toBe(0o111)
    expect(fs.readFileSync(path.join(lead, 'data/input'), 'utf8')).toBe('private')
  })

  it('collects worker output despite more than 2000 unrelated paths committed by the lead', async () => {
    const t = setup()
    for (let i = 0; i < 2001; i++) put(lead, `unrelated/${i}.txt`, 'committed lead input\n')
    git(lead, 'add', '--', 'unrelated'); git(lead, 'commit', '-qm', 'unrelated lead files')
    const head = git(lead, 'rev-parse', 'HEAD'), index = git(lead, 'write-tree')
    put(worker, 'new.txt', 'worker output\n')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test:')
    expect(fs.readFileSync(path.join(lead, 'new.txt'), 'utf8')).toBe('worker output\n')
    expect(fs.readFileSync(path.join(lead, 'unrelated/2000.txt'), 'utf8')).toBe('committed lead input\n')
    expect(git(lead, 'rev-parse', 'HEAD')).toBe(head); expect(git(lead, 'write-tree')).toBe(index)
    expect(git(lead, 'status', '--porcelain')).toBe('?? new.txt')
  })

  it('skips failed workers without touching their output', async () => {
    const t = setup('failed'); t.set('test', { ...t.w, exitCode: 1 })
    put(worker, 'new.txt', 'new'); expect(await t.call({ tag: 'test' })).toContain('skipped test: failed')
    expect(await t.call({ tag: 'test' })).toContain('exit code 1')
    expect(await t.call({ tag: 'test', force: true })).toContain('skipped test: failed')
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
    t.state.dismissWorker = async () => {
      signalWorker(child.pid!)
      await finishWorker(t.s, 'test', { status: 'dismissed' })
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
      expect(localWorkers(lead)).toEqual([]); expect(t.s.room.workerViews.size).toBe(0); expect(release).toHaveBeenCalled()
      const patchDir = path.join(lead, '.git/room/registry/patches')
      const patches = fs.readdirSync(patchDir)
      expect(patches).toEqual(['w_test.patch'])
      const fresh = path.join(root, 'fresh')
      git(lead, 'worktree', 'add', '--detach', fresh, base)
      git(fresh, 'apply', path.join(patchDir, patches[0]))
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
    expect(result).toContain(`retained worktree: ${worker}`)
    expect(result).toContain(`retained worktree: ${worker}`)
    expect(result).not.toContain('node_modules')
    expect(fs.readFileSync(path.join(worker, 'artifact.bin'), 'utf8')).toBe('generated model')
    expect(workerByTag(lead, 'test')).toBeDefined()
  })

  it('discards regenerable ignored directories without force or an alarming deleted list', async () => {
    const t = setup('failed')
    put(worker, '.gitignore', 'dist/\n')
    put(worker, 'dist/a.js', 'a'); put(worker, 'dist/b.js', 'b')
    const result = await t.call({ tag: 'test', discard: true })
    expect(result).toContain('discarded test')
    expect(result).not.toContain('deleted without a copy')
    expect(fs.existsSync(worker)).toBe(false)
  })

  it('discards a clean failed worker without a patch and prunes old patches and empty folders', async () => {
    const t = setup('failed')
    put(lead, '.git/room/registry/patches/w_old.patch', 'old')
    const old = new Date(Date.now() - 8 * 86400_000)
    fs.utimesSync(path.join(lead, '.git/room/registry/patches/w_old.patch'), old, old)
    put(lead, '.room/workers/test.log', 'log')
    expect(await t.call({ tag: 'test', discard: true })).toBe('discarded test')
    await (await registryForDir(lead)).reconcile()
    expect(fs.existsSync(path.join(lead, '.git/room/registry/patches/w_old.patch'))).toBe(false)
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

  it('cleans successful fully applied workers and their logs', async () => {
    const t = setup(); t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'new.txt', 'new'); put(lead, '.room/workers/test.log', 'log'); put(lead, '.room/workers/test.mcp.log', 'log')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test:')
    expect(fs.existsSync(worker)).toBe(false); expect(git(lead, 'branch', '--list', 'room/test')).toBe('')
    expect(fs.existsSync(path.join(lead, '.room'))).toBe(false)
    expect(t.s.room.retiredWorkers()[0].disposition).toBe('collected')
  })

  it('applies ordinary changes but retains uncopied ignored artifacts and their worktree', async () => {
    const t = setup(); t.set('test', { ...t.w, exitCode: 0 })
    put(worker, 'new.txt', 'new'); put(worker, 'artifact.bin', 'diagnostic output')
    const result = await t.call({ tag: 'test' })
    expect(result).toContain('Changes from test: new.txt')
    expect(result).toContain(`kept artifact.bin at ${path.join(worker, 'artifact.bin')}`)
    expect(result).toContain(`retained worktree: ${worker}`)
    expect(result).not.toContain('cleaned up test')
    expect(fs.readFileSync(path.join(lead, 'new.txt'), 'utf8')).toBe('new')
    expect(fs.readFileSync(path.join(worker, 'artifact.bin'), 'utf8')).toBe('diagnostic output')
    expect(workerByTag(lead, 'test')).toBeUndefined()
    expect(t.s.room.retiredWorkers()[0].summary).toBe(`kept for ignored output at ${worker}`)
    expect(fs.existsSync(worker)).toBe(true)
  })

  it('merges a worker against its carried-in commit: the lead\'s later edits to carried lines survive and only the worker\'s lines land', async () => {
    commitLines()
    const t = setup(); t.set('test', { ...t.w, exitCode: 0 })
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
    const t = setup(); t.set('test', { ...t.w, exitCode: 0 })
    const crlf = (value: string) => value.replace(/\n/g, '\r\n')
    put(lead, 'app.py', crlf(LINES.replace('two', 'W')))
    put(worker, 'app.py', crlf(LINES.replace('two', 'W')))
    git(worker, 'add', 'app.py'); git(worker, 'commit', '-qm', 'room: carried-in uncommitted work from lead')
    const carriedBase = git(worker, 'rev-parse', 'HEAD')
    t.set('test', { ...t.get('test'), base: carriedBase, carriedBase })
    git(lead, 'update-ref', 'refs/room/carry/test', carriedBase)
    put(lead, 'app.py', crlf(LINES.replace('two', 'W2')))
    put(worker, 'new.txt', 'worker output\n')
    const result = await t.call({ tag: 'test' })
    expect(result).toContain('Changes from test: new.txt.')
    expect(fs.readFileSync(path.join(lead, 'app.py'), 'utf8')).toBe(crlf(LINES.replace('two', 'W2')))
  })

  it('does not collect unchanged carried untracked files over later lead edits', async () => {
    const t = setup(); t.set('test', { ...t.w, exitCode: 0 })
    put(lead, 'notes.txt', 'lead draft\n')
    put(worker, 'notes.txt', 'lead draft\n')
    const sha = git(worker, 'hash-object', '-w', 'notes.txt')
    t.set('test', { ...t.get('test'), carriedUntracked: [{ path: 'notes.txt', sha }] })
    put(lead, 'notes.txt', 'lead revised draft\n')
    put(worker, 'new.txt', 'worker output\n')
    const result = await t.call({ tag: 'test' })
    expect(result).toContain('Changes from test: new.txt.')
    expect(fs.readFileSync(path.join(lead, 'notes.txt'), 'utf8')).toBe('lead revised draft\n')
  })

  it('preserves a later lead mode change on an unchanged carried untracked file', async () => {
    const t = setup(); t.set('test', { ...t.w, exitCode: 0 })
    put(lead, 'run.sh', '#!/bin/sh\necho lead\n')
    put(worker, 'run.sh', '#!/bin/sh\necho lead\n')
    const sha = git(worker, 'hash-object', '-w', 'run.sh')
    t.set('test', { ...t.get('test'), carriedUntracked: [{ path: 'run.sh', sha }] })
    fs.chmodSync(path.join(lead, 'run.sh'), 0o755)
    put(worker, 'new.txt', 'worker output\n')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test: new.txt.')
    expect(fs.statSync(path.join(lead, 'run.sh')).mode & 0o777).toBe(0o755)
  })

  it('merges a changed carried untracked file against the lead copy', async () => {
    const t = setup(); t.set('test', { ...t.w, exitCode: 0 })
    put(lead, 'notes.txt', LINES)
    put(worker, 'notes.txt', LINES)
    const sha = git(worker, 'hash-object', '-w', 'notes.txt')
    t.set('test', { ...t.get('test'), carriedUntracked: [{ path: 'notes.txt', sha }] })
    put(lead, 'notes.txt', LINES.replace('two', 'LEAD'))
    put(worker, 'notes.txt', LINES.replace('six', 'WORKER'))
    const result = await t.call({ tag: 'test' })
    expect(result).toContain('Changes from test: notes.txt.')
    expect(fs.readFileSync(path.join(lead, 'notes.txt'), 'utf8')).toBe(LINES.replace('two', 'LEAD').replace('six', 'WORKER'))
  })

  it('refuses a changed carried untracked file when its private base blob is missing', async () => {
    const t = setup(); t.set('test', { ...t.w, exitCode: 0 })
    put(lead, 'notes.txt', 'lead revised\n')
    put(worker, 'notes.txt', 'worker revised\n')
    t.set('test', { ...t.get('test'), carriedUntracked: [{ path: 'notes.txt', sha: 'f'.repeat(40) }] })
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
    t.state.ctx = { listCwdProcesses: () => [], sleep } as HandlerState['ctx']
    t.state.workerAlive = () => at < 10_000
    put(worker, 'new.txt', 'new')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test:')
    expect(sleep).toHaveBeenCalledTimes(40)
    expect(sleep).toHaveBeenCalledWith(250)
  })

  it('uses the confirmed exit record after waiting when cleaning up', async () => {
    const t = setup(); let alive = true
    t.state.workerAlive = () => alive
    t.state.ctx = { listCwdProcesses: () => [], sleep: async () => { alive = false } } as HandlerState['ctx']
    put(worker, 'new.txt', 'new')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test:')
    expect(fs.existsSync(worker)).toBe(false)
  })

  it('bounds the exit wait at 15 seconds and never collects a live process', async () => {
    const t = setup()
    let at = 0
    t.state.now = () => at
    t.state.ctx = { listCwdProcesses: () => [], sleep: async (ms: number) => { at += ms } } as HandlerState['ctx']
    t.state.workerAlive = () => true
    expect(await t.call({ tag: 'test' })).toContain('skipped test: process still exiting after 15 s; call room_collect tag=test again in a few seconds')
    expect(at).toBe(15_000)
    expect(git(worker, 'rev-parse', 'HEAD')).toBe(base)
    expect(await t.call({ tag: 'test', force: true })).toContain('skipped test: process still exiting')
    expect(at).toBe(30_000)
  })

  it('waits for a reported worker whose process is still exiting, then collects it', async () => {
    const { t, tick, elapsed } = await reportedRunning()
    let sleeps = 0
    t.state.ctx = { listCwdProcesses: () => [], sleep: async (ms: number) => { tick(ms); if (++sleeps === 8) await finishWorker(t.s, 'test') } } as HandlerState['ctx']
    put(worker, 'new.txt', 'new')
    expect(await t.call({ tag: 'test' })).toContain('Changes from test:')
    expect(elapsed()).toBe(2_000)
  })

  it('bounds the wait for a reported worker at 15 seconds and says why it skipped', async () => {
    const { t, tick, elapsed } = await reportedRunning()
    t.state.ctx = { listCwdProcesses: () => [], sleep: async (ms: number) => { tick(ms) } } as HandlerState['ctx']
    expect(await t.call({ tag: 'test' })).toContain('skipped test: reported done, but its process is still exiting after 15 s; call room_collect tag=test again in a few seconds')
    expect(elapsed()).toBe(15_000)
    expect(git(worker, 'rev-parse', 'HEAD')).toBe(base)
  })

  it('keeps a worker in room presence if its process is live at final collection', async () => {
    const t = setup()
    put(worker, 'new.txt', 'worker change')
    seedPresence(t)
    let alive = false
    t.state.workerAlive = () => alive
    release.mockImplementationOnce(() => { alive = true })
    expect(await t.call({ tag: 'test' })).toContain('kept test: clean exit not confirmed')
    expect(workerByTag(lead, 'test')).toBeDefined()
    expect(t.s.room.scopes.has(t.w.name)).toBe(true)
    expect(t.s.room.overlays.has(t.w.name)).toBe(true)
    expect(t.s.room.retiredWorkers()).toEqual([])
  })

it('enforces a durable review hold before apply, copy, discard or force and preserves resumable work', async () => {
  const t = setup()
  let reviewer = 'review-thread'
  t.state.ctx.binding = { id: () => reviewer } as NonNullable<typeof t.state.ctx.binding>
  put(worker, 'file.txt', 'reviewed change\n')
  const held = await t.call({ checkpoint: 'hold', reason: 'independent review before collection' })
  expect(held).toContain('hold active')
  reviewer = 'lead-thread'
  for (const args of [{}, { tag: 'test' }, { tag: 'test', keep: true }, { tag: 'test', mode: 'copy', paths: ['file.txt'], force: true }, { tag: 'test', discard: true, force: true }]) {
    expect(await t.call(args)).toContain('held for review')
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('base\n')
    expect(fs.existsSync(worker)).toBe(true)
    expect((await registryForDir(lead)).read((await registryForDir(lead)).list()[0].id)?.phase).not.toBe('retired')
  }
  expect(await t.call({ checkpoint: 'release' })).toContain('no matching review hold')
  expect(await t.call({ checkpoint: 'status' })).toContain('independent review')
  reviewer = 'review-thread'
  expect(await t.call({ checkpoint: 'release' })).toContain('no work collected')
  expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('base\n')
  expect(await t.call({})).not.toContain('error:')
  expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('reviewed change\n')
  expect(fs.existsSync(worker)).toBe(false)
})

it.each([
  { checkpoint: 'hold', reason: 'review', discard: true },
  { checkpoint: 'release', tag: 'test' },
  { checkpoint: 'status', force: false },
  { checkpoint: 'status', keep: true },
  { checkpoint: 'hold', reason: '' },
  { checkpoint: 'hold', reason: 'review', reviewToken: '0'.repeat(64) },
  { checkpoint: 'release', reason: 'review' },
  { checkpoint: 'unknown' },
  { checkpoint: 'hold', reason: 'review', typo: true },
  { reason: 'review' },
  { reviewToken: '0'.repeat(64) },
])('rejects malformed or mixed review requests without collecting: %j', async args => {
  const t = setup()
  put(worker, 'file.txt', 'worker edit\n')
  expect(await t.call(args)).toContain('error:')
  expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('base\n')
  expect(fs.existsSync(worker)).toBe(true)
})
})
