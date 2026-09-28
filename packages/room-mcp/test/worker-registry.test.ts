import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import * as Y from 'yjs'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkerRegistry } from '../src/worker-registry.js'
import { idleClaimsDue, type WorkerRecord } from '../src/worker-status.js'
import { RoomDoc } from '@room/shared'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const openRegistry = (dir: string, options: Parameters<typeof WorkerRegistry.open>[1] = {}) => WorkerRegistry.open(dir, { ...options, watch: false })
const token = { pid: 31, startTime: 'start', executable: '/bin/agent', sessionId: 's', nonce: 'n' }
const intent = (): WorkerRecord => ({
  v: 1, id: 'w_01', tag: 'tests', name: 'lead+tests', mode: 'local', room: 'local/repo',
  lead: { participant: 'lead', room: 'local/repo', instance: token }, host: 'codex',
  budget: { threads: 1, memGb: 1, nice: 10 }, share: 'declared', task: 'tests',
  dir: '/tmp/repo/.room/workers/tests', outside: false, branch: 'room/tests', prep: { step: 'prepared' },
  capabilities: { resume: true, signal: true, collect: 'delta' }, phase: 'prepared',
  runs: [{ n: 1, mode: 'fresh', intentAt: 1, nonce: 'launch-nonce', busFrontier: [], promptMsgIds: [], launcher: token, logStart: 0 }],
  createdAt: 1, seq: 1,
})
function common(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-registry-')); dirs.push(dir); return dir }

describe('WorkerRegistry durable store', () => {
  it('reopens a written intent and reconciles a dead launcher to ambiguous without relaunch', () => {
    const dir = common()
    const first = openRegistry(dir, { liveness: () => 'alive', migrate: false })
    first.writeIntent(intent())
    expect(fs.existsSync(path.join(dir, 'room', 'registry', 'workers', 'w_01.op'))).toBe(true)
    const reopened = openRegistry(dir, { liveness: () => 'dead', migrate: false })
    expect(reopened.read('w_01')?.runs[0].launch).toEqual({ outcome: 'ambiguous', at: expect.any(Number) })
    expect(reopened.status('w_01')?.status).toBe('ambiguous')
    reopened.reconcile()
    expect(reopened.read('w_01')?.runs).toHaveLength(1)
    expect(reopened.status('w_01')?.status).toBe('ambiguous')
  })

  it('does not let a second live instance mutate a worker under the operation lease', () => {
    const dir = common()
    const first = openRegistry(dir, { liveness: () => 'alive', migrate: false, identity: token })
    first.writeIntent(intent())
    const other = openRegistry(dir, { liveness: () => 'alive', migrate: false,
      identity: { ...token, nonce: 'other' } })
    expect(() => other.update('w_01', r => ({ ...r, seq: r.seq + 1 }))).toThrow(/operation lease/)
  })

  it('accepts a matching run-writer handoff after an ambiguous launch', () => {
    const dir = common()
    const store = openRegistry(dir, { liveness: () => 'dead', migrate: false })
    store.writeIntent(intent())
    store.reconcile()
    store.writeReport('w_01', { run: 1, nonce: 'launch-nonce', chain: [{ pid: 42, startTime: 'born', executable: '/bin/codex' }], joinedAt: 4 })
    store.reconcile()
    expect(store.read('w_01')?.runs[0].launch).toMatchObject({ outcome: 'launched', pid: 42 })
    expect(store.read('w_01')?.phase).toBe('active')
  })

  it('lets a restarted writer of the same host session retain a done report', () => {
    const dir = common(), firstToken = { ...token, sessionId: 'worker-session', nonce: 'old' }
    const first = openRegistry(dir, { migrate: false, liveness: () => 'alive', identity: firstToken })
    first.writeIntent(intent())
    first.writeReport('w_01', { run: 1, nonce: 'launch-nonce', chain: [], joinedAt: 3,
      done: { at: 4, summary: 'finished', changed: ['a.ts'] } })
    const restarted = openRegistry(dir, { migrate: false, liveness: () => 'dead',
      identity: { ...firstToken, nonce: 'new' } })
    restarted.writeReport('w_01', { run: 1, nonce: 'launch-nonce', chain: [], joinedAt: 5 })
    expect(restarted.reports('w_01')[0].done?.summary).toBe('finished')
  })

  it('adds posted after done and preserves the first chain and host session through restart (S2)', () => {
    const dir = common(), identity = { ...token, sessionId: 'worker-session', nonce: 'old' }
    const first = openRegistry(dir, { migrate: false, identity })
    first.writeIntent(intent())
    const chain = [{ pid: 42, startTime: 'born', executable: '/bin/codex' }]
    first.writeReport('w_01', { run: 1, nonce: 'launch-nonce', chain, joinedAt: 3, hostSessionId: 'host-1' })
    const restarted = openRegistry(dir, { migrate: false, liveness: () => 'dead', identity: { ...identity, nonce: 'new' } })
    restarted.writeReport('w_01', { run: 1, nonce: 'launch-nonce', chain: [], joinedAt: 5, hostSessionId: 'host-2',
      done: { at: 6, summary: 'finished', changed: ['a.ts'] } })
    restarted.writeReport('w_01', { run: 1, nonce: 'launch-nonce', chain: [], joinedAt: 7, posted: 'wk:w_01:1' })
    expect(restarted.reports('w_01')[0]).toMatchObject({ chain, joinedAt: 3, hostSessionId: 'host-1',
      done: { at: 6, summary: 'finished' }, posted: 'wk:w_01:1' })
  })

  it('notifies subscribers of another registry’s record, report, and exit writes (M4)', () => {
    const dir = common(), a = openRegistry(dir, { migrate: false, liveness: () => 'alive' }),
      b = openRegistry(dir, { migrate: false, liveness: () => 'alive' })
    let changes = 0
    a.onChange(() => { changes++ })
    b.writeIntent(intent())
    a.reconcile()
    expect(changes).toBeGreaterThan(0)
    const workerFile = path.join(dir, 'room', 'registry', 'workers', 'w_01.json')
    const launched = b.read('w_01')!
    launched.runs[0].launch = { outcome: 'launched', pid: 42 }
    fs.writeFileSync(workerFile, JSON.stringify(launched))
    a.reconcile()
    const afterRecord = changes
    b.writeReport('w_01', { run: 1, nonce: 'launch-nonce', chain: [], joinedAt: 2,
      done: { at: 3, summary: 'done', changed: [] } })
    a.reconcile()
    expect(changes).toBeGreaterThan(afterRecord)
    const afterReport = changes
    b.writeExit('w_01', { run: 1, code: 0, at: 4, witnessed: true })
    a.reconcile()
    expect(changes).toBeGreaterThan(afterReport)
  })

  it('reuses an abandoned or fully cleaned retired tag, but keeps a retired worktree reserved (M5)', () => {
    for (const phase of ['abandoned', 'retired'] as const) {
      const dir = common(), store = openRegistry(dir, { migrate: false })
      store.writeIntent({ ...intent(), phase, ...(phase === 'retired' ? { cleanup: { 'local/repo': 'done' } } : {}) })
      store.writeIntent({ ...intent(), id: 'w_02' })
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'room', 'registry', 'tags', 'tests.json'), 'utf8')).id).toBe('w_02')
    }
    const dir = common(), store = openRegistry(dir, { migrate: false })
    store.writeIntent({ ...intent(), phase: 'retired', cleanup: { 'local/repo': 'done' }, keptWorktree: '/tmp/kept' })
    expect(() => store.writeIntent({ ...intent(), id: 'w_02' })).toThrow(/tag in use/)
  })

  it('keeps a witnessed exit over later polling, and upgrades an unwitnessed exit', () => {
    const store = openRegistry(common(), { migrate: false })
    store.writeIntent(intent())
    store.writeExit('w_01', { run: 1, code: null, at: 3, witnessed: false })
    store.writeExit('w_01', { run: 1, code: 7, at: 4, witnessed: true })
    store.writeExit('w_01', { run: 1, code: null, at: 5, witnessed: false })
    expect(store.exits('w_01')).toEqual([{ run: 1, code: 7, at: 4, witnessed: true }])
  })

  it('counts ambiguous intents against capacity across reopened registries', () => {
    const dir = common()
    const first = openRegistry(dir, { liveness: () => 'dead', migrate: false })
    first.writeIntent(intent(), 1)
    const second = openRegistry(dir, { liveness: () => 'dead', migrate: false })
    expect(second.occupancy()).toBe(1)
    expect(() => second.writeIntent({ ...intent(), id: 'w_02', tag: 'more', name: 'lead+more' }, 1)).toThrow(/capacity/)
  })

  it('recovers a dead orphan tag reservation without authorizing a missing record', () => {
    const dir = common(), registry = openRegistry(dir, { liveness: () => 'dead', migrate: false })
    const tag = path.join(dir, 'room', 'registry', 'tags', 'tests.json')
    fs.mkdirSync(path.dirname(tag), { recursive: true })
    fs.writeFileSync(tag, JSON.stringify({ id: 'w_lost', holder: token, at: 1 }))
    registry.writeIntent(intent())
    expect(registry.read('w_01')).toBeDefined()
    expect(JSON.parse(fs.readFileSync(tag, 'utf8')).id).toBe('w_01')
  })

  it('resumes a partially written migration map with the same worker id', () => {
    const dir = common()
    const source = { key: 'legacy:tests', tag: 'tests', name: 'lead+tests', lead: 'lead', room: 'local/repo', dir: '/tmp/repo/.room/workers/tests', branch: 'room/tests', host: 'codex' as const }
    const file = path.join(dir, 'room', 'registry', 'migration.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ v: 1, sources: { [source.key]: { id: 'w_mapped', state: 'assigned' } }, done: false }))
    const store = openRegistry(dir, { liveness: () => 'dead', sources: () => [source] })
    expect(store.read('w_mapped')?.runs[0].launch).toEqual({ outcome: 'imported' })
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).sources[source.key]).toEqual({ id: 'w_mapped', state: 'imported' })
    expect(openRegistry(dir, { liveness: () => 'dead', sources: () => [source] }).list()).toHaveLength(1)
  })

  it('lets a second process open after the first completes the migration barrier', async () => {
    const dir = common()
    const source = `import { WorkerRegistry } from ${JSON.stringify(new URL('../src/worker-registry.ts', import.meta.url).href)};
      WorkerRegistry.open(process.argv[1], { watch: false, sources: () => {
        if (process.argv[2] === 'pause') { process.stdout.write('inside\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200) }
        return []
      } }); process.stdout.write('done\\n')`
    const launch = (mode: string) => spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, dir, mode],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
    const first = launch('pause')
    let firstOutput = '', firstError = ''
    first.stdout.on('data', chunk => { firstOutput += chunk.toString() })
    first.stderr.on('data', chunk => { firstError += chunk.toString() })
    while (!firstOutput.includes('inside') && first.exitCode === null) await new Promise(resolve => setTimeout(resolve, 10))
    expect(firstOutput).toContain('inside')
    const second = launch('plain')
    let secondOutput = '', secondError = ''
    second.stdout.on('data', chunk => { secondOutput += chunk.toString() })
    second.stderr.on('data', chunk => { secondError += chunk.toString() })
    const [[firstCode], [secondCode]] = await Promise.all([once(first, 'exit'), once(second, 'exit')])
    expect(firstCode, firstError).toBe(0)
    expect(secondCode, secondError).toBe(0)
    expect(secondOutput).toContain('done')
    expect(openRegistry(dir).list()).toEqual([])
  }, 15_000)

  it('discovers an owned legacy Git worktree as imported and copy-only', async () => {
    const dir = common()
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
    fs.writeFileSync(path.join(dir, 'README.md'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base')
    const workerDir = path.join(dir, '.room', 'workers', 'tests')
    fs.mkdirSync(path.dirname(workerDir), { recursive: true })
    git('worktree', 'add', '-qb', 'room/tests', workerDir)
    const commonDir = git('rev-parse', '--git-common-dir')
    const store = openRegistry(path.resolve(dir, commonDir))
    const imported = store.list()[0]
    expect(imported).toMatchObject({ tag: 'tests', branch: 'room/tests', phase: 'active',
      capabilities: { signal: false, resume: false, collect: 'copy' } })
    expect(store.status(imported.id)?.status).toBe('imported')
    expect(imported.legacy?.unowned).toBe(true)
    expect(imported.lead.participant).toBe('')
    expect((await store.trusted({ participant: 'rohanz', room: 'local/repo', dir }, 'tests'))?.record.id).toBe(imported.id)
    expect(store.read(imported.id)).toMatchObject({ name: 'rohanz+tests', lead: { participant: 'rohanz', room: 'local/repo' } })
    expect(await store.trusted({ participant: 'another', room: 'local/repo', dir }, 'tests')).toBeUndefined()
    expect((await openRegistry(path.resolve(dir, commonDir)).trusted({ participant: 'rohanz', room: 'local/repo', dir }, 'tests'))?.record.id).toBe(imported.id)
  })

  it('discovers a nested legacy worker for its actual parent checkout, not its directory name (M3)', async () => {
    const dir = common()
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
    fs.writeFileSync(path.join(dir, 'README.md'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base')
    const parent = path.join(dir, '.room', 'workers', 'parent')
    const child = path.join(parent, '.room', 'workers', 'child')
    fs.mkdirSync(path.dirname(parent), { recursive: true })
    git('worktree', 'add', '-qb', 'room/parent', parent)
    fs.mkdirSync(path.dirname(child), { recursive: true })
    git('worktree', 'add', '-qb', 'room/child', child)
    const store = openRegistry(path.resolve(dir, git('rev-parse', '--git-common-dir')))
    expect(store.list().map(record => record.tag).sort()).toEqual(['child', 'parent'])
    const adopted = await store.trusted({ participant: 'real-parent', room: 'local/repo', dir: parent }, 'child')
    expect(adopted?.record).toMatchObject({ name: 'real-parent+child', lead: { participant: 'real-parent' } })
  })

  it('imports only locally verified carry and session capabilities from a legacy snapshot', () => {
    const dir = common()
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
    fs.writeFileSync(path.join(dir, 'README.md'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base')
    const workerDir = path.join(dir, '.room', 'workers', 'tests')
    fs.mkdirSync(path.dirname(workerDir), { recursive: true })
    git('worktree', 'add', '-qb', 'room/tests', workerDir)
    const commonDir = path.resolve(dir, git('rev-parse', '--git-common-dir'))
    const oldId = 'lead/tests#1'
    const old = new RoomDoc()
    old.setWorker({ id: oldId, tag: 'tests', name: 'lead+tests', lead: 'lead', host: 'claude', task: 'old task',
      dir: workerDir, branch: 'room/tests', pid: 1, startedAt: 1, status: 'done', summary: 'old summary' })
    const snapshotDir = path.join(commonDir, 'room-local')
    fs.mkdirSync(snapshotDir, { recursive: true })
    fs.writeFileSync(path.join(snapshotDir, `${encodeURIComponent('local/repo/main')}.ydoc`), Y.encodeStateAsUpdate(old.doc))
    old.doc.destroy()
    const carry = path.join(commonDir, 'room-carry', 'tests.json')
    fs.mkdirSync(path.dirname(carry), { recursive: true })
    fs.writeFileSync(carry, JSON.stringify({ base: git('rev-parse', 'HEAD') }))
    const workerGitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: workerDir, encoding: 'utf8' }).trim()
    fs.writeFileSync(path.join(workerGitDir, 'room-session.json'), JSON.stringify({ worker_id: oldId, host: 'claude', session_id: 'session-1' }))
    const store = openRegistry(commonDir)
    expect(store.list()[0]).toMatchObject({ host: 'claude', task: 'old task', legacy: { said: 'old summary' },
      hostSessionId: 'session-1', capabilities: { resume: true, signal: false, collect: 'delta' } })
    expect(store.list()[0].lead.participant).toBe('')
    expect(fs.existsSync(carry)).toBe(false)
    expect(fs.existsSync(`${carry}.migrated`)).toBe(true)
  })

  it('rolls back only a dead launcher’s journaled new worktree and marks it abandoned', () => {
    const dir = common()
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
    fs.writeFileSync(path.join(dir, 'README.md'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base')
    const workerDir = path.join(dir, '.room', 'workers', 'tests')
    fs.mkdirSync(path.dirname(workerDir), { recursive: true })
    git('worktree', 'add', '-qb', 'room/tests', workerDir)
    const commonDir = path.resolve(dir, git('rev-parse', '--git-common-dir'))
    const store = openRegistry(commonDir, { migrate: false, liveness: () => 'alive' })
    store.writeIntent({ ...intent(), dir: workerDir, phase: 'preparing', prep: {
      step: 'worktree', worktreeExisted: false, branchExisted: false, created: true, branchCreated: true,
      previousCarryRefs: {},
    } })
    const restarted = openRegistry(commonDir, { migrate: false, liveness: () => 'dead' })
    expect(restarted.read('w_01')?.phase).toBe('abandoned')
    expect(fs.existsSync(workerDir)).toBe(false)
    expect(git('branch', '--list', 'room/tests')).toBe('')
    restarted.writeIntent({ ...intent(), id: 'w_02' })
    expect(restarted.read('w_02')).toBeDefined()
  })

  it('marks an interrupted collect without claiming that a partial apply was undone', () => {
    const dir = common(), store = openRegistry(dir, { migrate: false, liveness: () => 'alive' })
    store.writeIntent({ ...intent(), phase: 'collecting' })
    const reopened = openRegistry(dir, { migrate: false, liveness: () => 'dead' })
    expect(reopened.read('w_01')).toMatchObject({ phase: 'active', interrupted: { op: 'collect' } })
  })

  it('quarantines a corrupt worker record and keeps its tag reserved', () => {
    const dir = common(), store = openRegistry(dir, { migrate: false })
    store.writeIntent(intent())
    const file = path.join(dir, 'room', 'registry', 'workers', 'w_01.json')
    fs.writeFileSync(file, '{not-json')
    const reopened = openRegistry(dir, { migrate: false })
    expect(reopened.list()).toEqual([])
    expect(fs.readdirSync(path.join(dir, 'room', 'registry', 'quarantine'))).toHaveLength(1)
    expect(fs.existsSync(path.join(dir, 'room', 'registry', 'tags', 'tests.json'))).toBe(true)
    expect(() => reopened.writeIntent({ ...intent(), id: 'w_02' })).toThrow(/tag in use/)
  })

  it('quarantines structurally corrupt records without aborting healthy recovery (S4)', () => {
    const dir = common(), store = openRegistry(dir, { migrate: false })
    store.writeIntent(intent())
    store.writeIntent({ ...intent(), id: 'w_02', tag: 'healthy', name: 'lead+healthy' })
    const file = path.join(dir, 'room', 'registry', 'workers', 'w_01.json')
    fs.writeFileSync(file, JSON.stringify({ v: 1, id: 'w_01', phase: 'prepared', runs: [{ n: 1 }] }))
    const reopened = openRegistry(dir, { migrate: false, liveness: identity => identity.pid ? 'alive' : (() => { throw new Error('missing pid') })() })
    expect(reopened.read('w_01')).toBeUndefined()
    expect(reopened.read('w_02')).toBeDefined()
    expect(fs.readdirSync(path.join(dir, 'room', 'registry', 'quarantine'))).toHaveLength(1)
    expect(() => reopened.writeIntent({ ...intent(), id: 'w_03' })).toThrow(/tag in use/)
  })

  it('releases claims at 8h idle with exactly one notice, and resets after activity', () => {
    const dir = common(), registry = openRegistry(dir, { migrate: false })
    const doc = new RoomDoc()
    const notices: { id: string; text: string }[] = []
    doc.claims.set('c1', { id: 'c1', path: 'src/api.ts', from: 2, to: 5, by: 'ben', byKind: 'agent', intent: 'update API', at: 1 })
    const input = (now: number, lastActivity = 0, idleEpoch = 'first') => ({
      roomKey: 'local/repo', sessionId: 's1', participant: 'ben', idleEpoch,
      host: 'shared-app-server' as const, lastActivityMs: lastActivity, monotonicMs: () => now, doc,
      ownsParticipant: () => true,
      postNotice: (id: string, text: string) => { notices.push({ id, text }) },
    })
    expect(idleClaimsDue({ host: 'shared-app-server', lastActivityMs: 60_000, nowMs: 8 * 3600_000, heldClaims: 1 })).toBe(false)
    expect(registry.reconcileIdleClaims(input(7 * 3600_000 + 59 * 60_000))).toBe(false)
    expect(doc.claims.has('c1')).toBe(true)
    expect(registry.reconcileIdleClaims(input(8 * 3600_000))).toBe(true)
    expect(doc.claims.has('c1')).toBe(false)
    expect(notices).toEqual([{ id: 'idle-claims:s1:first', text: expect.stringContaining('src/api.ts:2-5') }])
    expect(notices[0].text).not.toContain('cleared its scope')
    expect(registry.reconcileIdleClaims(input(9 * 3600_000))).toBe(false)
    expect(notices).toHaveLength(1)
    doc.claims.set('c2', { id: 'c2', path: 'src/new.ts', from: 1, to: 1, by: 'ben', byKind: 'agent', intent: 'new', at: 2 })
    expect(registry.reconcileIdleClaims(input(9 * 3600_000, 8 * 3600_000, 'second'))).toBe(false)
    expect(doc.claims.has('c2')).toBe(true)
    expect(registry.reconcileIdleClaims(input(16 * 3600_000, 8 * 3600_000, 'second'))).toBe(true)
    expect(notices).toHaveLength(2)
    doc.doc.destroy()
  })

  it('never releases interactive CLI claims solely for quiet time', () => {
    const registry = openRegistry(common(), { migrate: false }), doc = new RoomDoc()
    doc.claims.set('c', { id: 'c', path: 'README.md', from: 1, to: 1, by: 'ben', byKind: 'agent', intent: 'edit', at: 1 })
    expect(registry.reconcileIdleClaims({ roomKey: 'local/repo', sessionId: 's', participant: 'ben', idleEpoch: 'one',
      host: 'interactive', lastActivityMs: 0, monotonicMs: () => 9 * 3600_000, doc,
      ownsParticipant: () => true,
      postNotice: () => { throw new Error('not due') } })).toBe(false)
    expect(doc.claims.has('c')).toBe(true)
    doc.doc.destroy()
  })

  it('does not release a successor holder’s claims under the same participant name', () => {
    const registry = openRegistry(common(), { migrate: false }), doc = new RoomDoc()
    doc.claims.set('new', { id: 'new', path: 'successor.ts', from: 1, to: 1, by: 'ben', byKind: 'agent', intent: 'new', at: 1 })
    doc.participants.set('ben\0holder', { sessionId: 'successor', machine: 'm', pid: 2, startTime: 's', executable: '/bin/codex' })
    expect(registry.reconcileIdleClaims({ roomKey: 'local/repo', sessionId: 'old', participant: 'ben', idleEpoch: 'one',
      host: 'shared-app-server', lastActivityMs: 0, monotonicMs: () => 9 * 3600_000, doc,
      ownsParticipant: () => true, postNotice: () => { throw new Error('must not post') } })).toBe(false)
    expect(doc.claims.has('new')).toBe(true)
    doc.doc.destroy()
  })

  it('replays an idle-release intent after a failed post with the original claim names', () => {
    const dir = common(), registry = openRegistry(dir, { migrate: false }), doc = new RoomDoc()
    doc.claims.set('c', { id: 'c', path: 'src/lost.ts', from: 4, to: 7, by: 'ben', byKind: 'agent', intent: 'fix', at: 1 })
    doc.setScope('ben', { area: 'src', summary: 'fix', paths: ['src/'], byKind: 'agent' })
    const input = { roomKey: 'local/repo', sessionId: 's1', participant: 'ben', idleEpoch: 'old', host: 'shared-app-server' as const,
      lastActivityMs: 0, monotonicMs: () => 8 * 3600_000, doc, ownsParticipant: () => true }
    expect(() => registry.reconcileIdleClaims({ ...input, postNotice: () => { throw new Error('post unavailable') } })).toThrow('post unavailable')
    expect(doc.claims.has('c')).toBe(false)
    expect(doc.scopes.has('ben')).toBe(false)
    const notices: string[] = []
    expect(openRegistry(dir, { migrate: false }).reconcileIdleClaims({ ...input, postNotice: (_id, text) => { notices.push(text) } })).toBe(true)
    expect(notices).toEqual([expect.stringContaining('src/lost.ts:4-7')])
    doc.doc.destroy()
  })

  it('replays the same deterministic notice id after a crash following the post', () => {
    const dir = common(), registry = openRegistry(dir, { migrate: false }), doc = new RoomDoc()
    doc.claims.set('c', { id: 'c', path: 'src/once.ts', from: 1, to: 1, by: 'ben', byKind: 'agent', intent: 'fix', at: 1 })
    const posted = new Set<string>()
    const input = { roomKey: 'local/repo', sessionId: 's1', participant: 'ben', idleEpoch: 'epoch', host: 'shared-app-server' as const,
      lastActivityMs: 0, monotonicMs: () => 8 * 3600_000, doc, ownsParticipant: () => true }
    expect(() => registry.reconcileIdleClaims({ ...input, postNotice: id => { posted.add(id); throw new Error('crash after post') } })).toThrow()
    expect(openRegistry(dir, { migrate: false }).reconcileIdleClaims({ ...input, postNotice: id => { posted.add(id) } })).toBe(true)
    expect(posted).toEqual(new Set(['idle-claims:s1:epoch']))
    doc.doc.destroy()
  })

  it('releases a scope-only shared app-server session at eight hours', () => {
    const registry = openRegistry(common(), { migrate: false }), doc = new RoomDoc()
    doc.setScope('ben', { area: 'src', summary: 'work', paths: ['src/'], byKind: 'agent' })
    const notices: string[] = []
    expect(registry.reconcileIdleClaims({ roomKey: 'local/repo', sessionId: 's', participant: 'ben', idleEpoch: 'scope',
      host: 'shared-app-server', lastActivityMs: 0, monotonicMs: () => 8 * 3600_000, doc, ownsParticipant: () => true,
      postNotice: (_id, text) => { notices.push(text) } })).toBe(true)
    expect(doc.scopes.has('ben')).toBe(false)
    expect(notices).toEqual([expect.stringContaining('cleared its scope')])
    doc.doc.destroy()
  })
})
