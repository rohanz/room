import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { clearFixture, publishFixture } from './fixtures/manifest.js'
import { visiblePeer } from './fixtures/visible.js'
import { registerWorkers } from './registry-fixture.js'
import { testPolicyStore } from './policy-fixture.js'
import { hubSeam } from './fixtures/hub.js'

const gitShowFailure = vi.hoisted(() => ({ error: undefined as Error | undefined }))
const probeFailure = vi.hoisted(() => ({ error: undefined as Error | undefined, stderr: '' }))
vi.mock('@room/roomd/git', async importOriginal => {
  const original = await importOriginal<typeof import('@room/roomd/git')>()
  return { ...original, gitShow: async (...args: Parameters<typeof original.gitShow>) => {
    if (gitShowFailure.error) throw gitShowFailure.error
    return original.gitShow(...args)
  } }
})
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, execFile: (file: string, args: string[], options: { cwd: string }, done: (error: Error | null, stdout: string, stderr: string) => void) => {
    const baseProbe = (args[0] === 'cat-file' && args[1] === '-e') || (args[0] === 'rev-parse' && args[1] === '--verify')
    if (file === 'git' && baseProbe && probeFailure.error) {
      done(probeFailure.error, '', probeFailure.stderr)
      return undefined
    }
    return original.execFile(file, args, options, done)
  } }
})

const dirs: string[] = []
afterEach(() => {
  gitShowFailure.error = undefined
  probeFailure.error = undefined
  probeFailure.stderr = ''
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function flaskChanges() {
  const dir = mkdtempSync(join(tmpdir(), 'room-diff-base-'))
  dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Ana')
  git('config', 'user.email', 'ana@example.test')
  const original = 'Changelog\n=========\n\nExisting release notes.\n'
  const anaEntry = 'Ana: fixed autoescaping.\n'
  const benEntry = 'Ben: fixed request validation.\n'
  writeFileSync(join(dir, 'CHANGES.rst'), original)
  git('add', 'CHANGES.rst')
  git('commit', '-qm', 'base')
  const oldBase = git('rev-parse', 'HEAD')
  writeFileSync(join(dir, 'CHANGES.rst'), original + anaEntry)
  git('commit', '-qam', 'Ana changelog entry')
  const readerBase = git('rev-parse', 'HEAD')

  const room = new RoomDoc(new Y.Doc())
  room.setMeta({ repo: 'flask', branch: 'main' })
  visiblePeer(room, 'Ana')
  room.participants.set('Ana\0git', { base: readerBase, head: readerBase, fence: '1', rev: 1 })
  publishFixture(room, 'Ben', 'CHANGES.rst', original + benEntry, { base: oldBase })
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { name: 'Ana', kind: 'agent', color: '#000' }, status: 'idle' })
  const session = {
    room, awareness, me: { name: 'Ana', kind: 'agent' }, dir,
    roomUrl: 'ws://x/r', roomName: 'r', browserUrl: 'http://x',
    provider: { synced: true, awareness },
    daemon: { touch() {}, async stop() {}, dir, name: 'Ana', roomDoc: room, base: readerBase, fence: '1' },
    policyStore: testPolicyStore('full'),
    ...hubSeam(room),
  } as unknown as Session
  const tools = createTools({ getSession: () => session, setSession: () => {}, cwd: dir })
  return { tools, dir, git, oldBase, readerBase, anaEntry, benEntry, awareness, room, session }
}

it.each([
  ['one file', { path: 'CHANGES.rst' }],
  ['all diffs', {}],
])('room_read diff of Ben after Ana commits shows only Ben’s change (%s)', async (_name, options) => {
  const t = flaskChanges()
  try {
    const diff = await t.tools.call('room_read', { person: 'Ben', diff: true, ...options })
    expect(diff).toContain(`+${t.benEntry}`)
    expect(diff).not.toContain(`-${t.anaEntry}`)
    expect(diff).toContain(`Ben is on base ${t.oldBase.slice(0, 10)}`)
    expect(diff).toContain(`you are on ${t.readerBase.slice(0, 10)}`)
  } finally {
    await t.tools.shutdown()
    t.awareness.destroy()
    t.room.doc.destroy()
  }
})

it('a teammate overlay still asks for fetch when its base is absent locally', async () => {
  const t = flaskChanges()
  try {
    publishFixture(t.room, 'Ben', 'CHANGES.rst', 'Ben: other change\n', { base: 'c0ffee0000000000000000000000000000000000' })
    const diff = await t.tools.call('room_read', { person: 'Ben', path: 'CHANGES.rst', diff: true })
    expect(diff).toMatch(/error: Ben's HEAD c0ffee0000 is not in this clone/)
    expect(diff).toContain('run git fetch, then retry')
  } finally {
    await t.tools.shutdown()
    t.awareness.destroy()
    t.room.doc.destroy()
  }
})

it.each(['git show timed out after 30000ms', 'git show failed: permission denied'])(
  'a git failure with a present teammate base is reported unchanged (%s)', async message => {
    const t = flaskChanges()
    try {
      gitShowFailure.error = new Error(message)
      const diff = await t.tools.call('room_read', { person: 'Ben', path: 'CHANGES.rst', diff: true })
      expect(diff).toContain(message)
      expect(diff).not.toContain('git fetch')
      expect(diff).not.toContain("Ben's HEAD")
    } finally {
      await t.tools.shutdown()
      t.awareness.destroy()
      t.room.doc.destroy()
    }
  }
)

it('keeps the Git error for an unchanged teammate file whose base read fails', async () => {
  const t = flaskChanges()
  try {
    clearFixture(t.room, 'Ben', 'CHANGES.rst')
    gitShowFailure.error = new Error('git show failed: permission denied')
    const diff = await t.tools.call('room_read', { person: 'Ben', path: 'CHANGES.rst', diff: true })
    expect(diff).toContain('git show failed: permission denied')
    expect(diff).not.toContain('git fetch')
  } finally {
    await t.tools.shutdown()
    t.awareness.destroy()
    t.room.doc.destroy()
  }
})

it.each([
  ['spawn denied', Object.assign(new Error('spawn git EACCES'), { code: 'EACCES' }), ''],
  ['git exit 128', Object.assign(new Error('git failed'), { code: 128 }), 'fatal: permission denied'],
  ['probe timeout', Object.assign(new Error('git killed'), { killed: true, signal: 'SIGTERM' }), ''],
])('keeps the original show error when the base probe has an operational failure (%s)', async (_case, error, stderr) => {
  const t = flaskChanges()
  try {
    gitShowFailure.error = new Error('git show failed: EACCES')
    probeFailure.error = error
    probeFailure.stderr = stderr
    const diff = await t.tools.call('room_read', { person: 'Ben', path: 'CHANGES.rst', diff: true })
    expect(diff).toContain('git show failed: EACCES')
    expect(diff).not.toContain('git fetch')
    expect(diff).not.toContain("Ben's HEAD")
  } finally {
    await t.tools.shutdown()
    t.awareness.destroy()
    t.room.doc.destroy()
  }
})

it('a connected carried worker diff contains only the worker edit and no misleading base note', async () => {
  const t = flaskChanges()
  const name = 'Ana+w'
  const carriedEntry = 'Ana: carried uncommitted wording.\n'
  const workerEntry = 'Worker: revised validation note.\n'
  const carriedText = `Changelog\n=========\n\nExisting release notes.\n${t.anaEntry}${carriedEntry}`
  const workerDir = join(t.dir, '.room', 'workers', 'w')
  try {
    mkdirSync(join(t.dir, '.room', 'workers'), { recursive: true })
    t.git('worktree', 'add', '-qb', 'room/w', workerDir, t.readerBase)
    writeFileSync(join(workerDir, 'CHANGES.rst'), carriedText)
    execFileSync('git', ['-C', workerDir, 'commit', '-qam', 'carried lead work'])
    const carriedBase = execFileSync('git', ['-C', workerDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    writeFileSync(join(workerDir, 'CHANGES.rst'), carriedText + workerEntry)
    await registerWorkers(t.session, [{ tag: 'w', name, lead: 'Ana', host: 'codex', task: 'edit changelog', dir: workerDir,
      branch: 'room/w', pid: 0, startedAt: Date.now(), status: 'running', base: carriedBase, carriedBase }])

    for (const args of [{ path: 'CHANGES.rst' }, {}]) {
      const diff = await t.tools.call('room_read', { person: name, diff: true, ...args })
      expect(diff).toContain(`+${workerEntry}`)
      expect(diff).not.toContain(`+${carriedEntry}`)
      expect(diff).not.toContain(`-${carriedEntry}`)
      expect(diff).not.toContain('commits only one of you has')
      expect(diff).not.toContain('note: Ana+w is on base')
    }
  } finally {
    await t.tools.shutdown()
    t.awareness.destroy()
    t.room.doc.destroy()
  }
})
