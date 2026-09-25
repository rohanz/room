import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepareWorktree, saveDiscardPatch, persistWorkerStopReason, persistedWorkerStopReason, clearWorkerStopState, defaultSpawner, cleanupWorker } from '../src/workers.js'
import { workerRealState } from '../src/worker-state.js'
import { RoomDoc, type Worker } from '@room/shared'
import { carriedContentHash, carriedPaths, carriedUnchanged, checkoutText, workerBaseline, workerChangedPaths } from '@room/roomd/baseline'
import { gitPathsBetween } from '@room/roomd/git'
import { readRoomFile } from '@room/roomd'
import { GraphIndex } from '../src/graph-index.js'
import { buildCombinedTree } from '../src/tools/combined-tree.js'
import type { HandlerState } from '../src/tools/context.js'
import type { Session } from '../src/session.js'

let root: string
let originalPath: string | undefined
let originalTimeout: string | undefined
const run = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
beforeEach(() => {
  originalPath = process.env.PATH
  originalTimeout = process.env.ROOM_GIT_TIMEOUT_MS
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-carry-clean-')))
  run(root, 'init', '-q', '-b', 'main')
  run(root, 'config', 'user.name', 'Test')
  run(root, 'config', 'user.email', 'test@example.test')
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n')
  run(root, 'add', '.')
  run(root, 'commit', '-qm', 'base')
})
afterEach(() => {
  process.env.PATH = originalPath
  if (originalTimeout === undefined) delete process.env.ROOM_GIT_TIMEOUT_MS
  else process.env.ROOM_GIT_TIMEOUT_MS = originalTimeout
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('carry and discard safety', () => {
  it('honors an explicit empty link list even when .roomlinks exists', async () => {
    fs.writeFileSync(path.join(root, '.roomlinks'), 'data.txt\n')
    fs.writeFileSync(path.join(root, 'data.txt'), 'lead data\n')
    const prepared = await prepareWorktree(root, 'empty-links', 'lead', [])
    expect(fs.readFileSync(path.join(prepared.dir, 'data.txt'), 'utf8')).toBe('lead data\n')
    expect(prepared.carried?.paths).toContain('data.txt')
  })

  it('makes a recovery patch that applies under hostile diff config', async () => {
    const prepared = await prepareWorktree(root, 'hostile', 'lead')
    fs.writeFileSync(path.join(prepared.dir, 'base.txt'), 'worker edit\n')
    run(prepared.dir, 'config', 'color.ui', 'always')
    run(prepared.dir, 'config', 'diff.noprefix', 'true')
    run(prepared.dir, 'config', 'diff.mnemonicprefix', 'true')
    run(prepared.dir, 'config', 'diff.srcPrefix', 'before/')
    run(prepared.dir, 'config', 'diff.dstPrefix', 'after/')
    run(prepared.dir, 'config', 'diff.external', '/bin/false')
    const patch = await saveDiscardPatch(root, { tag: 'hostile', dir: prepared.dir, base: prepared.base, branch: prepared.branch } as Worker)
    expect(patch).toBeTruthy()
    const body = fs.readFileSync(patch!, 'utf8')
    expect(body).toContain('diff --git a/base.txt b/base.txt')
    expect(body).not.toContain('\u001b[')
    const scratch = path.join(root, 'scratch')
    run(root, 'worktree', 'add', '-q', '-b', 'scratch', scratch, prepared.base!)
    run(scratch, 'apply', '--check', patch!)
  })

  it('keeps the worktree when recovery verification cannot apply the patch', async () => {
    const prepared = await prepareWorktree(root, 'unverified', 'lead')
    fs.writeFileSync(path.join(prepared.dir, 'base.txt'), 'worker edit\n')
    const fakeDir = path.join(root, 'reject-apply'); fs.mkdirSync(fakeDir)
    fs.writeFileSync(path.join(fakeDir, 'git'), '#!/bin/sh\nif [ "$1" = "apply" ]; then exit 1; fi\nexec /usr/bin/git "$@"\n', { mode: 0o755 })
    process.env.PATH = fakeDir + path.delimiter + originalPath
    await expect(saveDiscardPatch(root, { tag: 'unverified', dir: prepared.dir, base: prepared.base, branch: prepared.branch } as Worker)).rejects.toThrow()
    expect(fs.readFileSync(path.join(prepared.dir, 'base.txt'), 'utf8')).toBe('worker edit\n')
    expect(fs.existsSync(path.join(prepared.dir, '.git'))).toBe(true)
  })

  it('reports a reconstructed base and recovery location after late cleanup failure', async () => {
    const prepared = await prepareWorktree(root, 'rollback', 'lead')
    fs.writeFileSync(path.join(prepared.dir, 'base.txt'), 'worker edit\n')
    const worker = { tag: 'rollback', dir: prepared.dir, base: prepared.base, branch: prepared.branch,
      status: 'done', exitCode: 0, carriedUntracked: prepared.carriedUntracked } as Worker
    const patch = await saveDiscardPatch(root, worker)
    const record = path.join(root, '.git', 'room-carry', 'rollback.json')
    const realRm = fs.promises.rm.bind(fs.promises)
    vi.spyOn(fs.promises, 'rm').mockImplementation((target, options) => {
      if (String(target) === record) throw new Error('late cleanup failure')
      return realRm(target, options)
    })
    await expect(cleanupWorker(root, worker, true, true)).rejects.toThrow(/reconstructed base.*actual worker edits are in/)
    expect(fs.existsSync(path.join(prepared.dir, '.git'))).toBe(true)
    expect(fs.readFileSync(patch!, 'utf8')).toContain('worker edit')
  })

  it('clears the persisted stop reason after a successful resume', () => {
    persistWorkerStopReason(root, 'later', 'lead-session-ended', 'worker#1')
    expect(persistedWorkerStopReason(root, 'later', 'worker#1')).toBe('lead-session-ended')
    expect(persistedWorkerStopReason(root, 'later', 'worker#2')).toBeUndefined()
    clearWorkerStopState(root, 'later', 'worker#2')
    expect(persistedWorkerStopReason(root, 'later', 'worker#1')).toBe('lead-session-ended')
    clearWorkerStopState(root, 'later', 'worker#1')
    expect(persistedWorkerStopReason(root, 'later')).toBeUndefined()
  })

  it('honours and clears a stop reason recorded without a worker id', () => {
    persistWorkerStopReason(root, 'legacy', 'lead-session-ended')
    expect(persistedWorkerStopReason(root, 'legacy', 'worker#1')).toBe('lead-session-ended')
    clearWorkerStopState(root, 'legacy', 'worker#1')
    expect(persistedWorkerStopReason(root, 'legacy')).toBeUndefined()
  })

  it('counts worker edits against its recorded base and excludes unchanged carried files', async () => {
    fs.writeFileSync(path.join(root, 'lead.txt'), 'lead input\n')
    const prepared = await prepareWorktree(root, 'owned', 'lead')
    const worker = { name: 'lead+owned', tag: 'owned', dir: prepared.dir, branch: prepared.branch, base: prepared.base,
      carriedUntracked: prepared.carriedUntracked, carriedBase: prepared.carriedBase } as Worker
    expect(await workerChangedPaths(worker)).toEqual([])
    fs.unlinkSync(path.join(prepared.dir, 'lead.txt'))
    expect(await workerChangedPaths(worker)).toEqual(['lead.txt'])
    expect(await workerRealState(root, worker, { git: true, leadName: worker.lead })).toMatchObject({ clean: false, uncommitted: 1 })
    fs.writeFileSync(path.join(prepared.dir, 'lead.txt'), 'worker edit\n')
    fs.writeFileSync(path.join(prepared.dir, 'own.txt'), 'own\n')
    expect(await workerChangedPaths(worker)).toEqual(['lead.txt', 'own.txt'])
    run(prepared.dir, 'add', 'own.txt')
    run(prepared.dir, 'commit', '-qm', 'output')
    expect(await workerChangedPaths(worker)).toEqual(['lead.txt', 'own.txt'])
  })

  it('times out a hanging hash filter and leaves carried ownership unknown', async () => {
    fs.writeFileSync(path.join(root, 'lead.txt'), 'lead input\n')
    const prepared = await prepareWorktree(root, 'timeout', 'lead')
    const worker = { name: 'lead+timeout', tag: 'timeout', dir: prepared.dir, branch: prepared.branch, base: prepared.base,
      carriedUntracked: prepared.carriedUntracked } as Worker
    const fakeDir = path.join(root, 'fakebin'); fs.mkdirSync(fakeDir)
    const realGit = run(root, '--exec-path').replace(/\/libexec\/git-core$/, '/bin/git')
    const gitPath = fs.existsSync('/usr/bin/git') ? '/usr/bin/git' : realGit
    fs.writeFileSync(path.join(fakeDir, 'git'), `#!/bin/sh\nif [ "$1" = "hash-object" ]; then sleep 2; fi\nexec ${JSON.stringify(gitPath)} "$@"\n`, { mode: 0o755 })
    process.env.PATH = fakeDir + path.delimiter + originalPath
    process.env.ROOM_GIT_TIMEOUT_MS = '100'
    expect(() => carriedContentHash(prepared.dir, 'lead.txt')).toThrow(/timed out/)
    expect(() => carriedUnchanged(workerBaseline(worker)!, 'lead.txt')).toThrow(/timed out/)
  })

  it('starts a worker from HEAD and reports failure when carry hashing times out', async () => {
    fs.writeFileSync(path.join(root, 'lead.txt'), 'lead input\n')
    const head = run(root, 'rev-parse', 'HEAD')
    const fakeDir = path.join(root, '.git', 'slow-carry'); fs.mkdirSync(fakeDir)
    fs.writeFileSync(path.join(fakeDir, 'git'), '#!/bin/sh\ncase " $* " in *" hash-object "*) sleep 60;; esac\nexec /usr/bin/git "$@"\n', { mode: 0o755 })
    process.env.PATH = fakeDir + path.delimiter + originalPath
    process.env.ROOM_GIT_TIMEOUT_MS = '5000'
    const prepared = await prepareWorktree(root, 'timed-carry', 'lead')
    expect(prepared.carryFailed).toBe(true)
    expect(prepared.carryError).toMatch(/timed out/)
    expect(prepared.base).toBe(head)
    expect(fs.existsSync(path.join(prepared.dir, 'lead.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(root, 'lead.txt'), 'utf8')).toBe('lead input\n')
  }, 15000)

  it('reports a timeout during carry stability checking as carry failure', async () => {
    fs.writeFileSync(path.join(root, 'lead.txt'), 'lead input\n')
    const fakeDir = path.join(root, '.git', 'slow-stability'); fs.mkdirSync(fakeDir)
    const marker = path.join(fakeDir, 'first-hash')
    const calls = path.join(fakeDir, 'calls')
    fs.writeFileSync(path.join(fakeDir, 'git'), `#!/bin/sh\nif [ "$1" = "hash-object" ]; then echo x >> ${JSON.stringify(calls)}; if [ -e ${JSON.stringify(marker)} ]; then sleep 60; else touch ${JSON.stringify(marker)}; fi; fi\nexec /usr/bin/git "$@"\n`, { mode: 0o755 })
    process.env.PATH = fakeDir + path.delimiter + originalPath
    process.env.ROOM_GIT_TIMEOUT_MS = '5000'
    const prepared = await prepareWorktree(root, 'timed-stability', 'lead')
    expect(prepared.carryFailed).toBe(true)
    expect(prepared.carryError).toMatch(/timed out/)
    expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2)
  }, 15000)

  it('bounds a hanging checkout filter read', async () => {
    const fakeDir = path.join(root, 'slow-checkout'); fs.mkdirSync(fakeDir)
    fs.writeFileSync(path.join(fakeDir, 'git'), '#!/bin/sh\nif [ "$1" = "cat-file" ]; then sleep 2; fi\nexec /usr/bin/git "$@"\n', { mode: 0o755 })
    process.env.PATH = fakeDir + path.delimiter + originalPath
    process.env.ROOM_GIT_TIMEOUT_MS = '100'
    await expect(checkoutText(root, run(root, 'rev-parse', 'HEAD') + ':base.txt', 'base.txt')).rejects.toThrow(/timed out/)
  })

  it('reports a timed-out room metadata Git lookup', () => {
    const fakeDir = path.join(root, 'slow-room-file'); fs.mkdirSync(fakeDir)
    fs.writeFileSync(path.join(fakeDir, 'git'), '#!/bin/sh\nsleep 2\nexec /usr/bin/git "$@"\n', { mode: 0o755 })
    process.env.PATH = fakeDir + path.delimiter + originalPath
    process.env.ROOM_GIT_TIMEOUT_MS = '100'
    expect(() => readRoomFile(root)).toThrow(/timed out/)
  })

  it('round-trips tabs, newlines, and quotes in machine-read path lists', async () => {
    const before = run(root, 'rev-parse', 'HEAD')
    const names = ['tab\tname.txt', 'line\nbreak.txt', 'quote"name.txt']
    for (const name of names) fs.writeFileSync(path.join(root, name), name)
    run(root, 'add', '-A'); run(root, 'commit', '-qm', 'odd names')
    expect(await gitPathsBetween(root, before, run(root, 'rev-parse', 'HEAD'))).toEqual(names.sort())
  })

  it('indexes a source path containing a newline from the base tree', async () => {
    const odd = 'line\nbreak.py'
    fs.writeFileSync(path.join(root, odd), 'def odd():\n    return 1\n')
    run(root, 'add', '-A'); run(root, 'commit', '-qm', 'odd source')
    const room = new RoomDoc(); room.setMeta({ base: run(root, 'rev-parse', 'HEAD') })
    const graph = new GraphIndex(room, 'lead', root, undefined, { random: () => 0, minPublishMs: 0 })
    try { graph.start(); await graph.whenIdle(); expect(graph.graph.has(odd)).toBe(true) }
    finally { graph.stop(); room.doc.destroy() }
  })

  it('keeps an unusual filename from a participant base difference in preview', async () => {
    const a = run(root, 'rev-parse', 'HEAD')
    const branchDir = path.join(root, 'branch-worktree')
    run(root, 'worktree', 'add', '-q', '-b', 'odd-paths', branchDir, a)
    const odd = 'tab\tline\nquote".txt'
    fs.writeFileSync(path.join(branchDir, odd), 'participant\n')
    run(branchDir, 'add', '-A'); run(branchDir, 'commit', '-qm', 'odd path')
    const b = run(branchDir, 'rev-parse', 'HEAD')
    const room = new RoomDoc(); room.setMeta({ base: a })
    const caller = { me: { name: 'lead' }, dir: root, room, local: false } as Session
    const participant = { me: { name: 'peer' }, dir: branchDir, room, local: false } as Session
    const state = { rooms: { holding: () => participant }, liveText: async () => undefined,
      baseFor: (_s: Session, person: string) => person === 'peer' ? b : a, shareOf: () => 'full' } as unknown as HandlerState
    const preview = await buildCombinedTree(state, caller, [{ person: 'peer', session: participant }])
    expect(preview.paths).toContain(odd)
    room.doc.destroy()
  })

  it('reports degraded contract coverage when a carried baseline blob is unavailable', async () => {
    const base = run(root, 'rev-parse', 'HEAD')
    const room = new RoomDoc(); room.setMeta({ base })
    room.setWorker({ id: 'lead/w#1', tag: 'w', name: 'lead+w', host: 'codex', task: 't', dir: root,
      branch: 'room/w', base, pid: 1, startedAt: 1, status: 'running', lead: 'lead',
      carriedUntracked: [{ path: 'api.py', sha: '1'.repeat(40) }] } as Worker)
    room.setOverlay('lead+w', 'api.py', 'def rate(x, year):\n    return x\n')
    const logs: string[] = []
    const graph = new GraphIndex(room, 'lead+w', root, line => logs.push(line), { random: () => 0, minPublishMs: 0 })
    try {
      graph.start(); await graph.whenIdle()
      await vi.waitFor(() => expect(room.graphs.get('lead+w')?.status).toBe('error'))
      expect(room.graphs.get('lead+w')?.observed).toEqual([])
      expect(logs.join('\n')).toContain('coverage degraded')
    } finally { graph.stop(); room.doc.destroy() }
  })

  it('retries a transient committed-path lookup failure', async () => {
    fs.writeFileSync(path.join(root, 'base.txt'), 'lead change\n')
    const prepared = await prepareWorktree(root, 'retry-cache', 'lead')
    const worker = { name: 'lead+retry-cache', dir: prepared.dir, base: prepared.base, carriedBase: prepared.carriedBase } as Worker
    const baseline = workerBaseline(worker)!
    const fakeDir = path.join(root, 'fail-once'); fs.mkdirSync(fakeDir)
    const marker = path.join(fakeDir, 'failed')
    fs.writeFileSync(path.join(fakeDir, 'git'), `#!/bin/sh\nif [ "$1" = "diff-tree" ] && [ ! -e ${JSON.stringify(marker)} ]; then touch ${JSON.stringify(marker)}; exit 1; fi\nexec /usr/bin/git "$@"\n`, { mode: 0o755 })
    process.env.PATH = fakeDir + path.delimiter + originalPath
    await expect(carriedPaths(baseline)).rejects.toThrow()
    await expect(carriedPaths(baseline)).resolves.toContain('base.txt')
  })

  it('does not let a Codex log write error escape the stdout callback', async () => {
    const realWrite = fs.writeSync.bind(fs)
    vi.spyOn(fs, 'writeSync').mockImplementation((...args: Parameters<typeof fs.writeSync>) => {
      if (typeof args[1] !== 'string' && Buffer.isBuffer(args[1])) throw new Error('disk full')
      return realWrite(...args)
    })
    const id = '12345678-1234-1234-1234-123456789abc'
    const proc = defaultSpawner({ cmd: process.execPath, args: ['-e', `process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'${id}'})+'\\n')`],
      cwd: root, env: {}, logFile: path.join(root, 'worker.log'), captureCodexSession: true })
    const found = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('session ID lost after log write error')), 2000)
      proc.onSessionId?.(value => { clearTimeout(timer); resolve(value) })
    })
    expect(found).toBe(id)
  })
})
