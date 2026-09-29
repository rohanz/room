import { afterEach, beforeAll, afterAll, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import { digestPath, manifestKey, participantRecord } from '@room/shared'
import { readDisk } from '../src/disk-scan.js'
import { manifestText } from './manifest-assert.js'
import { startRoomd, type Roomd } from '../src/index.js'
import { plan, policyFromLevel, rulesFromText } from '../src/policy.js'
import { pollHead } from './poll-head.js'

const roots: string[] = []
const daemons: Roomd[] = []
beforeAll(() => vi.stubEnv('CHOKIDAR_USEPOLLING', '1'))
afterAll(() => vi.unstubAllEnvs())
afterEach(async () => { vi.restoreAllMocks(); for (const d of daemons.splice(0)) await d.stop(); for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }) })
function checkout(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-policy-regression-'))
  roots.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
  for (const [p, value] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), value) }
  git('add', '-f', '--', ...Object.keys(files)); git('commit', '-qm', 'base')
  return { dir, git, base: git('rev-parse', 'HEAD') }
}
function provider(doc: Y.Doc): WebsocketProvider {
  let state: unknown = null
  return { synced: true, awareness: { getLocalState: () => state, setLocalState: (s: unknown) => { state = s }, getStates: () => new Map([[doc.clientID, state]]) }, on() {}, off() {}, destroy() {} } as unknown as WebsocketProvider
}
async function daemonFor(files: Record<string, string>) {
  const repo = checkout(files)
  const daemon = await startRoomd({ dir: repo.dir, room: 'ws://memory/local/r', localKey: 'test', name: 'Ben', sessionId: 's1', policy: policyFromLevel('full'),
    providerFactory: (_s, _n, doc) => provider(doc), basePollMs: 0, trackedRefreshMs: 60000, log: () => {} })
  daemons.push(daemon)
  return { ...repo, daemon, entries: () => daemon.roomDoc.manifest.get(manifestKey('Ben', 's1'))! }
}

it.each([
  ['.gitignore', { '.gitignore': 'private.txt\n', 'private.txt': 'base' }, 'private.txt', ''],
  ['default ignore', { '.env': 'base' }, '.env', ''],
  ['.roomignore', { '.roomignore': 'private.txt\n', 'private.txt': 'base' }, 'private.txt', 'private.txt\n'],
] as const)('excludes tracked %s paths before reading changed and deleted disk shapes', async (_rule, files, target, roomIgnore) => {
  const { dir, base } = checkout(files)
  const inputs = { policy: policyFromLevel('full'), rules: rulesFromText(roomIgnore, 1000, 1000), head: base }
  for (const shape of ['changed', 'deleted']) {
    if (shape === 'changed') fs.writeFileSync(path.join(dir, target), 'secret')
    else fs.rmSync(path.join(dir, target))
    const facts = await readDisk(dir, inputs, [], () => true)
    const desired = plan(inputs, facts, 'a'.repeat(64))
    expect(desired.entries.has(target), shape).toBe(false)
    expect(desired.excluded, shape).toContain(digestPath('a'.repeat(64), target))
  }
})

it('keeps an existing shared file and incomplete coverage when reading it fails', async () => {
  const { dir, daemon, entries } = await daemonFor({ x: 'base' })
  fs.writeFileSync(path.join(dir, 'x'), 'first')
  await (daemon as any).publisher.reconcile('all')
  expect(entries().get('x')?.state).toBe('shared')
  const read = fs.readFileSync.bind(fs)
  vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (p === path.join(dir, 'x')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
    return read(p, ...(rest as []))
  }) as typeof fs.readFileSync)
  await (daemon as any).publisher.reconcile('all')
  expect(entries().get('x')?.state).toBe('shared')
  expect(manifestText(daemon.roomDoc, 'x', 'Ben')).toBe('first')
  expect(daemon.roomDoc.manifestHead.get('Ben')?.complete).toBe(false)
  expect((daemon as any).publisher.dirtyTimer).toBeDefined()
})

it('stores base text under the manifest anchor after an unpushed commit', async () => {
  const { dir, git, base } = checkout({ 'x.py': 'base\n' })
  const origin = `${dir}-origin.git`
  roots.push(origin)
  execFileSync('git', ['init', '--bare', '-q', origin])
  git('remote', 'add', 'origin', origin)
  git('push', '-q', '-u', 'origin', 'main')
  fs.writeFileSync(path.join(dir, 'x.py'), 'unpushed\n')
  git('add', '-A'); git('commit', '-qm', 'unpushed')
  const daemon = await startRoomd({ dir, room: 'ws://memory/team', name: 'Ben', sessionId: 's1', policy: policyFromLevel('full'),
    providerFactory: (_s, _n, doc) => provider(doc), basePollMs: 0, trackedRefreshMs: 60000, log: () => {} })
  daemons.push(daemon)
  const anchor = daemon.roomDoc.manifestHead.get('Ben')?.base
  expect(anchor).toBe(base)
  expect(daemon.roomDoc.baseText('Ben', base, 'x.py')).toBe('base\n')
  expect(daemon.roomDoc.baseText('Ben', git('rev-parse', 'HEAD'), 'x.py')).toBeUndefined()
})

it('leaves a failed HEAD transition incomplete and retries without certifying equality', async () => {
  const { dir, git, daemon, entries } = await daemonFor({ x: 'base' })
  fs.writeFileSync(path.join(dir, 'x'), 'dirty')
  await (daemon as any).publisher.reconcile('all')
  fs.writeFileSync(path.join(dir, 'x'), 'committed')
  git('add', '-A'); git('commit', '-qm', 'move')
  fs.writeFileSync(path.join(dir, 'x'), 'dirty again')
  const read = fs.readFileSync.bind(fs)
  vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (p === path.join(dir, 'x')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
    return read(p, ...(rest as []))
  }) as typeof fs.readFileSync)
  await expect(pollHead(daemon)).rejects.toThrow()
  expect(entries().get('x')?.state).toBe('shared')
  expect(daemon.roomDoc.manifestHead.get('Ben')?.complete).toBe(false)
  expect(participantRecord(daemon.roomDoc, 'Ben')?.git?.base).not.toBe(git('rev-parse', 'HEAD'))
  expect((daemon as any).publisher.dirtyTimer).toBeDefined()
})

it('withdraws a deleted file base text on full to declared and after prefix settlement', async () => {
  const { dir, daemon, entries } = await daemonFor({ 'src/x': 'private base' })
  fs.rmSync(path.join(dir, 'src/x'))
  await (daemon as any).publisher.reconcile('all')
  const base = participantRecord(daemon.roomDoc, 'Ben')!.git!.base
  expect(daemon.roomDoc.baseText('Ben', base, 'src/x')).toBe('private base')
  daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('declared') })
  expect(entries().get('src/x')?.change).toBe('D')
  expect(entries().get('src/x')?.baseHash).toBeUndefined()
  expect(daemon.roomDoc.baseText('Ben', base, 'src/x')).toBeUndefined()
  await (daemon as any).publisher.reconcile('all')
  expect(daemon.roomDoc.baseText('Ben', base, 'src/x')).toBeUndefined()
  daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('declared', ['src/']) })
  await (daemon as any).publisher.reconcile('all')
  expect(daemon.roomDoc.baseText('Ben', base, 'src/x')).toBe('private base')
  daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('declared') })
  await (daemon as any).publisher.reconcile('all')
  expect(entries().get('src/x')?.change).toBe('D')
  expect(daemon.roomDoc.baseText('Ben', base, 'src/x')).toBeUndefined()
})
