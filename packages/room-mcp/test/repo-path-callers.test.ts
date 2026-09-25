import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoomDoc, type Worker } from '@room/shared'
import { handlers as collectHandlers } from '../src/tools/collect.js'
import { handlers as fileHandlers, materializeMergedFile, mergedFileMode } from '../src/tools/files.js'
import { buildCombinedTree } from '../src/tools/combined-tree.js'
import { createHandlerState, type HandlerState } from '../src/tools/context.js'
import { cleanupWorker, prepareWorkerLinks, prepareWorktree, resolveWorkerLinks } from '../src/workers.js'
import type { Session } from '../src/session.js'

let root: string, lead: string, worker: string, base: string
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-repo-path-callers-')))
  lead = path.join(root, 'lead'); worker = path.join(lead, '.room', 'workers', 'w')
  fs.mkdirSync(lead)
  git(lead, 'init', '-q', '-b', 'main'); git(lead, 'config', 'user.name', 'test'); git(lead, 'config', 'user.email', 'test@room')
  fs.writeFileSync(path.join(lead, 'file.txt'), 'base\n')
  git(lead, 'add', '.'); git(lead, 'commit', '-qm', 'base'); base = git(lead, 'rev-parse', 'HEAD')
  fs.appendFileSync(path.join(lead, '.git', 'info', 'exclude'), '.room/\n')
  git(lead, 'worktree', 'add', '-qb', 'room/w', worker)
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

const cases = ['a\\b', 'a//b', 'a/./b', 'a/../b', '.git/config', 'a/.git/config', '/tmp/nope']

describe('collection path policy through room_collect copy', () => {
  it('rejects lexical variants and all link components', async () => {
    const room = new RoomDoc(); room.setMeta({ repo: 'x', branch: 'main', base })
    room.setWorker({ id: 'lead/w#1', tag: 'w', name: 'lead+w', lead: 'lead', dir: worker, branch: 'room/w', status: 'done', exitCode: 0, task: 'x', host: 'codex', startedAt: 1, base })
    const session = { dir: lead, me: { name: 'lead', kind: 'agent' }, room, awareness: { getStates: () => new Map() } }
    const state = { S: () => session, rooms: { all: () => [session], holdingWorker: () => session, reserve: () => true, unreserve() {}, retireWorkers: async () => {} }, workerAlive: () => false } as unknown as HandlerState
    const call = collectHandlers(state).room_collect
    for (const rel of cases) expect(await call({ tag: 'w', mode: 'copy', paths: [rel] })).toMatch(/unsafe collection path/)
    fs.symlinkSync('file.txt', path.join(worker, 'inside'))
    fs.symlinkSync(path.join(root, 'outside'), path.join(worker, 'outside'))
    for (const rel of ['inside', 'outside']) expect(await call({ tag: 'w', mode: 'copy', paths: [rel] })).toMatch(/symlink collection path refused/)
    room.doc.destroy()
  }, 60_000)
})

describe('merged file output path policy', () => {
  it('rejects lexical variants and replaces leaf links without following them', () => {
    for (const rel of cases) expect(() => materializeMergedFile(worker, rel, Buffer.from('x'))).toThrow(/unsafe merged path/)
    const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'outside')
    fs.symlinkSync(outside, path.join(worker, 'outside-link'))
    fs.symlinkSync('file.txt', path.join(worker, 'inside-link'))
    materializeMergedFile(worker, 'outside-link', Buffer.from('new'))
    materializeMergedFile(worker, 'inside-link', Buffer.from('new'))
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside')
    expect(fs.readFileSync(path.join(worker, 'file.txt'), 'utf8')).toBe('base\n')
    expect(fs.lstatSync(path.join(worker, 'outside-link')).isFile()).toBe(true)
    expect(fs.lstatSync(path.join(worker, 'inside-link')).isFile()).toBe(true)
    fs.symlinkSync(outside, path.join(worker, 'ancestor'))
    expect(() => materializeMergedFile(worker, 'ancestor/nope', Buffer.from('x'))).toThrow(/unsafe merged ancestor/)
  })
  it('reads modes through contained links but refuses an escaping link', () => {
    fs.symlinkSync('file.txt', path.join(worker, 'inside'))
    fs.writeFileSync(path.join(root, 'outside'), 'outside')
    fs.symlinkSync(path.join(root, 'outside'), path.join(worker, 'outside'))
    const participant = { dir: worker, baseModes: new Map<string, number>() }
    expect(mergedFileMode('inside', 0o600, [participant])).toBe(0o600)
    expect(() => mergedFileMode('outside', 0o600, [participant])).toThrow(/ENOENT|unsafe worker mode path/)
  })
})

describe('worker link paths', () => {
  it('preserves lexical and symlink behavior in resolver and copier', () => {
    fs.writeFileSync(path.join(lead, 'a\\b'), 'backslash')
    fs.mkdirSync(path.join(lead, 'a', '.git'), { recursive: true })
    fs.writeFileSync(path.join(lead, 'a', '.git', 'config'), 'nested')
    for (const rel of ['a//b', 'a/./b', 'a/../b', 'a\\..', '.git/config', '.room/x', '/tmp/nope']) expect(() => resolveWorkerLinks(lead, [rel])).toThrow(/invalid link path/)
    expect(resolveWorkerLinks(lead, ['a\\b'])).toEqual(['a\\b'])
    expect(resolveWorkerLinks(lead, ['a/.git/config'])).toEqual(['a/.git/config'])
    fs.symlinkSync('file.txt', path.join(lead, 'inside'))
    fs.writeFileSync(path.join(root, 'outside'), 'outside')
    fs.symlinkSync(path.join(root, 'outside'), path.join(lead, 'outside'))
    expect(resolveWorkerLinks(lead, ['inside'])).toEqual(['inside'])
    expect(() => resolveWorkerLinks(lead, ['outside'])).toThrow(/link source escapes repo/)
    expect(prepareWorkerLinks(lead, worker, ['inside'])).toEqual(['inside'])
    expect(fs.lstatSync(path.join(worker, 'inside')).isSymbolicLink()).toBe(true)
  })
  it('refuses a source retargeted outside between link resolution and copying', () => {
    fs.writeFileSync(path.join(root, 'outside'), 'outside')
    const link = path.join(lead, 'changing')
    fs.symlinkSync('file.txt', link)
    const original = fs.realpathSync.bind(fs)
    let retargeted = false
    vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike) => {
      const result = original(p)
      if (path.basename(String(p)) === 'changing' && !retargeted) {
        retargeted = true
        fs.unlinkSync(link)
        fs.symlinkSync(path.join(root, 'outside'), link)
      }
      return result
    }) as typeof fs.realpathSync)
    expect(() => prepareWorkerLinks(lead, worker, ['changing'])).toThrow(/link source escapes repo: changing/)
    expect(fs.existsSync(path.join(worker, 'changing'))).toBe(false)
  })
})

it('carry distinguishes contained, escaping, and absolute symlink leaves', async () => {
  fs.writeFileSync(path.join(lead, 'untracked'), 'inside')
  fs.writeFileSync(path.join(root, 'outside'), 'outside')
  fs.symlinkSync('untracked', path.join(lead, 'inside-link'))
  fs.symlinkSync(path.join(root, 'outside'), path.join(lead, 'outside-link'))
  fs.symlinkSync(path.join(lead, 'untracked'), path.join(lead, 'absolute-link'))
  const result = await prepareWorktree(lead, 'carry', 'lead')
  expect(result.carriedUntracked?.map(entry => entry.path)).toContain('inside-link')
  expect(result.skippedCarry).toEqual(expect.arrayContaining([
    { path: 'outside-link', reason: 'path leaves repository' },
    { path: 'absolute-link', reason: 'absolute link' },
  ]))
})

it('rollback recovery skips invalid recorded paths before writing them', async () => {
  const prepared = await prepareWorktree(lead, 'recover', 'lead')
  const record = path.join(lead, '.git', 'room-carry', 'recover.json')
  const realRm = fs.promises.rm.bind(fs.promises)
  vi.spyOn(fs.promises, 'rm').mockImplementation((target, options) => {
    if (String(target) === record) throw new Error('late failure')
    return realRm(target, options)
  })
  const invalid = ['../escape', 'a//b', 'a/./b', 'a/../b', '/tmp/nope']
  const w = { tag: 'recover', name: 'lead+recover', lead: 'lead', dir: prepared.dir, branch: prepared.branch,
    status: 'done', exitCode: 0, carriedUntracked: invalid.map(rel => ({ path: rel, sha: '0'.repeat(40) })) } as Worker
  await expect(cleanupWorker(lead, w, true, true)).rejects.toThrow(/late failure/)
  expect(fs.existsSync(path.join(lead, 'escape'))).toBe(false)
})

describe('disk read paths', () => {
  it('room_read and preview keep their lexical and contained-link policies', async () => {
    const room = new RoomDoc(); room.setMeta({ repo: 'x', branch: 'main', base }); room.setBaseOf('lead', base)
    const localState = { publishUnder: 'publisher', watchedDirectory: 'same', user: { name: 'lead', kind: 'agent' } }
    const peerState = { watchedDirectory: 'same', user: { name: 'publisher', kind: 'agent' } }
    const awareness = { clientID: 1, getLocalState: () => localState, getStates: () => new Map([[1, localState], [2, peerState]]), meta: new Map([[2, { lastUpdated: Date.now() }]]) }
    const session = { dir: lead, me: { name: 'lead', kind: 'agent' }, room, local: true, awareness } as unknown as Session
    const state = { S: () => session, rooms: { holding: () => session }, withheld: () => undefined, liveText: async () => undefined, baseText: async () => undefined, baseFor: () => base, shareOf: () => 'full', ledgerLines: () => [], lines: () => 1 } as unknown as HandlerState
    const call = fileHandlers(state).room_read
    for (const rel of ['a/../b', '/tmp/nope']) await expect(call({ path: rel })).rejects.toThrow(/unsafe room path/)
    for (const rel of ['a//b', 'a/./b', 'a/.git/config', 'a\\b']) expect(await call({ path: rel })).not.toMatch(/unsafe room path/)
    fs.symlinkSync('file.txt', path.join(lead, 'inside'))
    fs.writeFileSync(path.join(root, 'outside'), 'outside')
    fs.symlinkSync(path.join(root, 'outside'), path.join(lead, 'outside'))
    expect(await call({ path: 'inside' })).toContain('base')
    await expect(call({ path: 'outside' })).rejects.toThrow(/unsafe room symlink/)
    room.setWorker({ id: 'lead/w#1', tag: 'w', name: 'lead+w', lead: 'lead', dir: worker, branch: 'room/w', status: 'done', exitCode: 0, task: 'x', host: 'codex', startedAt: 1, base })
    const actual = createHandlerState({ getSession: () => session, setSession() {}, cwd: lead })
    for (const rel of ['', 'a/../b', '/tmp/nope']) await expect(actual.liveText(session, rel, 'lead+w')).rejects.toThrow(/unsafe worker path/)
    for (const rel of ['a\\b', 'a//b', 'a/./b', 'a/.git/config']) await expect(actual.liveText(session, rel, 'lead+w')).resolves.toBeNull()
    await expect(actual.liveText(session, '.', 'lead+w')).rejects.toThrow(/unsafe worker path/)
    expect(await actual.liveText(session, '.git', 'lead+w')).toContain('gitdir:')
    fs.mkdirSync(path.join(worker, 'a', '.git'), { recursive: true })
    fs.writeFileSync(path.join(worker, 'a', '.git', 'config'), 'nested')
    expect(await actual.liveText(session, 'a/.git/config', 'lead+w')).toBe('nested')
    fs.symlinkSync('file.txt', path.join(worker, 'worker-inside'))
    fs.symlinkSync(path.join(root, 'outside'), path.join(worker, 'worker-outside'))
    expect(await actual.liveText(session, 'worker-inside', 'lead+w')).toBe('base\n')
    await expect(actual.liveText(session, 'worker-outside', 'lead+w')).rejects.toThrow(/unsafe worker symlink/)
    await buildCombinedTree(state, session, [], { diskOnly: true })
    room.doc.destroy()
  })
})

it('combined-tree preview reads contained link leaves and excludes escaping ones', async () => {
  fs.writeFileSync(path.join(root, 'outside'), 'outside')
  fs.symlinkSync('file.txt', path.join(lead, 'inside-link'))
  fs.symlinkSync(path.join(root, 'outside'), path.join(lead, 'outside-link'))
  const room = new RoomDoc(); room.setMeta({ repo: 'x', branch: 'main', base }); room.setBaseOf('lead', base)
  const session = { dir: lead, me: { name: 'lead', kind: 'agent' }, room, awareness: { getStates: () => new Map() } } as unknown as Session
  const state = { rooms: { holding: () => session }, liveText: async () => undefined, baseFor: () => base, shareOf: () => 'full' } as unknown as HandlerState
  const result = await buildCombinedTree(state, session, [], { diskOnly: true })
  expect(result.paths).toContain('inside-link')
  expect(result.initial.get('inside-link')).toBe('base\n')
  expect(result.paths).not.toContain('outside-link')
  expect(result.ignoredNotes.join('\n')).toContain('symlink leaving the worktree')
  room.doc.destroy()
})

it('refuses a worker root replaced by a symlink between files in one preview', async () => {
  for (const name of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(worker, name), `worker ${name}\n`)
  const outside = path.join(root, 'outside-worker')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'b.txt'), 'outside b\n')
  const room = new RoomDoc(); room.setMeta({ repo: 'x', branch: 'main', base })
  room.setBaseOf('lead', base); room.setBaseOf('lead+w', base)
  room.setWorker({ id: 'lead/w#1', tag: 'w', name: 'lead+w', lead: 'lead', dir: worker, branch: 'room/w', status: 'done', exitCode: 0, task: 'x', host: 'codex', startedAt: 1, base })
  const session = { dir: lead, me: { name: 'lead', kind: 'agent' }, room, local: true, awareness: { getStates: () => new Map() } } as unknown as Session
  const state = { rooms: { holding: () => session }, liveText: async () => undefined, baseFor: () => base, shareOf: () => 'full' } as unknown as HandlerState
  const parked = path.join(root, 'parked-worker')
  const read = fs.readFileSync.bind(fs)
  let swapped = false
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
    const result = read(file, options as BufferEncoding)
    if (String(file) === path.join(worker, 'a.txt') && !swapped) {
      swapped = true
      fs.renameSync(worker, parked)
      fs.symlinkSync(outside, worker, 'dir')
    }
    return result
  }) as typeof fs.readFileSync)
  try {
    await expect(buildCombinedTree(state, session, [{ person: 'lead+w', session }], { diskOnly: true }))
      .rejects.toThrow(/unsafe preview symlink: b\.txt/)
    expect(swapped).toBe(true)
  } finally {
    vi.restoreAllMocks()
    if (swapped) { fs.unlinkSync(worker); fs.renameSync(parked, worker) }
    room.doc.destroy()
  }
})

it('combined-tree disk sites retain their lexical path cases', async () => {
  fs.mkdirSync(path.join(lead, 'a', '.git'), { recursive: true })
  fs.writeFileSync(path.join(lead, 'a', 'b'), 'nested\n')
  fs.writeFileSync(path.join(lead, 'a\\b'), 'backslash\n')
  fs.writeFileSync(path.join(lead, 'a', '.git', 'config'), 'nested git\n')
  const preview = async (paths: string[]) => {
    const room = new RoomDoc(); room.setMeta({ repo: 'x', branch: 'main', base }); room.setBaseOf('lead', base); room.setBaseOf('peer', base)
    for (const rel of paths) room.setOverlay('peer', rel, 'peer\n')
    const session = { dir: lead, me: { name: 'lead', kind: 'agent' }, room, awareness: { getStates: () => new Map() } } as unknown as Session
    const state = { rooms: { holding: () => session }, liveText: async () => 'peer\n', baseFor: () => base, shareOf: () => 'full' } as unknown as HandlerState
    try { return await buildCombinedTree(state, session, [{ person: 'peer', session }]) }
    finally { room.doc.destroy() }
  }
  const accepted = ['a\\b', 'a//b', 'a/./b', '.git/config', 'a/.git/config']
  const result = await preview(accepted)
  expect(result.paths).toEqual(expect.arrayContaining(accepted))
  expect(result.initial.get('a\\b')).toBe('backslash\n')
  expect(result.initial.get('a/./b')).toBe('nested\n')
  for (const rel of ['a/../missing', 'a\\..\\missing', '/tmp/nope']) await expect(preview([rel])).rejects.toThrow(/unsafe preview path/)
  const blank = await preview([''])
  expect(blank.paths).not.toContain('')
  expect(blank.ignoredNotes.join('\n')).toContain('directory or nested repository')
}, 60_000)
