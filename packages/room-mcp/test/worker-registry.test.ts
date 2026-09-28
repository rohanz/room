import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import * as Y from 'yjs'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkerRegistry } from '../src/worker-registry.js'
import { idleClaimsDue, type WorkerRecord } from '../src/worker-status.js'
import { RoomDoc, ROOM_DOC_MAX_BYTES } from '@room/shared'
import { memoryFile, saveMemory } from '../../relay/src/memory.js'

/** No release notices to send here. */
const ignore = () => {}

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
async function holdGuard(file: string, ms = 700): Promise<ReturnType<typeof spawn>> {
  const source = `import { withGuard } from ${JSON.stringify(new URL('../src/leases.ts', import.meta.url).href)};
    withGuard(process.argv[1], () => { process.stdout.write('inside\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[2])) })`
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, file, String(ms)],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', error = ''
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.on('data', chunk => { error += chunk.toString() })
  const start = Date.now()
  while (!output.includes('inside') && child.exitCode === null && Date.now() - start < 5_000) await new Promise(resolve => setTimeout(resolve, 10))
  expect(output, error).toContain('inside')
  return child
}
const childExit = async (child: ReturnType<typeof spawn>): Promise<number | null> => child.exitCode ?? (await once(child, 'exit'))[0] as number | null

describe('WorkerRegistry durable store', () => {
  it('reopens a written intent and reconciles a dead launcher to ambiguous without relaunch', async () => {
    const dir = common()
    const first = await openRegistry(dir, { liveness: () => 'alive', migrate: false })
    await first.writeIntent(intent())
    expect(fs.existsSync(path.join(dir, 'room', 'registry', 'workers', 'w_01.op'))).toBe(true)
    const reopened = await openRegistry(dir, { liveness: () => 'dead', migrate: false })
    expect(reopened.read('w_01')?.runs[0].launch).toEqual({ outcome: 'ambiguous', at: expect.any(Number) })
    expect(reopened.status('w_01')?.status).toBe('ambiguous')
    await reopened.reconcile()
    expect(reopened.read('w_01')?.runs).toHaveLength(1)
    expect(reopened.status('w_01')?.status).toBe('ambiguous')
  })

  it('does not let a second live instance mutate a worker under the operation lease', async () => {
    const dir = common()
    const first = await openRegistry(dir, { liveness: () => 'alive', migrate: false, identity: token })
    await first.writeIntent(intent())
    const other = await openRegistry(dir, { liveness: () => 'alive', migrate: false,
      identity: { ...token, nonce: 'other' } })
    await expect(other.update('w_01', r => ({ ...r, seq: r.seq + 1 }))).rejects.toThrow(/operation lease/)
  })

  it('accepts a matching run-writer handoff after an ambiguous launch', async () => {
    const dir = common()
    const store = await openRegistry(dir, { liveness: () => 'dead', migrate: false })
    await store.writeIntent(intent())
    await store.reconcile()
    await store.writeReport('w_01', { run: 1, nonce: 'launch-nonce', chain: [{ pid: 42, startTime: 'born', executable: '/bin/codex' }], joinedAt: 4 })
    await store.reconcile()
    expect(store.read('w_01')?.runs[0].launch).toMatchObject({ outcome: 'launched', pid: 42 })
    expect(store.read('w_01')?.phase).toBe('active')
  })

  it('lets a restarted writer of the same host session retain a done report', async () => {
    const dir = common(), firstToken = { ...token, sessionId: 'worker-session', nonce: 'old' }
    const first = await openRegistry(dir, { migrate: false, liveness: () => 'alive', identity: firstToken })
    await first.writeIntent(intent())
    await first.writeReport('w_01', { run: 1, nonce: 'launch-nonce', chain: [], joinedAt: 3,
      done: { at: 4, summary: 'finished', changed: ['a.ts'] } })
    const restarted = await openRegistry(dir, { migrate: false, liveness: () => 'dead',
      identity: { ...firstToken, nonce: 'new' } })
    await restarted.writeReport('w_01', { run: 1, nonce: 'launch-nonce', chain: [], joinedAt: 5 })
    expect(restarted.reports('w_01')[0].done?.summary).toBe('finished')
  })

  it('adds posted after done and preserves the first chain and host session through restart (S2)', async () => {
    const dir = common(), identity = { ...token, sessionId: 'worker-session', nonce: 'old' }
    const first = await openRegistry(dir, { migrate: false, identity })
    await first.writeIntent(intent())
    const chain = [{ pid: 42, startTime: 'born', executable: '/bin/codex' }]
    await first.writeReport('w_01', { run: 1, nonce: 'launch-nonce', chain, joinedAt: 3, hostSessionId: 'host-1' })
    const restarted = await openRegistry(dir, { migrate: false, liveness: () => 'dead', identity: { ...identity, nonce: 'new' } })
    await restarted.writeReport('w_01', { run: 1, nonce: 'launch-nonce', chain: [], joinedAt: 5, hostSessionId: 'host-2',
      done: { at: 6, summary: 'finished', changed: ['a.ts'] } })
    await restarted.writeReport('w_01', { run: 1, nonce: 'launch-nonce', chain: [], joinedAt: 7, posted: 'wk:w_01:1' })
    expect(restarted.reports('w_01')[0]).toMatchObject({ chain, joinedAt: 3, hostSessionId: 'host-1',
      done: { at: 6, summary: 'finished' }, posted: 'wk:w_01:1' })
  })

  it('notifies subscribers of another registry’s record, report, and exit writes (M4)', async () => {
    const dir = common(), a = await openRegistry(dir, { migrate: false, liveness: () => 'alive' }),
      b = await openRegistry(dir, { migrate: false, liveness: () => 'alive' })
    let changes = 0
    a.onChange(() => { changes++ })
    await b.writeIntent(intent())
    await a.reconcile()
    expect(changes).toBeGreaterThan(0)
    const workerFile = path.join(dir, 'room', 'registry', 'workers', 'w_01.json')
    const launched = b.read('w_01')!
    launched.runs[0].launch = { outcome: 'launched', pid: 42 }
    fs.writeFileSync(workerFile, JSON.stringify(launched))
    await a.reconcile()
    const afterRecord = changes
    await b.writeReport('w_01', { run: 1, nonce: 'launch-nonce', chain: [], joinedAt: 2,
      done: { at: 3, summary: 'done', changed: [] } })
    await a.reconcile()
    expect(changes).toBeGreaterThan(afterRecord)
    const afterReport = changes
    await b.writeExit('w_01', { run: 1, code: 0, at: 4, witnessed: true })
    await a.reconcile()
    expect(changes).toBeGreaterThan(afterReport)
  })

  it('reuses an abandoned or fully cleaned retired tag, but keeps a retired worktree reserved (M5)', async () => {
    for (const phase of ['abandoned', 'retired'] as const) {
      const dir = common(), store = await openRegistry(dir, { migrate: false })
      await store.writeIntent({ ...intent(), phase, ...(phase === 'retired' ? { cleanup: { 'local/repo': 'done' } } : {}) })
      await store.writeIntent({ ...intent(), id: 'w_02' })
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'room', 'registry', 'tags', 'tests.json'), 'utf8')).id).toBe('w_02')
    }
    const dir = common(), store = await openRegistry(dir, { migrate: false })
    await store.writeIntent({ ...intent(), phase: 'retired', cleanup: { 'local/repo': 'done' }, keptWorktree: '/tmp/kept' })
    await expect(store.writeIntent({ ...intent(), id: 'w_02' })).rejects.toThrow(/tag in use/)
  })

  it('keeps a witnessed exit over later polling, and upgrades an unwitnessed exit', async () => {
    const store = await openRegistry(common(), { migrate: false })
    await store.writeIntent(intent())
    await store.writeExit('w_01', { run: 1, code: null, at: 3, witnessed: false })
    await store.writeExit('w_01', { run: 1, code: 7, at: 4, witnessed: true })
    await store.writeExit('w_01', { run: 1, code: null, at: 5, witnessed: false })
    expect(store.exits('w_01')).toEqual([{ run: 1, code: 7, at: 4, witnessed: true }])
  })

  it('counts ambiguous intents against capacity across reopened registries', async () => {
    const dir = common()
    const first = await openRegistry(dir, { liveness: () => 'dead', migrate: false })
    await first.writeIntent(intent(), 1)
    const second = await openRegistry(dir, { liveness: () => 'dead', migrate: false })
    expect(second.occupancy()).toBe(1)
    await expect(second.writeIntent({ ...intent(), id: 'w_02', tag: 'more', name: 'lead+more' }, 1)).rejects.toThrow(/capacity/)
  })

  it('recovers a dead orphan tag reservation without authorizing a missing record', async () => {
    const dir = common(), registry = await openRegistry(dir, { liveness: () => 'dead', migrate: false })
    const tag = path.join(dir, 'room', 'registry', 'tags', 'tests.json')
    fs.mkdirSync(path.dirname(tag), { recursive: true })
    fs.writeFileSync(tag, JSON.stringify({ id: 'w_lost', holder: token, at: 1 }))
    await registry.writeIntent(intent())
    expect(registry.read('w_01')).toBeDefined()
    expect(JSON.parse(fs.readFileSync(tag, 'utf8')).id).toBe('w_01')
  })

  it('resumes a partially written migration map with the same worker id', async () => {
    const dir = common()
    const source = { key: 'legacy:tests', tag: 'tests', name: 'lead+tests', lead: 'lead', room: 'local/repo', dir: '/tmp/repo/.room/workers/tests', branch: 'room/tests', host: 'codex' as const }
    const file = path.join(dir, 'room', 'registry', 'migration.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ v: 1, sources: { [source.key]: { id: 'w_mapped', state: 'assigned' } }, done: false }))
    const store = await openRegistry(dir, { liveness: () => 'dead', sources: () => [source] })
    expect(store.read('w_mapped')?.runs[0].launch).toEqual({ outcome: 'imported' })
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).sources[source.key]).toEqual({ id: 'w_mapped', state: 'imported' })
    expect((await openRegistry(dir, { liveness: () => 'dead', sources: () => [source] })).list()).toHaveLength(1)
  })

  it('lets a second process open after the first completes the migration barrier', async () => {
    const dir = common()
    const source = `import { WorkerRegistry } from ${JSON.stringify(new URL('../src/worker-registry.ts', import.meta.url).href)};
      await WorkerRegistry.open(process.argv[1], { watch: false, sources: () => {
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
    expect((await openRegistry(dir)).list()).toEqual([])
  }, 15_000)

  it('waits for a live migration guard before recovering a dead migration lock', async () => {
    const dir = common(), lock = path.join(dir, 'room', 'registry', 'migration.lock')
    fs.mkdirSync(path.dirname(lock), { recursive: true })
    fs.writeFileSync(lock, JSON.stringify({ ...token, pid: -1 }))
    const child = await holdGuard(lock)
    const store = await openRegistry(dir, { sources: () => [] })
    expect(store.list()).toEqual([])
    expect(await childExit(child)).toBe(0)
  }, 15_000)

  it('waits for a live guard while releasing the migration lock', async () => {
    const dir = common(), lock = path.join(dir, 'room', 'registry', 'migration.lock')
    const marker = path.join(dir, 'guard-held')
    const source = `import fs from 'node:fs'; import { withGuard } from ${JSON.stringify(new URL('../src/leases.ts', import.meta.url).href)};
      withGuard(process.argv[1], () => { fs.writeFileSync(process.argv[2], 'held'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700) })`
    let child: ReturnType<typeof spawn> | undefined
    let openError: unknown
    try {
      await openRegistry(dir, { sources: () => {
        child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, lock, marker],
          { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
        const deadline = Date.now() + 5_000
        while (!fs.existsSync(marker) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
        expect(fs.existsSync(marker)).toBe(true)
        return []
      } })
    } catch (error) { openError = error }
    if (child) expect(await childExit(child)).toBe(0)
    if (openError) throw openError
    expect(fs.existsSync(lock)).toBe(false)
  }, 15_000)

  it('waits through live guards for intent, update, and idle-claim release', async () => {
    const dir = common(), store = await openRegistry(dir, { migrate: false, identity: token, liveness: () => 'alive' })
    const capacity = await holdGuard(path.join(dir, 'room', 'registry', 'capacity'))
    await store.writeIntent(intent())
    expect(await childExit(capacity)).toBe(0)
    const operation = await holdGuard(path.join(dir, 'room', 'registry', 'workers', 'w_01.op'))
    expect((await store.update('w_01', record => ({ ...record, seq: record.seq + 1 }))).seq).toBe(2)
    expect(await childExit(operation)).toBe(0)
    const doc = new RoomDoc()
    doc.claims.set('c', { id: 'c', path: 'src/api.ts', from: 1, to: 2, by: 'lead', byKind: 'agent', intent: 'edit', at: 1 })
    const key = createHash('sha256').update('local/repo\0session\0epoch').digest('hex')
    const journal = path.join(dir, 'room', 'sessions', 'session', 'idle-claims', `${key}.json`)
    const idle = await holdGuard(journal)
    const notices: string[] = []
    expect(await store.reconcileIdleClaims({ roomKey: 'local/repo', sessionId: 'session', participant: 'lead', idleEpoch: 'epoch',
      host: 'shared-app-server', lastActivityMs: 0, monotonicMs: () => 8 * 3600_000, doc,
      ownsParticipant: () => true, postNotice: (_id, text) => { notices.push(text) } })).toBe(true)
    expect(await childExit(idle)).toBe(0)
    expect(notices).toHaveLength(1)
    doc.doc.destroy()
  }, 15_000)

  it('lets a timer run while an intent waits for another process’s capacity guard (S8)', async () => {
    const dir = common(), store = await openRegistry(dir, { migrate: false })
    const child = await holdGuard(path.join(dir, 'room', 'registry', 'capacity'), 1_100)
    let timerFired = false
    setTimeout(() => { timerFired = true }, 10)
    const pending = store.writeIntent(intent())
    await pending
    expect(timerFired).toBe(true)
    expect(await childExit(child)).toBe(0)
  }, 15_000)

  it('does not replay an entered idle-release callback that throws a guard-busy error', async () => {
    const store = await openRegistry(common(), { migrate: false }), doc = new RoomDoc()
    doc.claims.set('c', { id: 'c', path: 'src/api.ts', from: 1, to: 2, by: 'lead', byKind: 'agent', intent: 'edit', at: 1 })
    let posts = 0
    await expect(store.reconcileIdleClaims({ roomKey: 'local/repo', sessionId: 'session', participant: 'lead', idleEpoch: 'epoch',
      host: 'shared-app-server', lastActivityMs: 0, monotonicMs: () => 8 * 3600_000, doc,
      ownsParticipant: () => true, postNotice: () => { posts++; throw new Error('lease guard busy: injected callback') } })).rejects.toThrow('injected callback')
    expect(posts).toBe(1)
    doc.doc.destroy()
  })

  it('discovers an owned legacy Git worktree as imported and copy-only', async () => {
    const dir = common()
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
    fs.writeFileSync(path.join(dir, 'README.md'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base')
    const workerDir = path.join(dir, '.room', 'workers', 'tests')
    fs.mkdirSync(path.dirname(workerDir), { recursive: true })
    git('worktree', 'add', '-qb', 'room/tests', workerDir)
    const commonDir = git('rev-parse', '--git-common-dir')
    const store = await openRegistry(path.resolve(dir, commonDir))
    const imported = store.list()[0]
    expect(imported).toMatchObject({ tag: 'tests', branch: 'room/tests', phase: 'active',
      capabilities: { signal: false, resume: false, collect: 'copy' } })
    expect(store.status(imported.id)?.status).toBe('imported')
    expect(imported.legacy?.unowned).toBe(true)
    expect(imported.lead.participant).toBe('')
    expect((await store.trusted({ participant: 'rohanz', room: 'local/repo', dir }, 'tests'))?.record.id).toBe(imported.id)
    expect(store.read(imported.id)).toMatchObject({ name: 'rohanz+tests', lead: { participant: 'rohanz', room: 'local/repo' } })
    expect(await store.trusted({ participant: 'another', room: 'local/repo', dir }, 'tests')).toBeUndefined()
    expect((await (await openRegistry(path.resolve(dir, commonDir))).trusted({ participant: 'rohanz', room: 'local/repo', dir }, 'tests'))?.record.id).toBe(imported.id)
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
    const store = await openRegistry(path.resolve(dir, git('rev-parse', '--git-common-dir')))
    expect(store.list().map(record => record.tag).sort()).toEqual(['child', 'parent'])
    const adopted = await store.trusted({ participant: 'real-parent', room: 'local/repo', dir: parent }, 'child')
    expect(adopted?.record).toMatchObject({ name: 'real-parent+child', lead: { participant: 'real-parent' } })
  })

  it('imports only locally verified carry and session capabilities from a legacy snapshot', async () => {
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
      dir: workerDir, branch: 'room/tests', pid: 1, startedAt: 1, status: 'done', summary: 'old summary' }, ignore)
    const snapshotDir = path.join(commonDir, 'room-local')
    fs.mkdirSync(snapshotDir, { recursive: true })
    fs.writeFileSync(path.join(snapshotDir, `${encodeURIComponent('local/repo/main')}.ydoc`), Y.encodeStateAsUpdate(old.doc))
    old.doc.destroy()
    const carry = path.join(commonDir, 'room-carry', 'tests.json')
    fs.mkdirSync(path.dirname(carry), { recursive: true })
    fs.writeFileSync(carry, JSON.stringify({ base: git('rev-parse', 'HEAD') }))
    const workerGitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: workerDir, encoding: 'utf8' }).trim()
    fs.writeFileSync(path.join(workerGitDir, 'room-session.json'), JSON.stringify({ worker_id: oldId, host: 'claude', session_id: 'session-1' }))
    const store = await openRegistry(commonDir)
    expect(store.list()[0]).toMatchObject({ host: 'claude', task: 'old task', legacy: { said: 'old summary' },
      hostSessionId: 'session-1', capabilities: { resume: true, signal: false, collect: 'delta' } })
    expect(store.list()[0].lead.participant).toBe('')
    expect(fs.existsSync(carry)).toBe(false)
    expect(fs.existsSync(`${carry}.migrated`)).toBe(true)
  })

  it('imports a relay-saved protected-overflow kept retirement without reviving the worker (M7)', async () => {
    const dir = common()
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
    fs.writeFileSync(path.join(dir, 'README.md'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base')
    const workerDir = path.join(dir, '.room', 'workers', 'tests')
    fs.mkdirSync(path.dirname(workerDir), { recursive: true })
    git('worktree', 'add', '-qb', 'room/tests', workerDir)
    const commonDir = path.resolve(dir, git('rev-parse', '--git-common-dir'))
    const doc = new RoomDoc()
    doc.doc.getArray('retiredWorkers').push([{ name: 'lead+tests', tag: 'tests', lead: 'lead', host: 'codex',
      task: 'old task', summary: 'kept', files: [], fileCount: 0, startedAt: 1, finishedAt: 2, retiredAt: 3,
      outcome: 'dismissed', keptWorktree: workerDir }])
    doc.doc.getMap('meta').set('protected', 'x'.repeat(5 * 1024 * 1024))
    doc.doc.getMap('mail').set('owed', { id: 'owed', to: 'lead', text: 'still owed' })
    const room = 'local/repo/main'
    expect(saveMemory(commonDir, room, doc.doc, () => {})).toBe(true)
    expect(fs.statSync(memoryFile(commonDir, room)).size).toBeGreaterThan(5 * 1024 * 1024)
    expect(fs.statSync(memoryFile(commonDir, room)).size).toBeLessThan(ROOM_DOC_MAX_BYTES)
    const store = await openRegistry(commonDir)
    expect(store.list()[0]).toMatchObject({ phase: 'retired', keptWorktree: workerDir })
    expect(await store.trusted({ participant: 'rohanz', room: 'local/explicit', dir }, 'tests')).toBeUndefined()
    doc.doc.destroy()
  })

  it('skips legacy worktree import when a snapshot is corrupt or beyond the shared ceiling (M7)', async () => {
    for (const corrupt of [true, false]) {
      const dir = common()
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
      git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
      fs.writeFileSync(path.join(dir, 'README.md'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base')
      const workerDir = path.join(dir, '.room', 'workers', 'tests')
      fs.mkdirSync(path.dirname(workerDir), { recursive: true })
      git('worktree', 'add', '-qb', 'room/tests', workerDir)
      const commonDir = path.resolve(dir, git('rev-parse', '--git-common-dir'))
      const file = memoryFile(commonDir, 'local/repo/main')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      if (corrupt) fs.writeFileSync(file, new Uint8Array([255, 255, 255]))
      else { fs.writeFileSync(file, new Uint8Array([0])); fs.truncateSync(file, ROOM_DOC_MAX_BYTES + 1) }
      expect((await openRegistry(commonDir)).list()).toEqual([])
      const repaired = new RoomDoc()
      repaired.doc.getArray('retiredWorkers').push([{ name: 'lead+tests', tag: 'tests', lead: 'lead', host: 'codex',
        task: 'old task', summary: 'kept', files: [], fileCount: 0, startedAt: 1, finishedAt: 2, retiredAt: 3,
        outcome: 'dismissed', keptWorktree: workerDir }])
      fs.writeFileSync(file, Y.encodeStateAsUpdate(repaired.doc))
      expect((await openRegistry(commonDir)).list()[0]).toMatchObject({ phase: 'retired', keptWorktree: workerDir })
      repaired.doc.destroy()
    }
  })

  it('rolls back only a dead launcher’s journaled new worktree and marks it abandoned', async () => {
    const dir = common()
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
    fs.writeFileSync(path.join(dir, 'README.md'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base')
    const workerDir = path.join(dir, '.room', 'workers', 'tests')
    fs.mkdirSync(path.dirname(workerDir), { recursive: true })
    git('worktree', 'add', '-qb', 'room/tests', workerDir)
    const commonDir = path.resolve(dir, git('rev-parse', '--git-common-dir'))
    const store = await openRegistry(commonDir, { migrate: false, liveness: () => 'alive' })
    await store.writeIntent({ ...intent(), dir: workerDir, phase: 'preparing', prep: {
      step: 'worktree', worktreeExisted: false, branchExisted: false, created: true, branchCreated: true,
      previousCarryRefs: {},
    } })
    const restarted = await openRegistry(commonDir, { migrate: false, liveness: () => 'dead' })
    expect(restarted.read('w_01')?.phase).toBe('abandoned')
    expect(fs.existsSync(workerDir)).toBe(false)
    expect(git('branch', '--list', 'room/tests')).toBe('')
    await restarted.writeIntent({ ...intent(), id: 'w_02' })
    expect(restarted.read('w_02')).toBeDefined()
  })

  it('marks an interrupted collect without claiming that a partial apply was undone', async () => {
    const dir = common(), store = await openRegistry(dir, { migrate: false, liveness: () => 'alive' })
    await store.writeIntent({ ...intent(), phase: 'collecting' })
    const reopened = await openRegistry(dir, { migrate: false, liveness: () => 'dead' })
    expect(reopened.read('w_01')).toMatchObject({ phase: 'active', interrupted: { op: 'collect' } })
  })

  it('quarantines a corrupt worker record and keeps its tag reserved', async () => {
    const dir = common(), store = await openRegistry(dir, { migrate: false })
    await store.writeIntent(intent())
    const file = path.join(dir, 'room', 'registry', 'workers', 'w_01.json')
    fs.writeFileSync(file, '{not-json')
    const reopened = await openRegistry(dir, { migrate: false })
    expect(reopened.list()).toEqual([])
    expect(fs.readdirSync(path.join(dir, 'room', 'registry', 'quarantine'))).toHaveLength(1)
    expect(fs.existsSync(path.join(dir, 'room', 'registry', 'tags', 'tests.json'))).toBe(true)
    await expect(reopened.writeIntent({ ...intent(), id: 'w_02' })).rejects.toThrow(/tag in use/)
  })

  it('quarantines structurally corrupt records without aborting healthy recovery (S4)', async () => {
    const dir = common(), store = await openRegistry(dir, { migrate: false })
    await store.writeIntent(intent())
    await store.writeIntent({ ...intent(), id: 'w_02', tag: 'healthy', name: 'lead+healthy' })
    const file = path.join(dir, 'room', 'registry', 'workers', 'w_01.json')
    fs.writeFileSync(file, JSON.stringify({ v: 1, id: 'w_01', phase: 'prepared', runs: [{ n: 1 }] }))
    const reopened = await openRegistry(dir, { migrate: false, liveness: identity => identity.pid ? 'alive' : (() => { throw new Error('missing pid') })() })
    expect(reopened.read('w_01')).toBeUndefined()
    expect(reopened.read('w_02')).toBeDefined()
    expect(fs.readdirSync(path.join(dir, 'room', 'registry', 'quarantine'))).toHaveLength(1)
    await expect(reopened.writeIntent({ ...intent(), id: 'w_03' })).rejects.toThrow(/tag in use/)
  })

  it('releases claims at 8h idle with exactly one notice, and resets after activity', async () => {
    const dir = common(), registry = await openRegistry(dir, { migrate: false })
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
    expect(await registry.reconcileIdleClaims(input(7 * 3600_000 + 59 * 60_000))).toBe(false)
    expect(doc.claims.has('c1')).toBe(true)
    expect(await registry.reconcileIdleClaims(input(8 * 3600_000))).toBe(true)
    expect(doc.claims.has('c1')).toBe(false)
    expect(notices).toEqual([{ id: 'idle-claims:s1:first', text: expect.stringContaining('src/api.ts:2-5') }])
    expect(notices[0].text).not.toContain('cleared its scope')
    expect(await registry.reconcileIdleClaims(input(9 * 3600_000))).toBe(false)
    expect(notices).toHaveLength(1)
    doc.claims.set('c2', { id: 'c2', path: 'src/new.ts', from: 1, to: 1, by: 'ben', byKind: 'agent', intent: 'new', at: 2 })
    expect(await registry.reconcileIdleClaims(input(9 * 3600_000, 8 * 3600_000, 'second'))).toBe(false)
    expect(doc.claims.has('c2')).toBe(true)
    expect(await registry.reconcileIdleClaims(input(16 * 3600_000, 8 * 3600_000, 'second'))).toBe(true)
    expect(notices).toHaveLength(2)
    doc.doc.destroy()
  })

  it('never releases interactive CLI claims solely for quiet time', async () => {
    const registry = await openRegistry(common(), { migrate: false }), doc = new RoomDoc()
    doc.claims.set('c', { id: 'c', path: 'README.md', from: 1, to: 1, by: 'ben', byKind: 'agent', intent: 'edit', at: 1 })
    expect(await registry.reconcileIdleClaims({ roomKey: 'local/repo', sessionId: 's', participant: 'ben', idleEpoch: 'one',
      host: 'interactive', lastActivityMs: 0, monotonicMs: () => 9 * 3600_000, doc,
      ownsParticipant: () => true,
      postNotice: () => { throw new Error('not due') } })).toBe(false)
    expect(doc.claims.has('c')).toBe(true)
    doc.doc.destroy()
  })

  it('does not release a successor holder’s claims under the same participant name', async () => {
    const registry = await openRegistry(common(), { migrate: false }), doc = new RoomDoc()
    doc.claims.set('new', { id: 'new', path: 'successor.ts', from: 1, to: 1, by: 'ben', byKind: 'agent', intent: 'new', at: 1 })
    doc.participants.set('ben\0holder', { sessionId: 'successor', machine: 'm', pid: 2, startTime: 's', executable: '/bin/codex' })
    expect(await registry.reconcileIdleClaims({ roomKey: 'local/repo', sessionId: 'old', participant: 'ben', idleEpoch: 'one',
      host: 'shared-app-server', lastActivityMs: 0, monotonicMs: () => 9 * 3600_000, doc,
      ownsParticipant: () => true, postNotice: () => { throw new Error('must not post') } })).toBe(false)
    expect(doc.claims.has('new')).toBe(true)
    doc.doc.destroy()
  })

  it('rechecks the holder fence after waiting for an idle-release guard', async () => {
    const dir = common(), registry = await openRegistry(dir, { migrate: false }), doc = new RoomDoc()
    doc.claims.set('c', { id: 'c', path: 'src/new.ts', from: 1, to: 1, by: 'ben', byKind: 'agent', intent: 'edit', at: 1 })
    const key = createHash('sha256').update('local/repo\0old\0epoch').digest('hex')
    const journal = path.join(dir, 'room', 'sessions', 'old', 'idle-claims', `${key}.json`)
    const child = await holdGuard(journal)
    const notices: string[] = []
    setTimeout(() => doc.participants.set('ben\0holder', { sessionId: 'new', machine: 'm', pid: 2, startTime: 's', executable: '/bin/codex' }), 10)
    expect(await registry.reconcileIdleClaims({ roomKey: 'local/repo', sessionId: 'old', participant: 'ben', idleEpoch: 'epoch',
      host: 'shared-app-server', lastActivityMs: 0, monotonicMs: () => 8 * 3600_000, doc,
      ownsParticipant: () => true, postNotice: (_id, text) => { notices.push(text) } })).toBe(false)
    expect(await childExit(child)).toBe(0)
    expect(doc.claims.has('c')).toBe(true)
    expect(notices).toEqual([])
    doc.doc.destroy()
  }, 15_000)

  it('replays an idle-release intent after a failed post with the original claim names', async () => {
    const dir = common(), registry = await openRegistry(dir, { migrate: false }), doc = new RoomDoc()
    doc.claims.set('c', { id: 'c', path: 'src/lost.ts', from: 4, to: 7, by: 'ben', byKind: 'agent', intent: 'fix', at: 1 })
    doc.setScope('ben', { area: 'src', summary: 'fix', paths: ['src/'], byKind: 'agent' })
    const input = { roomKey: 'local/repo', sessionId: 's1', participant: 'ben', idleEpoch: 'old', host: 'shared-app-server' as const,
      lastActivityMs: 0, monotonicMs: () => 8 * 3600_000, doc, ownsParticipant: () => true }
    await expect(registry.reconcileIdleClaims({ ...input, postNotice: () => { throw new Error('post unavailable') } })).rejects.toThrow('post unavailable')
    expect(doc.claims.has('c')).toBe(false)
    expect(doc.scopes.has('ben')).toBe(false)
    const notices: string[] = []
    expect(await (await openRegistry(dir, { migrate: false })).reconcileIdleClaims({ ...input, postNotice: (_id, text) => { notices.push(text) } })).toBe(true)
    expect(notices).toEqual([expect.stringContaining('src/lost.ts:4-7')])
    doc.doc.destroy()
  })

  it('replays the same deterministic notice id after a crash following the post', async () => {
    const dir = common(), registry = await openRegistry(dir, { migrate: false }), doc = new RoomDoc()
    doc.claims.set('c', { id: 'c', path: 'src/once.ts', from: 1, to: 1, by: 'ben', byKind: 'agent', intent: 'fix', at: 1 })
    const posted = new Set<string>()
    const input = { roomKey: 'local/repo', sessionId: 's1', participant: 'ben', idleEpoch: 'epoch', host: 'shared-app-server' as const,
      lastActivityMs: 0, monotonicMs: () => 8 * 3600_000, doc, ownsParticipant: () => true }
    await expect(registry.reconcileIdleClaims({ ...input, postNotice: id => { posted.add(id); throw new Error('crash after post') } })).rejects.toThrow()
    expect(await (await openRegistry(dir, { migrate: false })).reconcileIdleClaims({ ...input, postNotice: id => { posted.add(id) } })).toBe(true)
    expect(posted).toEqual(new Set(['idle-claims:s1:epoch']))
    doc.doc.destroy()
  })

  it('releases a scope-only shared app-server session at eight hours', async () => {
    const registry = await openRegistry(common(), { migrate: false }), doc = new RoomDoc()
    doc.setScope('ben', { area: 'src', summary: 'work', paths: ['src/'], byKind: 'agent' })
    const notices: string[] = []
    expect(await registry.reconcileIdleClaims({ roomKey: 'local/repo', sessionId: 's', participant: 'ben', idleEpoch: 'scope',
      host: 'shared-app-server', lastActivityMs: 0, monotonicMs: () => 8 * 3600_000, doc, ownsParticipant: () => true,
      postNotice: (_id, text) => { notices.push(text) } })).toBe(true)
    expect(doc.scopes.has('ben')).toBe(false)
    expect(notices).toEqual([expect.stringContaining('cleared its scope')])
    doc.doc.destroy()
  })
})
