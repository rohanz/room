import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createSessionBinding } from '../src/binding.js'
import { sessionDirectory } from '../src/session.js'
import { WorkerRegistry } from '../src/worker-registry.js'
import { resolveConfig } from '../src/config.js'
import type { WorkerRecord } from '../src/worker-status.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-retire-binding-')); dirs.push(dir)
  execFileSync('git', ['init', '-q', dir])
  return dir
}

it('binds a healthy 0.17 session despite the previous session record intentionally left by 0.17.47', () => {
  const dir = repo(), common = path.join(dir, '.git'), target = sessionDirectory(common, 'current-session')
  fs.mkdirSync(target, { recursive: true })
  const hook = '{"companyTold":true}\n', old = '{"session_id":"previous-session","host":"claude"}\n'
  fs.writeFileSync(path.join(target, 'hook.json'), hook)
  fs.writeFileSync(path.join(common, 'room-session.json'), old)
  // v0.17.47 migrateLocalState returns true without renaming a different session's record.
  // This install already has native session-directory state; nothing needs importing.
  const b = createSessionBinding(dir, { ROOM_HOST: 'claude', CLAUDE_CODE_SESSION_ID: 'current-session' })
  expect(b.bound()).toEqual({ id: 'current-session', host: 'claude' })
  expect(b.dir()).toBe(target)
  expect(fs.readFileSync(path.join(common, 'room-session.json'), 'utf8')).toBe(old)
  expect(fs.readFileSync(path.join(target, 'hook.json'), 'utf8')).toBe(hook)
})

it('opens completed worker imports with old sources and journals without changing them', async () => {
  const common = path.join(repo(), '.git')
  const journal = path.join(common, 'room', 'registry', 'migration.json')
  fs.mkdirSync(path.dirname(journal), { recursive: true })
  const before = '{"v":1,"sources":{},"done":true}\n'
  fs.writeFileSync(journal, before)
  fs.writeFileSync(path.join(path.dirname(journal), 'migration.lock'), 'historical lock')
  for (const [dir, name] of [['room-local', 'old.ydoc'], ['room-carry', 'old.json']]) {
    fs.mkdirSync(path.join(common, dir)); fs.writeFileSync(path.join(common, dir, name), 'retained bytes')
  }
  const registry = await WorkerRegistry.open(common, { watch: false })
  try { expect((await registry.list()).records).toEqual([]) } finally { registry.close() }
  const reader = await WorkerRegistry.openReader(common)
  try { expect((await reader.list()).records).toEqual([]) } finally { reader.close() }
  expect(fs.readFileSync(journal, 'utf8')).toBe(before)
  expect(fs.readFileSync(path.join(path.dirname(journal), 'migration.lock'), 'utf8')).toBe('historical lock')
  expect(fs.readFileSync(path.join(common, 'room-local', 'old.ydoc'), 'utf8')).toBe('retained bytes')
})

it.each(['local/custom/scratch', 'local/custom', 'local/experiments'])('preserves unmarked custom choice %s', async room => {
  const dir = repo(), file = path.join(dir, '.git', 'room-choice.json'), before = JSON.stringify({ where: 'local', room, at: 1 })
  fs.writeFileSync(file, before)
  expect((await resolveConfig({ dir, env: {} })).room).toBe(room)
  expect(fs.readFileSync(file, 'utf8')).toBe(before)
})

it.each([false, true])('adopts an already imported worker once and preserves its capabilities with import done=%s', async done => {
  const dir = repo(), common = path.join(dir, '.git')
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base')
  git('add', '.')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base')
  const worker = path.join(dir, '.room', 'workers', 'imported')
  fs.mkdirSync(path.dirname(worker), { recursive: true }); git('worktree', 'add', '-qb', 'room/imported', worker)
  const token = { pid: 31, startTime: 'birth', executable: '/bin/agent', sessionId: 'old', nonce: 'nonce' }
  const record: WorkerRecord = {
    v: 1, id: 'w_imported', tag: 'imported', name: '', room: '', mode: 'local',
    lead: { participant: '', room: '', instance: token }, host: 'claude',
    budget: { threads: 1, memGb: 1, nice: 10 }, share: 'intent', task: 'historical task',
    dir: fs.realpathSync(worker), outside: false, branch: 'room/imported', prep: { step: 'prepared' },
    hostSessionId: 'retained-session', capabilities: { resume: true, signal: false, collect: 'copy' },
    phase: 'active', runs: [{ n: 1, mode: 'fresh', intentAt: 1, nonce: 'imported:w_imported', busFrontier: 0,
      promptMsgIds: [], launcher: token, launch: { outcome: 'imported' }, logStart: 0 }],
    legacy: { id: 'legacy:imported', source: worker, unowned: true }, createdAt: 1, seq: 1,
  }
  const root = path.join(common, 'room', 'registry')
  fs.mkdirSync(path.join(root, 'workers'), { recursive: true }); fs.mkdirSync(path.join(root, 'tags'))
  fs.writeFileSync(path.join(root, 'workers', 'w_imported.json'), JSON.stringify(record))
  fs.writeFileSync(path.join(root, 'tags', 'imported.json'), JSON.stringify({ id: record.id, holder: token, at: 1 }))
  const journal = JSON.stringify({ v: 1, sources: { 'worktree:pending': { id: 'w_pending', state: 'assigned' } }, done })
  fs.writeFileSync(path.join(root, 'migration.json'), journal)
  const registry = await WorkerRegistry.open(common, { watch: false, liveness: () => 'dead' })
  try {
    const lead = { participant: 'lead', room: 'local/repo', dir }
    const adopted = await registry.trusted(lead, 'imported')
    expect(adopted?.record).toMatchObject({ name: 'lead+imported', hostSessionId: 'retained-session', capabilities: record.capabilities })
    expect(await registry.trusted({ ...lead, participant: 'other' }, 'imported')).toBeUndefined()
    expect(fs.readFileSync(path.join(root, 'migration.json'), 'utf8')).toBe(journal)
  } finally { registry.close() }
})
