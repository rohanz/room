import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { RoomDoc } from '@room/shared'
import type { Session } from '../src/session.js'
import type { HandlerState } from '../src/tools/context.js'
import { handlers as fileHandlers } from '../src/tools/files.js'
import { handlers as collectHandlers } from '../src/tools/collect.js'
import { closeRegistryForDir, localWorkers } from '../src/worker-registry.js'
import { registerWorkers } from './registry-fixture.js'
import { publishFixture } from './fixtures/manifest.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'

vi.mock('../src/tools/claims.js', () => ({ releaseClaimsOnDone: vi.fn() }))
const roots: string[] = [], rooms: RoomDoc[] = []
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
const put = (dir: string, file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text) }
const oldPath = 'src/old.lua', newPath = 'src/new.lua', script = 'return 42\n'
type Change = 'committed rename' | 'staged rename' | 'committed deletion'

afterEach(async () => {
  for (const root of roots.splice(0)) { await closeRegistryForDir(root); fs.rmSync(root, { recursive: true, force: true }) }
  for (const room of rooms.splice(0)) room.doc.destroy()
})

async function fixture(change: Change, remote = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-committed-deletions-'))); roots.push(root)
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Lead'); git(root, 'config', 'user.email', 'lead@example.test')
  git(root, 'config', 'diff.renames', 'true')
  put(root, '.gitignore', '.room/\n'); put(root, oldPath, script)
  put(root, 'lead-edit.txt', 'base\n'); put(root, 'lead-delete.txt', 'base\n')
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'base')
  const base = git(root, 'rev-parse', 'HEAD'), worker = path.join(root, '.room/workers/test')
  git(root, 'worktree', 'add', '-qb', 'room/test', worker)
  if (change === 'committed deletion') git(worker, 'rm', oldPath)
  else git(worker, 'mv', oldPath, newPath)
  if (change !== 'staged rename') git(worker, 'commit', '-qm', change)
  const workerHead = git(worker, 'rev-parse', 'HEAD')
  // Independent Git oracle: the source really was removed, including the
  // rename case where --name-only reports only the destination by default.
  expect(git(worker, 'diff', '--name-status', base)).toBe(change === 'committed deletion'
    ? `D\t${oldPath}` : `R100\t${oldPath}\t${newPath}`)
  expect(fs.existsSync(path.join(worker, oldPath))).toBe(false)
  git(root, 'rm', 'lead-delete.txt'); put(root, 'lead-commit.txt', 'independent commit\n')
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'independent lead changes')
  put(root, 'lead-edit.txt', 'uncommitted lead edit\n'); put(root, 'lead-new.txt', 'untracked lead file\n')
  const room = new RoomDoc(); rooms.push(room); room.setMeta({ base, branch: 'main', repo: 'test' })
  const session = { ...hubSeam(room), policyStore: testPolicyStore(), dir: root, local: {}, me: { name: 'lead', kind: 'agent' },
    roomName: 'local/test/main', room, awareness: { getStates: () => new Map() }, daemon: {} } as unknown as Session
  const person = remote ? 'peer' : 'lead+test'
  if (remote) {
    // A complete publication at the committed tip has no entry for the old
    // path. Committed path discovery must find it independently of manifests.
    publishFixture(room, person, 'lead-edit.txt', 'base\n', { base: workerHead })
  } else await registerWorkers(session, [{ tag: 'test', name: person, lead: 'lead', dir: worker, branch: 'room/test',
    status: 'done', exitCode: 0, base, host: 'codex', task: 'rename', pid: 0, startedAt: 1 }])
  const state = { S: () => session, rooms: { all: () => [session], holding: () => session, holdingWorker: () => session,
    reserve: () => true, unreserve() {}, autoRetire: async () => {}, project: async () => {}, hasHandle: () => false, tracking: () => true },
    myWorkers: () => localWorkers(root), workerAlive: () => false, others: () => [person], presences: () => [],
    withheld: () => undefined, shareOf: () => 'full', now: Date.now,
    baseFor: (_s: Session, name: string) => name === 'lead' ? git(root, 'rev-parse', 'HEAD') : workerHead,
    ctx: { probe: () => undefined, listCwdProcesses: () => [] },
  } as unknown as HandlerState
  const snapshot = () => ({ head: git(root, 'rev-parse', 'HEAD'), index: git(root, 'write-tree'),
    files: Object.fromEntries([oldPath, newPath, 'lead-edit.txt', 'lead-delete.txt', 'lead-commit.txt', 'lead-new.txt'].map(p =>
      [p, fs.existsSync(path.join(root, p)) ? fs.readFileSync(path.join(root, p), 'utf8') : null])) })
  return { root, worker, person, state, snapshot }
}

const changes: Change[] = ['committed rename', 'staged rename', 'committed deletion']
it.each(changes)('preview applies %s and keeps independent lead changes', async change => {
  const t = await fixture(change), before = t.snapshot()
  const run = `test ! -e ${oldPath} && ${change === 'committed deletion' ? `test ! -e ${newPath}` : `test "$(cat ${newPath})" = 'return 42'`} && test ! -e lead-delete.txt && test "$(cat lead-edit.txt)" = 'uncommitted lead edit' && test "$(cat lead-commit.txt)" = 'independent commit' && test "$(cat lead-new.txt)" = 'untracked lead file' && echo '1 passed'`
  const reply = await fileHandlers(t.state).room_preview_merge({ person: t.person, run })
  expect(reply).toContain('tests: PASSED (exit 0)')
  expect(reply).not.toContain('PARTIAL preview')
  expect(t.snapshot()).toEqual(before)
})

it.each(changes)('keep-collection applies %s without staging or reverting lead changes', async change => {
  const t = await fixture(change), before = t.snapshot()
  const reply = await collectHandlers(t.state).room_collect({ tag: 'test', keep: true })
  expect(reply).toContain('kept test')
  expect(t.snapshot()).toEqual({ ...before, files: { ...before.files, [oldPath]: null, ...(change === 'committed deletion' ? {} : { [newPath]: script }) } })
  expect(fs.existsSync(t.worker)).toBe(true)
  expect(await collectHandlers(t.state).room_collect({ tag: 'test', keep: true })).toContain('already present')
  expect(t.snapshot().head).toBe(before.head)
  expect(t.snapshot().index).toBe(before.index)
})

it.each(['committed rename', 'committed deletion'] as const)('preview applies a published peer %s with no deletion manifest entry', async change => {
  const t = await fixture(change, true), before = t.snapshot()
  const reply = await fileHandlers(t.state).room_preview_merge({ person: t.person,
    run: `test ! -e ${oldPath} && ${change === 'committed deletion' ? `test ! -e ${newPath}` : `test "$(cat ${newPath})" = 'return 42'`} && echo '1 passed'` })
  expect(reply).toContain('tests: PASSED (exit 0)')
  expect(reply).not.toContain('PARTIAL preview')
  expect(t.snapshot()).toEqual(before)
})

it.each(['preview', 'collect'] as const)('%s refuses a rename source deletion conflicting with a lead edit', async operation => {
  const t = await fixture('committed rename')
  put(t.root, oldPath, 'lead changed this source\n')
  const before = t.snapshot()
  const reply = operation === 'preview'
    ? await fileHandlers(t.state).room_preview_merge({ person: t.person })
    : await collectHandlers(t.state).room_collect({ tag: 'test', keep: true })
  expect(reply).toContain(operation === 'preview' ? 'CONFLICTS' : 'Nothing written; conflicting files')
  expect(reply).toContain(oldPath)
  expect(t.snapshot()).toEqual(before)
})

it('default preview selects a present peer whose committed rename removes an overlapping path', async () => {
  const t = await fixture('committed rename', true), session = t.state.S()
  put(t.root, oldPath, 'lead changed this source\n')
  publishFixture(session.room, 'lead', oldPath, 'lead changed this source\n', { base: git(t.root, 'rev-parse', 'HEAD') })
  const holder = session.room.participants.get(`${t.person}\0holder`)!
  session.awareness.getStates = () => new Map([[1, { user: { name: t.person, kind: 'agent' }, sessionId: holder.sessionId, at: Date.now() }]])
  t.state.presences = () => [{ user: { name: t.person, kind: 'agent' } }] as ReturnType<HandlerState['presences']>
  const before = t.snapshot(), reply = await fileHandlers(t.state).room_preview_merge({})
  expect(reply).toContain('CONFLICTS')
  expect(reply).toContain(oldPath)
  expect(t.snapshot()).toEqual(before)
})
