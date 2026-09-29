import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { afterEach, expect, it, vi } from 'vitest'
import { RoomDoc, digestPath, gitBlobHash, manifestKey, snapshot, versionOf } from '@room/shared'
import { gitShow } from '@room/roomd/git'
import { handlers } from '../src/tools/files.js'
import { WorkerRegistry } from '../src/worker-registry.js'
import type { HandlerState } from '../src/tools/context.js'
import type { Session } from '../src/session.js'
import { hubSeam } from './fixtures/hub.js'

let root: string | undefined
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined })

function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-manifest-preview-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root!, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Alice')
  git('config', 'user.email', 'alice@example.test')
  fs.writeFileSync(path.join(root, 'app.py'), 'base\n')
  fs.writeFileSync(path.join(root, 'tests.txt'), 'base tests\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  const room = new RoomDoc()
  room.ensureRoomSalt()
  room.setMeta({ base, branch: 'main', repo: 'demo' })
  room.participants.set('ben\0holder', { sessionId: 'ben-1', epoch: 1 })
  room.participants.set('ben\0git', { base, head: base, fence: '1', rev: 1 })
  const head = { base, fence: '1', coverage: { kind: 'all' as const }, level: 'declared' as const,
    excluded: [] as string[], rev: 1, semRev: 1, scannedAt: Date.now(), complete: true }
  room.manifestHead.set('ben', head)
  const entries = new Y.Map<any>(), texts = new Y.Map<Y.Text>()
  room.manifest.set(manifestKey('ben', '1'), entries)
  room.overlays.set(manifestKey('ben', '1'), texts)
  const session = { dir: root, room, me: { name: 'alice', kind: 'agent' }, roomName: 'local/demo/main',
    awareness: { getStates: () => new Map([[1, { user: { name: 'ben', kind: 'agent' }, sessionId: 'ben-1', at: Date.now() }]]) }, ...hubSeam(room) } as unknown as Session
  const state = { S: () => session, rooms: { all: () => [session], holding: () => session },
    others: () => ['ben'], presences: () => [], myWorkers: () => [], baseFor: () => base, now: () => Date.now(),
    readVersion: (_s: Session, pathname: string, person: string) => versionOf(snapshot(room, person, []), pathname,
      { gitAt: (sha, relpath) => gitShow(root!, sha, relpath) }),
  } as unknown as HandlerState
  return { room, head, entries, texts, session, state }
}

it('bounds an own-disk room_read before rendering file lines', async () => {
  const { state } = fixture()
  fs.writeFileSync(path.join(root!, 'app.py'), 'x'.repeat(512 * 1024 + 1))
  await expect(handlers(state).room_read({ path: 'app.py' })).rejects.toThrow('file too large for Room read')
})

it('reports an oversized historical base as a named preview and diff gap', async () => {
  const { room, head, entries, texts, state } = fixture()
  fs.writeFileSync(path.join(root!, 'app.py'), 'x'.repeat(512 * 1024 + 1))
  execFileSync('git', ['add', 'app.py'], { cwd: root! })
  execFileSync('git', ['commit', '-qm', 'large old text'], { cwd: root! })
  const largeBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root!, encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(root!, 'app.py'), 'small replacement\n')
  room.participants.set('ben\0git', { base: largeBase, head: largeBase, fence: '1', rev: 2 })
  room.manifestHead.set('ben', { ...head, base: largeBase, rev: 2, semRev: 2 })
  state.baseFor = () => largeBase
  const changed = 'ben replacement\n'
  entries.set('app.py', { change: 'M', state: 'shared', hash: gitBlobHash(changed), size: changed.length, at: 1, fence: '1' })
  texts.set('app.py', new Y.Text(changed))
  const diff = await handlers(state).room_read({ person: 'ben', path: 'app.py', diff: true })
  expect(diff).toContain('historical text exceeds Room read limit')
  const preview = await handlers(state).room_preview_merge({ person: 'ben' })
  expect(preview).toContain('PARTIAL preview')
  expect(preview).toContain('app.py')
  expect(preview).toContain('historical text exceeds Room read limit')
})

it('yields during the path-safety pass before checking the last path', async () => {
  const { entries, state } = fixture()
  for (let i = 0; i < 96; i++) entries.set(`held-${String(i).padStart(3, '0')}`, {
    change: 'M', state: 'held', held: 'scope', at: 1, fence: '1',
  })
  const realpath = fs.realpathSync.bind(fs)
  let turned = false, sawTurn = false
  const registryReads = vi.spyOn(WorkerRegistry, 'snapshot')
  const spy = vi.spyOn(fs, 'realpathSync').mockImplementation(((file: string) => {
    if (file.endsWith('held-000')) setImmediate(() => { turned = true })
    if (file.endsWith('held-095')) sawTurn = turned
    return realpath(file)
  }) as typeof fs.realpathSync)
  try {
    await handlers(state).room_preview_merge({ person: 'ben' })
    expect(sawTurn).toBe(true)
    expect(registryReads.mock.calls.length).toBeLessThanOrEqual(8)
  } finally { spy.mockRestore(); registryReads.mockRestore() }
})

it('retains held paths as partial gaps instead of silently dropping them', async () => {
  const { entries, state } = fixture()
  for (let i = 0; i < 96; i++) entries.set(`held-${String(i).padStart(3, '0')}`, {
    change: 'M', state: 'held', held: 'scope', at: 1, fence: '1',
  })
  const result = await handlers(state).room_preview_merge({ person: 'ben' })
  expect(result).toContain('PARTIAL preview')
  expect(result).toContain('final combined tree: 96 path(s) applied')
  expect(result).toContain("held-095: ben's version not included")
})

it('services an event-loop turn between merged file materialisations', async () => {
  const { entries, texts, state } = fixture()
  for (const [rel, value] of [['app.py', 'changed app\n'], ['tests.txt', 'changed tests\n']] as const) {
    entries.set(rel, { change: 'M', state: 'shared', hash: gitBlobHash(value), size: Buffer.byteLength(value), at: Date.now(), fence: '1' })
    texts.set(rel, new Y.Text(value))
  }
  const write = fs.writeFileSync.bind(fs)
  let first = false
  let turned = false
  let secondSawTurn = false
  const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: Parameters<typeof fs.writeFileSync>[0], data: Parameters<typeof fs.writeFileSync>[1], options?: Parameters<typeof fs.writeFileSync>[2]) => {
    if (typeof file === 'number' && Buffer.isBuffer(data) && (data.toString() === 'changed app\n' || data.toString() === 'changed tests\n')) {
      if (first) secondSawTurn = turned
      else { first = true; setImmediate(() => { turned = true }) }
    }
    return write(file, data, options)
  }) as typeof fs.writeFileSync)
  try {
    const result = await handlers(state).room_preview_merge({ person: 'ben', run: 'echo "1 passed"' })
    expect(result).toContain('tests: PASSED')
    expect(first).toBe(true)
    expect(secondSawTurn).toBe(true)
  } finally { spy.mockRestore() }
})

it('services an event-loop turn within preview mode preparation', async () => {
  const { entries, texts, state } = fixture()
  for (let i = 0; i < 96; i++) {
    const rel = `mode-${String(i).padStart(3, '0')}.txt`, value = `worker ${i}\n`
    entries.set(rel, { change: 'A', state: 'shared', hash: gitBlobHash(value), size: Buffer.byteLength(value), at: 1, fence: '1' })
    texts.set(rel, new Y.Text(value))
  }
  const lstat = fs.lstatSync.bind(fs)
  let turned = false, lastSawTurn = false
  const seam = vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
    const inModePreparation = new Error().stack?.split('\n').slice(1, 4).join('\n').includes('Object.room_preview_merge')
    if (inModePreparation && String(file) === path.join(root!, 'mode-000.txt')) setImmediate(() => { turned = true })
    if (inModePreparation && String(file) === path.join(root!, 'mode-095.txt')) lastSawTurn = turned
    return lstat(file, options as never)
  }) as typeof fs.lstatSync)
  try {
    expect(await handlers(state).room_preview_merge({ person: 'ben', run: 'echo "1 passed"' })).toContain('tests: PASSED')
    expect(lastSawTurn).toBe(true)
  } finally { seam.mockRestore() }
})

it('marks a changed disk symlink as a named partial gap even if a scratch test passes', async () => {
  const { room, session, state } = fixture()
  fs.unlinkSync(path.join(root!, 'app.py'))
  fs.symlinkSync(path.join(os.tmpdir(), 'outside-room-preview'), path.join(root!, 'app.py'))
  const result = await handlers(state).room_preview_merge({ person: 'ben', run: 'test ! -L app.py && echo "1 passed"' })
  expect(result).toContain('PARTIAL preview')
  expect(result).toContain('app.py')
  expect(session.lastPreview).toMatchObject({ complete: false, testsPassed: false })
  expect(room.messages().some(message => message.type === 'note' && message.text.includes('partial preview') && message.text.includes('app.py'))).toBe(true)
})

it('marks a changed tracked file replaced by a directory as partial', async () => {
  const { session, state } = fixture()
  fs.unlinkSync(path.join(root!, 'app.py'))
  fs.mkdirSync(path.join(root!, 'app.py'))
  fs.writeFileSync(path.join(root!, 'app.py', 'nested.py'), 'replacement\n')
  const result = await handlers(state).room_preview_merge({ person: 'ben' })
  expect(result).toContain('PARTIAL preview')
  expect(result).toContain('app.py')
  expect(session.lastPreview?.complete).toBe(false)
})

it('keeps a hashless held file out of the combined tree and records a partial passing run', async () => {
  const { room, entries, texts, session, state } = fixture()
  entries.set('app.py', { change: 'M', state: 'held', held: 'scope', at: Date.now(), fence: '1' })
  entries.set('tests.txt', { change: 'M', state: 'shared', hash: gitBlobHash('tests pass\n'), size: 11, at: Date.now(), fence: '1' })
  texts.set('tests.txt', new Y.Text('tests pass\n'))
  const heldRead = await handlers(state).room_read({ person: 'ben', path: 'app.py' })
  expect(heldRead).toContain('outside their declared area')
  expect(heldRead).not.toContain('base\n')
  expect(heldRead).not.toContain('bytes')
  const result = await handlers(state).room_preview_merge({ person: 'ben', run: 'test "$(cat tests.txt)" = "tests pass" && echo "1 passed"' })
  expect(result).toContain('PARTIAL preview')
  expect(result).toContain('app.py')
  expect(result).toContain('outside ben\'s declared area')
  expect(result).toContain('ran on a partial tree')
  expect(session.lastPreview).toMatchObject({ complete: false, testsPassed: false, partialPassed: true })
  const notes = room.messages().filter(message => message.type === 'note' && message.text.includes('partial preview'))
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toContain('app.py')
  expect(notes[0].text).toContain('test "$(cat tests.txt)"')
  expect(notes[0].text).toContain('passed on a PARTIAL tree')
})

it('reports anonymous exclusion and intent gaps even with no mergeable paths', async () => {
  const { room, head, session, state } = fixture()
  room.manifestHead.set('ben', { ...head, excluded: [digestPath(room.ensureRoomSalt(), 'app.py')], semRev: 2 })
  const excluded = await handlers(state).room_preview_merge({ person: 'ben' })
  expect(excluded).toContain('PARTIAL preview')
  expect(excluded).toContain('names not shared')
  expect(session.lastPreview?.complete).toBe(false)
  expect(room.messages().filter(m => m.type === 'note' && m.text.includes('partial preview'))).toHaveLength(1)
  room.manifestHead.set('ben', { ...head, coverage: { kind: 'none', reason: 'intent' }, semRev: 3 })
  const intent = await handlers(state).room_preview_merge({ person: 'ben' })
  expect(intent).toContain('PARTIAL preview')
  expect(intent).toContain('coverage intent')
  expect(room.messages().filter(m => m.type === 'note' && m.text.includes('partial preview'))).toHaveLength(2)
})

it('records a partial ledger note when automatic selection cannot enumerate a present peer', async () => {
  const { room, head, state, session } = fixture()
  room.setScope('alice', { area: 'app', summary: 'work', paths: ['app.py'], byKind: 'agent' })
  room.setScope('ben', { area: 'app', summary: 'work', paths: ['app.py'], byKind: 'agent' })
  state.presences = () => [{ user: { name: 'ben', kind: 'agent' } }] as never
  state.baseFor = (_s: Session, person: string) => person === 'ben' ? 'unavailable-commit' : head.base
  const result = await handlers(state).room_preview_merge({})
  expect(result).toContain('PARTIAL preview')
  expect(session.lastPreview?.complete).toBe(false)
  expect(room.messages().filter(m => m.type === 'note' && m.text.includes('partial preview'))).toHaveLength(1)
})

it('default preview includes a present neighbour whose only overlapping change is committed', async () => {
  const { room, head, session, state } = fixture()
  room.setScope('alice', { area: 'app', summary: 'work', paths: ['app.py'], byKind: 'agent' })
  fs.writeFileSync(path.join(root!, 'app.py'), 'ben committed\n')
  execFileSync('git', ['add', '.'], { cwd: root! })
  execFileSync('git', ['commit', '-qm', 'ben change'], { cwd: root! })
  const changedBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root!, encoding: 'utf8' }).trim()
  room.participants.set('ben\0git', { base: changedBase, head: changedBase, fence: '1', rev: 2 })
  room.manifestHead.set('ben', { ...head, base: changedBase, rev: 2 })
  state.presences = () => [{ user: { name: 'ben', kind: 'agent' } }] as never
  state.baseFor = (_s: Session, person: string) => person === 'ben' ? changedBase : head.base
  const result = await handlers(state).room_preview_merge({})
  expect(result).toContain('ben')
  expect(result).not.toContain('no present participants to merge')
  expect(session.lastPreview).toBeDefined()
})

it('names a pushed participant commit in complete and partial preview notes', async () => {
  const { room, head, entries, state } = fixture()
  fs.writeFileSync(path.join(root!, 'app.py'), 'ben committed\n')
  execFileSync('git', ['add', '.'], { cwd: root! })
  execFileSync('git', ['commit', '-qm', 'ben change'], { cwd: root! })
  const pushed = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root!, encoding: 'utf8' }).trim()
  const origin = path.join(root!, '.git', 'origin.git')
  execFileSync('git', ['init', '--bare', '-q', origin])
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: root! })
  execFileSync('git', ['push', '-q', 'origin', 'HEAD:r17-b'], { cwd: root! })
  expect(execFileSync('git', ['rev-parse', 'refs/remotes/origin/r17-b'], { cwd: root!, encoding: 'utf8' }).trim()).toBe(pushed)
  room.participants.set('ben\0git', { base: pushed, head: pushed, branch: 'r17-b', upstream: 'origin/r17-b', ahead: 0, fence: '1', rev: 2 })
  room.manifestHead.set('ben', { ...head, base: pushed, rev: 2, semRev: 2 })
  state.baseFor = (_s: Session, person: string) => person === 'ben' ? pushed : head.base
  const result = await handlers(state).room_preview_merge({ person: 'ben' })
  const anchor = `ben at ${pushed.slice(0, 10)} (pushed to origin/r17-b)`
  expect(result).toContain(anchor)
  expect(room.messages().find(message => message.type === 'note' && message.text.includes('merge preview with ben'))?.text).toContain(anchor)
  entries.set('app.py', { change: 'M', state: 'held', held: 'scope', at: Date.now(), fence: '1' })
  const partial = await handlers(state).room_preview_merge({ person: 'ben' })
  expect(partial).toContain('PARTIAL preview')
  expect(partial).toContain(anchor)
  expect(room.messages().find(message => message.type === 'note' && message.text.includes('partial preview with ben'))?.text).toContain(anchor)
})

it('names the accepted base after a combined-tree retry', async () => {
  const { room, head, state, session } = fixture()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root!, encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(root!, 'app.py'), 'older\n')
  git('add', 'app.py'); git('commit', '-qm', 'C1')
  const c1 = git('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(root!, 'app.py'), 'newest\n')
  git('add', 'app.py'); git('commit', '-qm', 'C2')
  const c2 = git('rev-parse', 'HEAD')
  git('reset', '--hard', head.base)
  const publish = (base: string, rev: number) => {
    room.participants.set('ben\0git', { base, head: base, branch: 'r17-b', upstream: 'origin/r17-b', ahead: 0, fence: '1', rev })
    room.manifestHead.set('ben', { ...head, base, rev, semRev: rev })
  }
  publish(c1, 2)
  let reads = 0
  state.baseFor = (_s: Session, person: string) => {
    if (person !== 'ben') return head.base
    if (++reads === 2) publish(c2, 3)
    return reads >= 2 ? c2 : c1
  }
  const result = await handlers(state).room_preview_merge({ person: 'ben', run: 'test "$(cat app.py)" = newest && echo "1 passed"' })
  const note = room.messages().find(message => message.type === 'note' && message.text.includes('merge preview with ben'))?.text
  expect(reads).toBeGreaterThanOrEqual(3)
  expect(session.lastPreview).toMatchObject({ complete: true, testsPassed: true })
  expect(result).toContain(`ben at ${c2.slice(0, 10)}`)
  expect(result).not.toContain('(pushed to origin/r17-b)')
  expect(result).not.toContain(`ben at ${c1.slice(0, 10)}`)
  expect(note).toContain(`ben at ${c2.slice(0, 10)}`)
  expect(note).not.toContain('(pushed to origin/r17-b)')
  expect(note).not.toContain(`ben at ${c1.slice(0, 10)}`)
})

it('labels live changes from the accepted retry snapshot', async () => {
  const { room, head, entries, texts, state, session } = fixture()
  fs.writeFileSync(path.join(root!, 'app.py'), 'committed\n')
  execFileSync('git', ['add', 'app.py'], { cwd: root! })
  execFileSync('git', ['commit', '-qm', 'participant commit'], { cwd: root! })
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root!, encoding: 'utf8' }).trim()
  execFileSync('git', ['reset', '--hard', head.base], { cwd: root! })
  room.participants.set('ben\0git', { base, head: base, fence: '1', rev: 2 })
  room.manifestHead.set('ben', { ...head, base, rev: 2, semRev: 2 })
  let reads = 0
  state.baseFor = (_s: Session, person: string) => {
    if (person !== 'ben') return head.base
    if (++reads === 2) {
      entries.set('tests.txt', { change: 'M', state: 'shared', hash: gitBlobHash('live\n'), size: 5, at: Date.now(), fence: '1' })
      texts.set('tests.txt', new Y.Text('live\n'))
      room.manifestHead.set('ben', { ...head, base, rev: 2, semRev: 3 })
    }
    return base
  }
  const result = await handlers(state).room_preview_merge({ person: 'ben', run: 'test "$(cat tests.txt)" = live && echo "1 passed"' })
  const note = room.messages().find(message => message.type === 'note' && message.text.includes('merge preview with ben'))?.text
  expect(reads).toBeGreaterThanOrEqual(3)
  expect(session.lastPreview).toMatchObject({ complete: true, testsPassed: true })
  expect(result).toContain(`ben at ${base.slice(0, 10)} + live changes`)
  expect(note).toContain(`ben at ${base.slice(0, 10)} + live changes`)
})

it('fetches a reachable participant anchor before explicit preview and honours ROOM_AUTO_FETCH=0', async () => {
  const { room, head, state, session } = fixture()
  const origin = path.join(root!, '.git', 'origin.git')
  execFileSync('git', ['clone', '--bare', '-q', root!, origin])
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: root! })
  const other = path.join(root!, '.git', 'other')
  execFileSync('git', ['clone', '-q', origin, other])
  execFileSync('git', ['config', 'user.name', 'Ben'], { cwd: other })
  execFileSync('git', ['config', 'user.email', 'ben@example.test'], { cwd: other })
  fs.writeFileSync(path.join(other, 'app.py'), 'ben committed\n')
  execFileSync('git', ['add', '.'], { cwd: other })
  execFileSync('git', ['commit', '-qm', 'ben change'], { cwd: other })
  execFileSync('git', ['push', '-q', 'origin', 'HEAD:master'], { cwd: other })
  const b = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: other, encoding: 'utf8' }).trim()
  room.participants.set('ben\0git', { base: b, head: b, fence: '1', rev: 2 })
  room.manifestHead.set('ben', { ...head, base: b, rev: 2, semRev: 2 })
  state.baseFor = (_s: Session, person: string) => person === 'ben' ? b : head.base
  const before = process.env.ROOM_AUTO_FETCH
  try {
    process.env.ROOM_AUTO_FETCH = '0'
    await expect(handlers(state).room_preview_merge({ person: 'ben' })).rejects.toThrow('git fetch')
    process.env.ROOM_AUTO_FETCH = '1'
    const fetched = await handlers(state).room_preview_merge({ person: 'ben' })
    expect(fetched).not.toContain('git fetch')
    expect(session.lastPreview?.complete).toBe(true)
  } finally { if (before === undefined) delete process.env.ROOM_AUTO_FETCH; else process.env.ROOM_AUTO_FETCH = before }
})

it('S1 keeps a manifest-overlapping peer when committed paths exceed the preview bound', async () => {
  const { room, head, entries, session, state } = fixture()
  room.setScope('alice', { area: 'app', summary: 'work', paths: ['app.py'], byKind: 'agent' })
  entries.set('app.py', { change: 'M', state: 'shared', hash: gitBlobHash('ben edit\n'), at: 1, fence: '1' })
  room.setOverlay(manifestKey('ben', '1'), 'app.py', 'ben edit\n')
  for (let i = 0; i < 2001; i++) fs.writeFileSync(path.join(root!, `bulk-${String(i).padStart(4, '0')}.txt`), `${i}\n`)
  execFileSync('git', ['add', '.'], { cwd: root! })
  execFileSync('git', ['commit', '-qm', 'large committed change'], { cwd: root! })
  const changedBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root!, encoding: 'utf8' }).trim()
  execFileSync('git', ['reset', '--hard', head.base], { cwd: root! })
  execFileSync('git', ['clean', '-fd'], { cwd: root! })
  room.participants.set('ben\0git', { base: changedBase, head: changedBase, fence: '1', rev: 2 })
  room.manifestHead.set('ben', { ...head, base: changedBase, rev: 2, semRev: 2 })
  state.presences = () => [{ user: { name: 'ben', kind: 'agent' } }] as never
  state.baseFor = (_s: Session, person: string) => person === 'ben' ? changedBase : head.base
  const selected = await handlers(state).room_preview_merge({})
  expect(selected).toContain('ben')
  expect(selected).toContain('PARTIAL preview')
  expect(selected).toContain('committed path enumeration')
  expect(selected).not.toContain('no present participants to merge')
  expect(session.lastPreview).toMatchObject({ complete: false, testsPassed: false })
  const explicit = await handlers(state).room_preview_merge({ person: 'ben' })
  expect(explicit).toContain('app.py')
  expect(explicit).toContain('committed path enumeration')
  expect(session.lastPreview?.complete).toBe(false)
  // 2,001 real files, a commit and two previews: the assertions are on outcomes; the limit only bounds a stuck run.
}, 120_000)
