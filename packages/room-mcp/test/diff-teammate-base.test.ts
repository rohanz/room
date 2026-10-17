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
import { applyPatch } from 'diff'
import { hubSeam } from './fixtures/hub.js'
import { boundedTwoFilesPatch } from '../src/tools/reader-diff.js'
import { readDiffCache } from '../src/read-diff-cache.js'

vi.mock('../src/tools/reader-diff.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/tools/reader-diff.js')>()
  return { ...original, boundedTwoFilesPatch: vi.fn(original.boundedTwoFilesPatch) }
})

const gitShowFailure = vi.hoisted(() => ({ error: undefined as Error | undefined, onShow: undefined as ((ref: string, path: string) => void) | undefined }))
const probeFailure = vi.hoisted(() => ({ error: undefined as Error | undefined, stderr: '' }))
vi.mock('../src/tools/disk-text.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/tools/disk-text.js')>()
  return { ...original, readBoundedHistoricalText: async (...args: Parameters<typeof original.readBoundedHistoricalText>) => {
    if (gitShowFailure.error) throw gitShowFailure.error
    gitShowFailure.onShow?.(args[1], args[2])
    return original.readBoundedHistoricalText(...args)
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
  gitShowFailure.onShow = undefined
  probeFailure.error = undefined
  probeFailure.stderr = ''
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it.each(['single path', 'all paths'])('restarts the whole %s diff when Ben commits during its base read', async shape => {
  const t = flaskChanges()
  try {
    const second = 'SECOND.txt'
    const secondText = 'Ben second committed file\n'
    if (shape === 'all paths') publishFixture(t.room, 'Ben', second, secondText, { base: t.oldBase })
    writeFileSync(join(t.dir, 'CHANGES.rst'), `Changelog\n=========\n\nExisting release notes.\n${t.anaEntry}${t.benEntry}`)
    if (shape === 'all paths') writeFileSync(join(t.dir, second), secondText)
    t.git('add', '.')
    t.git('commit', '-qm', 'Ben committed both files')
    const committed = t.git('rev-parse', 'HEAD')
    let reads = 0
    gitShowFailure.onShow = (ref, pathname) => {
      if (ref !== t.oldBase || pathname !== (shape === 'all paths' ? second : 'CHANGES.rst')) return
      reads++
      if (reads !== 1) return
      publishFixture(t.room, 'Ben', 'CHANGES.rst', `Changelog\n=========\n\nExisting release notes.\n${t.anaEntry}${t.benEntry}`, { base: committed })
      if (shape === 'all paths') publishFixture(t.room, 'Ben', second, secondText, { base: committed })
    }
    const diff = await t.tools.call('room_read', { person: 'Ben', diff: true, ...(shape === 'single path' ? { path: 'CHANGES.rst' } : {}) })
    expect(reads).toBe(1)
    expect(diff).not.toContain(`+${t.benEntry}`)
    expect(diff).not.toContain(`+${secondText}`)
    expect(diff).not.toContain(`Ben is on base ${t.oldBase.slice(0, 10)}`)
    expect(diff).toContain(`Ben is on base ${committed.slice(0, 10)}`)
    expect(diff).toContain(shape === 'single path' ? 'no difference between base' : 'Ben coverage: all')
  } finally {
    await t.tools.shutdown()
    t.awareness.destroy()
    t.room.doc.destroy()
  }
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
  room.setMeta({ repo: 'flask' })
  visiblePeer(room, 'Ana')
  room.participants.set('Ana\0git', { base: readerBase, head: readerBase, fence: '1', rev: 1 })
  publishFixture(room, 'Ben', 'CHANGES.rst', original + benEntry, { base: oldBase })
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { name: 'Ana', kind: 'agent', color: '#000' }, status: 'idle' })
  const session = {
    room, awareness, me: { name: 'Ana', kind: 'agent' }, dir,
    roomUrl: 'ws://127.0.0.1:9/r', roomName: 'r', browserUrl: 'http://x',
    provider: { synced: true, awareness },
    daemon: { touch() {}, async stop() {}, dir, name: 'Ana', roomDoc: room, base: readerBase, fence: '1' },
    policyStore: testPolicyStore('full'),
    ...hubSeam(room),
  } as unknown as Session
  const tools = createTools({ getSession: () => session, setSession: () => {}, cwd: dir })
  return { tools, dir, git, oldBase, readerBase, anaEntry, benEntry, awareness, room, session }
}

it.each(['own', 'worker'] as const)('includes both sides of a staged rename in the %s all-path diff', async source => {
  const t = flaskChanges()
  try {
    const dir = source === 'own' ? t.dir : join(t.dir, '.room', 'workers', 'w')
    if (source === 'worker') {
      mkdirSync(join(t.dir, '.room', 'workers'), { recursive: true })
      t.git('worktree', 'add', '-qb', 'room/w', dir, t.readerBase)
      await registerWorkers(t.session, [{ tag: 'w', name: 'Ana+w', lead: 'Ana', host: 'codex', task: 'rename', dir,
        branch: 'room/w', pid: 0, startedAt: Date.now(), status: 'running', base: t.readerBase }])
    }
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
    git('config', 'diff.renames', 'true')
    git('mv', 'CHANGES.rst', 'RENAMED.rst')
    expect(git('diff', '--name-status', 'HEAD')).toMatch(/^R100\s/)
    const diff = await t.tools.call('room_read', { person: source === 'own' ? 'Ana' : 'Ana+w', diff: true })
    expect(diff).toContain('--- a/CHANGES.rst')
    expect(diff).toContain('+++ b/RENAMED.rst')
    expect(diff).toContain('-Changelog')
    expect(diff).toContain('+Changelog')
  } finally { await t.tools.shutdown(); t.awareness.destroy(); t.room.doc.destroy() }
})

it('directs a pathless text read to existing changed-path discovery and all diffs', async () => {
  const t = flaskChanges()
  try {
    const result = await t.tools.call('room_read', { person: 'Ben' })
    expect(result).toContain('room_state(all=true)')
    expect(result).toContain('diff=true')
    expect(await t.tools.call('room_read', { cursor: 'bad' })).toContain('cursor requires diff=true')
  } finally { await t.tools.shutdown(); t.awareness.destroy(); t.room.doc.destroy() }
})

it.each([{ path: 'NEW.txt' }, { path: 'NEW.txt', diff: true }, { diff: true }])('rejects an unregistered bare worker name instead of claiming no changes: %j', async args => {
  const t = flaskChanges()
  try {
    publishFixture(t.room, 'Ben+api', 'NEW.txt', 'published edit\n', { base: t.oldBase })
    const read = await t.tools.call('room_read', { person: 'api', ...args })
    expect(read).toContain('nobody called api')
    expect(read).toContain('Ben+api')
    expect(read).not.toMatch(/no manifest|no uncommitted changes/)
    expect(await t.tools.call('room_read', { person: 'Ben+api', ...args })).toContain('published edit')
  } finally { await t.tools.shutdown(); t.awareness.destroy(); t.room.doc.destroy() }
})

it.each(['single path', 'all paths'])('paginates %s diffs exactly and rejects a changed publication between pages', async shape => {
  const t = flaskChanges()
  try {
    const text = Array.from({ length: 1_000 }, (_, i) => `Ben new line ${i}: ${'x'.repeat(40)}\n`).join('')
    publishFixture(t.room, 'Ben', 'NEW.txt', text, { base: t.oldBase })
    const args = { person: 'Ben', diff: true, ...(shape === 'single path' ? { path: 'NEW.txt' } : {}) }
    const first = await t.tools.call('room_read', args)
    const firstCursor = /cursor="([^"]+)"/.exec(first)![1]
    let cursor: string | undefined, restored = ''
    do {
      const page = await t.tools.call('room_read', { ...args, ...(cursor ? { cursor } : {}) })
      expect(page.length).toBeLessThan(13_000)
      restored += page.slice(page.indexOf('\n') + 1, page.lastIndexOf('\n['))
      cursor = /cursor="([^"]+)"/.exec(page)?.[1]
    } while (cursor)
    if (shape === 'single path') expect(applyPatch('', restored.slice(restored.indexOf('===================================================================')))).toBe(text)
    else { expect(restored).toContain(`+${t.benEntry}`); expect(restored).toContain('+Ben new line 999:'); expect(restored).toContain('Ben coverage: all') }
    publishFixture(t.room, 'Ben', 'NEW.txt', text + 'later edit\n', { base: t.oldBase })
    expect(await t.tools.call('room_read', { ...args, cursor: firstCursor })).toContain('diff changed since the previous page')
  } finally { await t.tools.shutdown(); t.awareness.destroy(); t.room.doc.destroy() }
})

it('validates all inputs but does not regenerate any patches for multi-file continuations', async () => {
  const t = flaskChanges()
  try {
    const text = 'long source line\n'.repeat(2_000)
    for (const p of ['A.txt', 'B.txt']) publishFixture(t.room, 'Ben', p, text, { base: t.oldBase })
    vi.mocked(boundedTwoFilesPatch).mockClear()
    const args = { person: 'Ben', diff: true }
    const first = await t.tools.call('room_read', args)
    const initialCalls = vi.mocked(boundedTwoFilesPatch).mock.calls.length
    expect(initialCalls).toBe(3)
    let cursor = /cursor="([^"]+)"/.exec(first)![1]
    for (let i = 0; i < 2; i++) {
      const page = await t.tools.call('room_read', { ...args, cursor })
      expect(page).toContain('diff page')
      cursor = /cursor="([^"]+)"/.exec(page)![1]
      expect(vi.mocked(boundedTwoFilesPatch).mock.calls).toHaveLength(initialCalls)
    }
    publishFixture(t.room, 'Ben', 'B.txt', text + 'later\n', { base: t.oldBase })
    expect(await t.tools.call('room_read', { ...args, cursor })).toContain('diff changed')
    expect(vi.mocked(boundedTwoFilesPatch).mock.calls).toHaveLength(initialCalls)
  } finally { await t.tools.shutdown(); t.awareness.destroy(); t.room.doc.destroy() }
})

it.each(['disk bytes', 'path set', 'publication policy', 'publication during validation', 'shutdown'])('invalidates cached continuations on %s changes', async change => {
  const t = flaskChanges()
  try {
    const text = 'x'.repeat(30_000) + '\n'
    const disk = change === 'disk bytes' || change === 'path set'
    if (disk) writeFileSync(join(t.dir, 'NEW.txt'), text)
    else publishFixture(t.room, 'Ben', 'NEW.txt', text, { base: t.oldBase })
    const args = { person: disk ? 'Ana' : 'Ben', diff: true }
    const first = await t.tools.call('room_read', args)
    const cursor = /cursor="([^"]+)"/.exec(first)![1]
    const calls = vi.mocked(boundedTwoFilesPatch).mock.calls.length
    expect(await t.tools.call('room_read', { ...args, cursor })).toContain('diff page')
    expect(vi.mocked(boundedTwoFilesPatch).mock.calls).toHaveLength(calls)
    if (change === 'disk bytes') writeFileSync(join(t.dir, 'NEW.txt'), 'y'.repeat(30_000) + '\n')
    if (change === 'path set') writeFileSync(join(t.dir, 'ADDED.txt'), 'new path\n')
    if (change === 'publication policy') publishFixture(t.room, 'Ben', 'NEW.txt', text, { base: t.oldBase, level: 'intent' })
    if (change === 'publication during validation') gitShowFailure.onShow = () => {
      gitShowFailure.onShow = undefined
      publishFixture(t.room, 'Ben', 'NEW.txt', text + 'raced\n', { base: t.oldBase })
    }
    if (change === 'shutdown') {
      const request = JSON.stringify(['Ana', 'Ana', 'r', t.dir, 'Ben', null])
      expect(readDiffCache.get(t.session, request, cursor)).toBeDefined()
      await t.tools.shutdown()
      expect(readDiffCache.get(t.session, request, cursor)).toBeUndefined()
    } else expect(await t.tools.call('room_read', { ...args, cursor })).toContain('diff changed')
    expect(vi.mocked(boundedTwoFilesPatch).mock.calls).toHaveLength(calls)
  } finally { await t.tools.shutdown(); t.awareness.destroy(); t.room.doc.destroy() }
})

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
