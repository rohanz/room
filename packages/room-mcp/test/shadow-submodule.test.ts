// These regressions run in both the default and TEST_SCALE=1 passes.
import './shadow-controlled-fixture.js'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { afterEach, expect, it, vi } from 'vitest'
import { gitBlobHash, manifestKey, type ManifestEntry } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import { setGitObserver } from '@room/roomd/git'
import { ConflictShadow, enqueueShadow, shadowIdle, stopShadow } from '../src/conflict-shadow.js'
import { captureShadow } from '../src/shadow-snapshot.js'
import { ShadowGraph } from '../src/shadow-graph.js'
import type { ConflictSlot } from '../src/conflict-set.js'
import { registryForDir } from '../src/worker-registry.js'
import { baseVersions } from './shadow-publication-fixture.js'
import { commit, git, put, repo, world } from './worker-refresh-fixture.js'

const subpath = 'external/lib'
function submodule() {
  const child = path.join(path.dirname(repo), 'child')
  fs.mkdirSync(child)
  git(child, 'init', '-q', '-b', 'main'); git(child, 'config', 'user.name', 'test'); git(child, 'config', 'user.email', 'test@example.test')
  put(child, 'private.txt', 'SUBMODULE_CONTENT_MUST_NOT_BE_READ\n')
  const first = commit(child, 'first')
  put(child, 'private.txt', 'SECOND_SUBMODULE_CONTENT\n')
  const next = commit(child, 'second')
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, subpath)
  git(path.join(repo, subpath), 'checkout', '-q', first)
  const head = commit(repo, 'add real submodule')
  return { first, next, head }
}
afterEach(() => setGitObserver(undefined))

it('follows real spawn, clean/conflicting worker edits, kept collection and refresh beside a submodule', async () => {
  const { head, next } = submodule(), t = world({ repo, head }), s = t.leadSession(), logs: string[] = []
  vi.stubEnv('ROOM_CONFLICT_SHADOW', '1')
  let shadow!: ConflictShadow
  const enqueue = ConflictShadow.prototype.enqueue
  vi.spyOn(ConflictShadow.prototype, 'enqueue').mockImplementation(function (...args) { shadow = this; return enqueue.apply(this, args) })
  enqueueShadow(s, undefined, line => logs.push(line))
  await shadowIdle(s)
  expect(logs.some(line => line.includes('no workers spawned in this session'))).toBe(true)
  const d = await t.spawn('d'); await shadowIdle(s)
  const u = await t.spawn('u'); await shadowIdle(s)
  const state = shadow as any, registry = await registryForDir(repo), actors = [{ name: s.me.name, dir: repo, id: '' }, d, u]
  vi.spyOn(s.awareness, 'getStates').mockImplementation(() => new Map(actors.map((a, i) => [i,
    { user: { name: a.name, kind: 'agent' }, sessionId: `session-${a.name}` }])) as never)
  const versions = baseVersions()
  let clock = Date.now(), rev = 0
  state.now = () => clock
  async function observe() {
    clock += 60_001; rev++
    s.room.ensureRoomSalt()
    for (const a of actors) {
      const r = a.id ? await registry.read(a.id) : undefined, base = r?.base ?? git(repo, 'rev-parse', 'HEAD')
      epochPublication(s.room, a.name, base)
      s.room.participants.set(`${a.name}\0id`, { name: a.name, kind: 'agent' })
      s.room.manifestHead.set(a.name, { ...s.room.manifestHead.get(a.name)!, level: 'full', rev, semRev: rev })
      const entries = new Y.Map<ManifestEntry>(), before = versions(a.dir, base)
      for (const p of git(a.dir, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(Boolean)) {
        if (p === subpath || p.startsWith(subpath + '/')) continue
        const file = path.join(a.dir, p)
        if (!fs.existsSync(file)) { entries.set(p, { change: 'D', state: 'shared', fence: '1' }); continue }
        const text = fs.readFileSync(file, 'utf8'), hash = gitBlobHash(text)
        if (hash !== before.get(p)) {
          entries.set(p, { change: before.has(p) ? 'M' : 'A', state: 'shared', hash, at: clock, fence: '1' })
          s.room.setOverlay(manifestKey(a.name, '1'), p, text)
        }
      }
      // Even a publication claiming a gitlink must not produce a clean/conflict row.
      entries.set(subpath, { change: 'M', state: 'shared', hash: next, at: clock, fence: '1' })
      s.room.manifest.set(manifestKey(a.name, '1'), entries)
    }
    await shadowIdle(s)
  }
  for (const p of [subpath, subpath + '/private.txt']) s.room.doc.getMap<ConflictSlot>('conflicts').set(p, {
    kind: 'merge', owner: d.name, other: u.name, path: p, status: 'conflict', settled: 'conflict', fence: '1',
  } as ConflictSlot)
  const worker = () => state.actors.get(d.name), sibling = () => state.actors.get(u.name)
  const compare = () => shadow.graph.compare(worker().node, sibling().node)
  try {
    expect([...state.actors.keys()].sort()).toEqual(actors.map(a => a.name).sort())
    put(d.dir, 'shared.txt', 'worker D\n'); put(u.dir, 'keep.txt', 'worker U\n')
    await observe()
    expect((await compare()).paths).toEqual([])
    expect(worker().capture).toBeDefined(); expect(sibling().capture).toBeDefined()
    put(u.dir, 'shared.txt', 'worker U competing\n')
    // A real staged pointer update remains opaque and does not disable this worker.
    git(u.dir, 'update-index', '--cacheinfo', `160000,${next},${subpath}`)
    await observe()
    expect((await compare()).paths).toEqual(['shared.txt'])
    expect(sibling().gaps.has(subpath)).toBe(true)
    const privateEntry = (await shadow.graph.entries(sibling().node)).get(subpath)!
    expect(privateEntry.mode).toBe('160000'); expect(privateEntry.oid).not.toBe(next)
    expect((await shadow.graph.entries(worker().node)).get(subpath)).toEqual(privateEntry)
    // Return u to a clean pointer and file so collection can exercise the actual tools.
    git(u.dir, 'reset', '-q', 'HEAD', '--', subpath)
    put(u.dir, 'shared.txt', 'a\nb\nc\n')
    await observe()
    await t.finish('d')
    expect(await t.call('room_collect', { tag: 'd', keep: true })).toContain('kept d')
    await shadowIdle(s)
    expect(worker().events.some((e: string) => e.startsWith('delivery:'))).toBe(true)
    expect(state.actors.get(s.me.name).events.some((e: string) => e.startsWith('collection:'))).toBe(true)
    commit(repo, 'accept worker D')
    expect(await t.call('room_send', { type: 'note', to: d.name, text: 'continue', refresh: true })).toContain('rebased d')
    await shadowIdle(s)
    expect(worker().events.some((e: string) => e.startsWith('refresh:'))).toBe(true)
    await observe()
    expect((await compare()).paths).toEqual([])
    expect(logs.filter(line => /unmodelled|stopped|event failed/.test(line))).toEqual([])
    expect([...state.pending.keys()].some((key: string) => key.includes(subpath))).toBe(false)
    const journal = path.join(path.dirname(shadow.graph.root), 'disagreements.jsonl')
    if (fs.existsSync(journal)) expect(fs.readFileSync(journal, 'utf8')).not.toContain(subpath)
  } finally { stopShadow(s); await shadowIdle(s) }
})

it('never reads submodule contents or objects, and leaves source Git state unchanged', async () => {
  const { first, next, head } = submodule(), graph = new ShadowGraph(path.join(repo, '.git/room/shadow/submodule'), repo)
  await graph.init()
  const before = { index: fs.readFileSync(path.join(repo, '.git/index')), objects: git(repo, 'count-objects', '-v'), refs: git(repo, 'show-ref') }
  const commands: string[][] = []
  setGitObserver(args => commands.push([...args]))
  const read = fs.readFileSync
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
    if (String(file).startsWith(path.join(repo, subpath) + path.sep)) throw new Error('submodule read forbidden')
    return (read as any)(file, ...args)
  }) as typeof fs.readFileSync)
  try {
    const captured = await captureShadow(graph, repo, head, [{ path: subpath, sha: next }])
    expect(captured.gaps.has(subpath)).toBe(true)
    const tree = await graph.tree(captured.entries)
    expect((await graph.entries(tree)).get(subpath)).toMatchObject({ mode: '160000' })
    expect(commands.flat()).not.toContain(first); expect(commands.flat()).not.toContain(next)
    expect(commands.some(args => args.some(arg => arg.startsWith(path.join(repo, subpath))))).toBe(false)
    expect(fs.readFileSync(path.join(repo, '.git/index'))).toEqual(before.index)
    expect(git(repo, 'count-objects', '-v')).toBe(before.objects); expect(git(repo, 'show-ref')).toBe(before.refs)
    git(repo, 'update-index', '--cacheinfo', `160000,${next},${subpath}`)
    expect(await captured.current(), 'pointer movement must not invalidate the other files').toBe(true)
  } finally { await fs.promises.rm(graph.root, { recursive: true, force: true }) }
})

it('accepts regular/executable blobs, excludes tracked symlinks without following targets, and traverses trees', async () => {
  fs.symlinkSync(path.join(path.dirname(repo), 'missing-secret'), path.join(repo, 'link'))
  put(repo, 'nested/executable', '#!/bin/sh\nexit 0\n'); fs.chmodSync(path.join(repo, 'nested/executable'), 0o755)
  const head = commit(repo, 'entry kinds'), graph = new ShadowGraph(path.join(repo, '.git/room/shadow/kinds'), repo)
  try {
    await graph.init()
    const raw = await graph.entries(head)
    expect(raw.get('link')?.mode).toBe('120000'); expect(raw.get('nested/executable')?.mode).toBe('100755')
    for (const initial of [true, false]) {
      const scan = await captureShadow(graph, repo, head, [], initial)
      expect(scan.gaps.has('link')).toBe(true); expect(scan.entries.has('link')).toBe(false)
      expect(scan.entries.get('nested/executable')?.mode).toBe('100755')
    }
  } finally { await fs.promises.rm(graph.root, { recursive: true, force: true }) }
})

it('omits empty trees and diagnoses invalid tree entries without echoing their bytes', async () => {
  const graph = new ShadowGraph(path.join(repo, '.git/room/shadow/tree-kinds'), repo)
  try {
    await graph.init()
    const empty = await graph.tree(new Map())
    const root = await graph.run(['mktree'], `040000 tree ${empty}\tempty\n`)
    expect(await graph.entries(root)).toEqual(new Map())
    vi.spyOn(graph, 'run').mockResolvedValue(`100600 blob ${'a'.repeat(40)} 1\tPRIVATE_PATH\0`)
    await expect(graph.entries(root)).rejects.toThrow('unmodelled history: invalid tree entry kind or mode')
  } finally { await fs.promises.rm(graph.root, { recursive: true, force: true }) }
})
