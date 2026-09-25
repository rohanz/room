// Acceptance test for carrying the lead's uncommitted work into a new worker worktree, end to end through
// createTools with real git repositories and the real prepareWorktree; only the process spawner is stubbed.
// The worker is simulated by editing its worktree and calling room_done through a worker session.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import type { Identity } from '@room/shared'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { GraphIndex } from '../src/graph-index.js'
import { prepareWorktree, cleanupWorker, saveDiscardPatch } from '../src/workers.js'

const lead: Identity = { name: 'rohanz', kind: 'agent', owner: 'rohanz' }
const CARRIED_SUBJECT = 'room: carried-in uncommitted work from rohanz'
const SHARED = Array.from({ length: 10 }, (_, i) => `line${i + 1}`)
const lines = (...edits: [number, string][]) => { const l = [...SHARED]; for (const [n, t] of edits) l[n - 1] = t; return l.join('\n') + '\n' }

let root: string, repo: string, head: string
const cleanups: (() => Promise<void>)[] = []
let roomEnv: Record<string, string | undefined>
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
const put = (dir: string, p: string, text: string, mode?: number) => {
  fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text)
  if (mode !== undefined) fs.chmodSync(path.join(dir, p), mode)
}
const read = (dir: string, p: string) => fs.readFileSync(path.join(dir, p), 'utf8')
const exists = (dir: string, p: string) => fs.existsSync(path.join(dir, p))
/** Porcelain status without Room's own directory, which is never the lead's work. */
const status = (dir: string) => git(dir, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(l => l && !/^..\s+"?\.room\//.test(l)).sort()
const leadState = () => ({ head: git(repo, 'rev-parse', 'HEAD'), index: git(repo, 'write-tree'), cached: git(repo, 'diff', '--cached', '--binary'), status: status(repo) })

beforeEach(() => {
  roomEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('ROOM_')))
  for (const key of Object.keys(roomEnv)) delete process.env[key]
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-carry-')))
  repo = path.join(root, 'lead'); fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'rohanz'); git(repo, 'config', 'user.email', 'rohanz@example.test')
  put(repo, 'shared.txt', lines()); put(repo, 'keep.txt', 'k1\nk2\nk3\n'); put(repo, 'staged.txt', 's\n'); put(repo, 'gone.txt', 'bye\n')
  put(repo, '.gitignore', 'secret.env\nbuild/\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base'); head = git(repo, 'rev-parse', 'HEAD')
  // roomd adds Room's directory to the private exclude file when a session joins.
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.room/\n')
})
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {})
  fs.rmSync(root, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) if (key.startsWith('ROOM_')) delete process.env[key]
  Object.assign(process.env, roomEnv)
})

/** Tracked (unstaged), staged modification, staged addition, deletion, untracked and executable untracked WIP, plus ignored and Room files. */
function leadWip() {
  put(repo, 'shared.txt', lines([2, 'W']))
  put(repo, 'staged.txt', 'S2\n'); git(repo, 'add', 'staged.txt')
  put(repo, 'staged-new.txt', 'added\n'); git(repo, 'add', 'staged-new.txt')
  fs.unlinkSync(path.join(repo, 'gone.txt'))
  put(repo, 'notes.txt', 'untracked\n')
  put(repo, 'run.sh', '#!/bin/sh\necho hi\n', 0o755)
  put(repo, 'secret.env', 'TOKEN=do-not-carry\n'); put(repo, 'build/out.bin', 'artifact')
  put(repo, '.room/scratch.txt', 'room state')
}

function pair() {
  const a = new Y.Doc(), b = new Y.Doc()
  a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
  b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u))
  return { a: new RoomDoc(a), b: new RoomDoc(b) }
}
function fakeSession(room: RoomDoc, me: Identity, dir: string): Session {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
  const graph = new GraphIndex(room, me.name, dir); graph.start()
  return {
    graph, room, awareness, me, dir, roomUrl: 'ws://127.0.0.1:1/local%2Fx%2Fmain', roomName: 'local/x/main', browserUrl: 'http://x',
    provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: me.name, roomDoc: room, provider: null as never, branch: 'main', base: head } as never,
    shareMax: 'full', shareRequested: 'full',
    local: { url: 'ws://127.0.0.1:1', port: 1, owned: true, async stop() {} },
  } as Session
}

function world() {
  const { a, b } = pair()
  a.setMeta({ repo: 'x', branch: 'main', base: head })
  let ls: Session | null = fakeSession(a, lead, repo)
  const exits = new Map<string, (code: number | null) => void>()
  const prompts = new Map<string, string>()
  let pid = 4_000_000 // above any real pid: nothing is ever alive or signalled
  const leadTools = createTools({
    getSession: () => ls, setSession: s => { ls = s }, cwd: repo, probe: () => undefined,
    spawner: spec => {
      prompts.set(spec.env.ROOM_TAG, spec.args.find(arg => arg.includes('You are worker')) ?? '')
      return { pid: pid++, onExit: cb => { exits.set(spec.env.ROOM_TAG, cb) }, kill: () => true }
    },
  })
  cleanups.push(() => leadTools.shutdown())
  const call = (tool: string, args: Record<string, unknown>) => leadTools.call(tool, args) as Promise<string>
  async function spawn(tag: string) {
    const reply = await call('room_spawn', { tag, task: `task ${tag}` })
    const w = a.workers.get(tag)
    expect(w, reply).toBeTruthy()
    return { reply, w: w!, dir: w!.dir }
  }
  /** The worker reports with room_done through its own session, then its process exits cleanly. */
  async function finish(tag: string) {
    const w = b.workers.get(tag)!
    // Pinned: the worker's clone is on room/<tag>, and its room must not follow that branch.
    let ws: Session | null = { ...fakeSession(b, { name: `rohanz+${tag}`, kind: 'agent', owner: 'rohanz', label: tag }, w.dir), pinnedRoom: true } as Session
    const tools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: w.dir })
    expect(await tools.call('room_done', { summary: `${tag} finished` })).toContain('Your lead rohanz has been told')
    await tools.shutdown(); ws?.graph?.stop()
    exits.get(tag)!(0)
    await vi.waitFor(() => expect(a.workers.get(tag)).toMatchObject({ status: 'done', exitCode: 0 }))
  }
  return { a, b, call, spawn, finish, prompts }
}

/** The files a collect reply says it wrote for the workers. */
function collected(reply: string): string[] {
  const m = /Changes from [^:]+: (.*)\. Nothing committed or staged\./.exec(reply)
  expect(m, reply).toBeTruthy()
  return m![1] === 'already present' ? [] : m![1].split(', ').sort()
}
/** The files a preview attributes to the worker. */
function previewed(reply: string): string[] {
  const out = new Set<string>()
  for (const line of reply.split('\n')) {
    const only = /^touched by one side only (?:\(merge trivially\)|since .* \(merge trivially; the lead's carried edits are in that base\)): (.*)$/.exec(line)
    if (only) for (const item of only[1].split(', ')) out.add(item.replace(/ \([^)]*\)$/, ''))
    const both = /^both changed, merge cleanly: (.*)$/.exec(line)
    if (both) for (const item of both[1].split(', ')) out.add(item)
  }
  return [...out].sort()
}
/** The carried commit on the worker's branch, checked against the contract. */
function expectCarried(dir: string, tag: string, baseSha: string | undefined) {
  const sha = git(dir, 'rev-parse', `refs/heads/room/${tag}`)
  expect(git(dir, 'log', '-1', '--format=%s', sha)).toBe(CARRIED_SUBJECT)
  expect(git(dir, 'log', '-1', '--format=%an <%ae>', sha)).toBe('Room <room@localhost>')
  expect(git(dir, 'rev-parse', `${sha}^`)).toBe(head)
  expect(baseSha).toBe(sha)
  return sha
}
const CARRIED_LINE = /carried your (\d+) uncommitted changes? into its worktree \(commit ([0-9a-f]{10})\)/

describe('carrying the lead\'s uncommitted work into a worker (acceptance)', () => {
  it('refuses to reuse a stale worker directory switched to another branch', async () => {
    const prepared = await prepareWorktree(repo, 'replacement', 'rohanz', [], 'room-A/rohanz')
    git(prepared.dir, 'switch', '-qc', 'unrelated')
    await expect(prepareWorktree(repo, 'replacement', 'rohanz', [], 'room-A/rohanz')).rejects.toThrow(/branch.*unrelated/)
  })
  it('refuses a replacement repository at a former worker path', async () => {
    const prepared = await prepareWorktree(repo, 'replacement', 'rohanz', [], 'room-A/rohanz')
    git(repo, 'worktree', 'remove', '--force', prepared.dir)
    fs.mkdirSync(prepared.dir, { recursive: true })
    git(prepared.dir, 'init', '-q', '-b', 'room/replacement')
    await expect(prepareWorktree(repo, 'replacement', 'rohanz', [], 'room-A/rohanz')).rejects.toThrow(/not a worktree of this repository/)
  })
  it('can spawn from HEAD without carrying tracked or untracked lead changes', async () => {
    put(repo, 'shared.txt', lines([2, 'lead edit']))
    put(repo, 'specs/draft.md', 'untracked spec\n')
    const t = world()
    const reply = await t.call('room_spawn', { tag: 'fresh', task: 'Read specs/draft.md', carry: false })
    const w = t.a.workers.get('fresh')!
    expect(w.base).toBe(head)
    expect(git(w.dir, 'rev-parse', 'HEAD')).toBe(head)
    expect(read(w.dir, 'shared.txt')).toBe(lines())
    expect(exists(w.dir, 'specs/draft.md')).toBe(false)
    expect(reply).toContain('specs/draft.md')
    expect(reply).toContain('not in this worktree')
  })

  it('warns when an ignored spec named in the task is missing from the carried worktree', async () => {
    put(repo, 'build/og-grid-spec.md', 'ignored spec\n')
    const t = world()
    const reply = await t.call('room_spawn', { tag: 'grid', task: 'Follow build/og-grid-spec.md' })
    expect(exists(t.a.workers.get('grid')!.dir, 'build/og-grid-spec.md')).toBe(false)
    expect(reply).toContain('build/og-grid-spec.md')
    expect(reply).toContain('not in this worktree')
  })
  it('removes the private carry ref and owner record after normal worker cleanup', async () => {
    put(repo, 'shared.txt', lines([2, 'W']))
    put(repo, 'untracked.txt', 'private WIP\n')
    const prepared = await prepareWorktree(repo, 'retired', 'rohanz', [], 'room-A/retired')
    expect(git(repo, 'rev-parse', 'refs/room/carry/retired')).toBe(prepared.base)
    expect(git(repo, 'ls-tree', '-r', '--name-only', 'refs/room/carry-untracked/retired')).toBe('untracked.txt')
    const record = path.join(repo, '.git', 'room-carry', 'retired.json')
    expect(fs.existsSync(record)).toBe(true)
    const w = { tag: 'retired', branch: prepared.branch, dir: prepared.dir, status: 'done', exitCode: 0 } as Parameters<typeof cleanupWorker>[1]
    expect(await cleanupWorker(repo, w, true)).toBe(true)
    expect(() => git(repo, 'rev-parse', '--verify', 'refs/room/carry/retired')).toThrow()
    expect(() => git(repo, 'rev-parse', '--verify', 'refs/room/carry-untracked/retired')).toThrow()
    expect(fs.existsSync(record)).toBe(false)
  })
  it('restores the worker worktree and private refs when cleanup fails late', async () => {
    put(repo, 'shared.txt', lines([2, 'W']))
    put(repo, 'untracked.txt', 'private WIP\n')
    const prepared = await prepareWorktree(repo, 'cleanup-fails', 'rohanz')
    const record = path.join(repo, '.git', 'room-carry', 'cleanup-fails.json')
    const realRm = fs.promises.rm.bind(fs.promises)
    let failed = false
    vi.spyOn(fs.promises, 'rm').mockImplementation((target, options) => {
      if (!failed && String(target) === record) { failed = true; throw new Error('forced late cleanup failure') }
      return realRm(target, options)
    })
    const w = { tag: 'cleanup-fails', branch: prepared.branch, dir: prepared.dir, status: 'done', exitCode: 0, carriedUntracked: prepared.carriedUntracked } as Parameters<typeof cleanupWorker>[1]
    await expect(cleanupWorker(repo, w, true)).rejects.toThrow(/cleanup/)
    expect(fs.existsSync(prepared.dir)).toBe(true)
    expect(git(repo, 'rev-parse', `refs/heads/${prepared.branch}`)).toBeTruthy()
    expect(git(repo, 'rev-parse', 'refs/room/carry-untracked/cleanup-fails')).toBeTruthy()
    expect(read(prepared.dir, 'untracked.txt')).toBe('private WIP\n')
  })
  it('does not put unchanged copied untracked files in a discard recovery patch', async () => {
    put(repo, 'notes.txt', 'lead WIP\n')
    const prepared = await prepareWorktree(repo, 'patch', 'rohanz')
    put(prepared.dir, 'keep.txt', 'worker edit\n')
    const w = { tag: 'patch', branch: prepared.branch, dir: prepared.dir, base: prepared.base, carriedUntracked: prepared.carriedUntracked } as Parameters<typeof saveDiscardPatch>[1]
    const patch = await saveDiscardPatch(repo, w)
    expect(patch).toBeTruthy()
    expect(fs.readFileSync(patch!, 'utf8')).toContain('diff --git a/keep.txt b/keep.txt')
    expect(fs.readFileSync(patch!, 'utf8')).not.toContain('notes.txt')
  })
  it('tells a worker which carried files belong to the lead', async () => {
    leadWip()
    const t = world()
    await t.spawn('owned')
    const prompt = t.prompts.get('owned')!
    expect(prompt).toContain('Files carried from the lead\'s uncommitted work belong to the lead; coordinate with the lead before editing these where your task needs to: gone.txt, notes.txt, run.sh, shared.txt, staged-new.txt, staged.txt.')
    expect(prompt).not.toContain('secret.env')
  })

  it('names at most 20 carried paths and counts the rest', async () => {
    for (let i = 0; i < 23; i++) put(repo, `many/${String(i).padStart(2, '0')}.txt`, `${i}\n`)
    const t = world()
    await t.spawn('many')
    const prompt = t.prompts.get('many')!
    expect(prompt).toContain(`${Array.from({ length: 20 }, (_, i) => `many/${String(i).padStart(2, '0')}.txt`).join(', ')}, and 3 more.`)
    expect(prompt).not.toContain('many/20.txt')
  })

  it('does not mention carried files to a worker spawned from a clean lead', async () => {
    const t = world()
    await t.spawn('clean-prompt')
    expect(t.prompts.get('clean-prompt')).not.toContain('Files carried from the lead\'s uncommitted work')
  })

  it('(1) spawn carries tracked, staged, deleted and untracked WIP, never ignored or Room files, and reports it', async () => {
    leadWip()
    const before = leadState()
    const t = world()
    const { reply, w, dir } = await t.spawn('one')
    // Tracked WIP is committed; untracked WIP is copied without entering branch history.
    expect(read(dir, 'shared.txt')).toBe(lines([2, 'W']))
    expect(read(dir, 'staged.txt')).toBe('S2\n')
    expect(read(dir, 'staged-new.txt')).toBe('added\n')
    expect(exists(dir, 'gone.txt')).toBe(false)
    expect(read(dir, 'notes.txt')).toBe('untracked\n')
    expect(fs.statSync(path.join(dir, 'run.sh')).mode & 0o111).toBe(0o111)
    for (const p of ['secret.env', 'build', '.room']) expect(exists(dir, p), p).toBe(false)
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('?? notes.txt\n?? run.sh')
    const sha = expectCarried(dir, 'one', w.base)
    expect(git(repo, 'ls-tree', '-r', '--name-only', sha).split('\n').sort()).toEqual(['.gitignore', 'keep.txt', 'shared.txt', 'staged-new.txt', 'staged.txt'])
    expect(w.carriedUntracked?.map(x => x.path)).toEqual(['notes.txt', 'run.sh'])
    // The reply names the carry, and no longer warns that the WIP is missing.
    const m = CARRIED_LINE.exec(reply)
    expect(m, reply).toBeTruthy()
    expect(Number(m![1])).toBe(before.status.length)
    expect(m![2]).toBe(sha.slice(0, 10))
    expect(reply).not.toMatch(/not in this worktree/)
    // The lead's repo, index and working tree are untouched.
    expect(leadState()).toEqual(before)
    expect(read(repo, 'secret.env')).toBe('TOKEN=do-not-carry\n')
  })

  it('(2) collect applies only the worker\'s delta: lead edits to carried lines survive, nothing duplicated, staged or committed', async () => {
    leadWip()
    const t = world()
    const { dir } = await t.spawn('two')
    put(repo, 'shared.txt', lines([2, 'W2'])) // the lead keeps working on a carried line
    put(dir, 'shared.txt', lines([2, 'W'], [9, 'X9'])); put(dir, 'keep.txt', 'k1\nk2\nK3\n')
    await t.finish('two')
    const before = leadState()
    const reply = await t.call('room_collect', {})
    expect(reply).not.toMatch(/conflicting files|CONFLICTS|error:/)
    expect(collected(reply)).toEqual(['keep.txt', 'shared.txt'])
    expect(read(repo, 'shared.txt')).toBe(lines([2, 'W2'], [9, 'X9']))
    expect(read(repo, 'keep.txt')).toBe('k1\nk2\nK3\n')
    // The rest of the lead's WIP is exactly as it was.
    expect(read(repo, 'staged.txt')).toBe('S2\n'); expect(read(repo, 'staged-new.txt')).toBe('added\n'); expect(read(repo, 'notes.txt')).toBe('untracked\n')
    expect(exists(repo, 'gone.txt')).toBe(false)
    const after = leadState()
    expect(after.head).toBe(before.head); expect(after.index).toBe(before.index); expect(after.cached).toBe(before.cached)
    expect(reply).toContain('cleaned up two')
  })

  it('(3) two workers spawned at different moments of the lead\'s WIP are collected together', async () => {
    leadWip()
    const t = world()
    const one = await t.spawn('one')
    put(repo, 'shared.txt', lines([2, 'W2'])); put(repo, 'later.txt', 'later\n')
    const two = await t.spawn('two')
    // Each reply names its own snapshot, since the lead may have changed WIP between spawns.
    expect(two.reply).toMatch(CARRIED_LINE)
    expect(read(two.dir, 'shared.txt')).toBe(lines([2, 'W2'])); expect(read(two.dir, 'later.txt')).toBe('later\n')
    expect(read(one.dir, 'shared.txt')).toBe(lines([2, 'W'])); expect(exists(one.dir, 'later.txt')).toBe(false)
    expectCarried(two.dir, 'two', two.w.base)
    put(repo, 'shared.txt', lines([2, 'W2'], [5, 'L5']))
    put(one.dir, 'shared.txt', lines([2, 'W'], [9, 'X9']))
    put(two.dir, 'shared.txt', lines([2, 'W2'], [7, 'Y7'])); put(two.dir, 'keep.txt', 'K1\nk2\nk3\n')
    await t.finish('one'); await t.finish('two')
    const before = leadState()
    const reply = await t.call('room_collect', {})
    expect(reply).not.toMatch(/conflicting files|CONFLICTS|error:/)
    expect(collected(reply)).toEqual(['keep.txt', 'shared.txt'])
    expect(read(repo, 'shared.txt')).toBe(lines([2, 'W2'], [5, 'L5'], [7, 'Y7'], [9, 'X9']))
    expect(read(repo, 'keep.txt')).toBe('K1\nk2\nk3\n')
    expect(read(repo, 'later.txt')).toBe('later\n'); expect(read(repo, 'notes.txt')).toBe('untracked\n')
    const after = leadState()
    expect(after.head).toBe(before.head); expect(after.index).toBe(before.index)
    expect(reply).toContain('cleaned up one'); expect(reply).toContain('cleaned up two')
  })

  it('(4) a worker that changed nothing after the carry has nothing to apply and retires cleanly', async () => {
    leadWip()
    const t = world()
    const { w, dir } = await t.spawn('idle')
    expect(w.base).not.toBe(head)
    put(repo, 'shared.txt', lines([2, 'W2']))
    await t.finish('idle')
    const snapshot = () => Object.fromEntries(['shared.txt', 'keep.txt', 'staged.txt', 'staged-new.txt', 'notes.txt', 'run.sh', 'gone.txt'].map(p => [p, exists(repo, p) ? read(repo, p) : null]))
    const files = snapshot(), before = leadState()
    // The exit also starts automatic retirement of a clean worker; collect runs straight after it, as a lead
    // woken by the done message does. Either may retire the worker, but neither may fail.
    const reply = await t.call('room_collect', {})
    expect(reply).not.toMatch(/conflicting files|CONFLICTS|error:/)
    if (/Changes from/.test(reply)) {
      expect(collected(reply)).toEqual([])
      expect(reply).toContain('cleaned up idle')
    } else expect(reply).toMatch(/No finished changes to collect/)
    expect(snapshot()).toEqual(files)
    expect(leadState()).toEqual(before)
    await vi.waitFor(() => expect(fs.existsSync(dir)).toBe(false))
    expect(git(repo, 'branch', '--list', 'room/idle')).toBe('')
    expect(t.a.workers.has('idle')).toBe(false)
    expect(t.a.retiredWorkers().find(r => r.tag === 'idle')).toMatchObject({ files: [], fileCount: 0 })
  })

  it('(5) discard keeps a recovery patch of the worker\'s changes only', async () => {
    leadWip()
    const t = world()
    const { w, dir } = await t.spawn('drop')
    const sha = expectCarried(dir, 'drop', w.base)
    put(dir, 'keep.txt', 'k1\nk2\nK3\n'); put(dir, 'mine.txt', 'worker\n')
    await t.finish('drop')
    const oldTz = process.env.TZ
    process.env.TZ = 'Pacific/Honolulu'
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-25T01:00:00.000Z'))
    const date = new Date()
    const localDay = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
    let reply: string
    try { reply = await t.call('room_collect', { tag: 'drop', discard: true }) }
    finally { vi.useRealTimers(); if (oldTz === undefined) delete process.env.TZ; else process.env.TZ = oldTz }
    const patch = /recovery patch: (\S+)/.exec(reply)?.[1]
    expect(patch, reply).toBeTruthy()
    expect(path.basename(patch!)).toContain(`drop-${localDay}-`)
    const text = fs.readFileSync(patch!, 'utf8')
    expect([...text.matchAll(/^diff --git a\/(\S+) /gm)].map(m => m[1]).sort()).toEqual(['keep.txt', 'mine.txt'])
    // It applies on the carried commit and restores exactly the worker's output there.
    const fresh = path.join(root, 'fresh')
    git(repo, 'worktree', 'add', '-q', '--detach', fresh, sha)
    git(fresh, 'apply', patch!)
    expect(read(fresh, 'keep.txt')).toBe('k1\nk2\nK3\n'); expect(read(fresh, 'mine.txt')).toBe('worker\n')
    expect(read(fresh, 'shared.txt')).toBe(lines([2, 'W']))
  })

  it('(6) room_preview_merge agrees with collect for scenario 2', async () => {
    leadWip()
    const t = world()
    const { dir } = await t.spawn('six')
    put(repo, 'shared.txt', lines([2, 'W2']))
    put(dir, 'shared.txt', lines([2, 'W'], [9, 'X9'])); put(dir, 'keep.txt', 'k1\nk2\nK3\n')
    await t.finish('six')
    const preview = await t.call('room_preview_merge', { person: 'rohanz+six' })
    expect(preview).not.toContain('CONFLICTS')
    expect(preview).toContain('no conflicts')
    expect(preview).toMatch(/touched by one side only since rohanz\+six's base .*lead's carried edits are in that base/)
    const files = previewed(preview)
    expect(files).toEqual(['keep.txt', 'shared.txt'])
    const reply = await t.call('room_collect', {})
    expect(collected(reply)).toEqual(files)
    expect(read(repo, 'shared.txt')).toBe(lines([2, 'W2'], [9, 'X9']))
  })

  it('names the carried base when the lead edited the same file before spawn', async () => {
    put(repo, 'shared.txt', lines([2, 'lead edit']))
    const t = world()
    const { dir } = await t.spawn('carried-line')
    put(dir, 'shared.txt', lines([2, 'lead edit'], [9, 'worker edit']))
    await t.finish('carried-line')
    const preview = await t.call('room_preview_merge', { person: 'rohanz+carried-line' })
    expect(preview).toMatch(/against rohanz\+carried-line's base/)
    expect(preview).toMatch(/touched by one side only since rohanz\+carried-line's base [0-9a-f]{10} \(merge trivially; the lead's carried edits are in that base\): shared\.txt \(rohanz\+carried-line only\)/)
  })

  it('(7) a clean lead behaves exactly as 0.10.2: base is HEAD, no carried commit, no carried line', async () => {
    const t = world()
    const { reply, w, dir } = await t.spawn('clean')
    expect(w.base).toBe(head)
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('base')
    expect(reply).not.toMatch(/carried|uncommitted/)
    put(dir, 'keep.txt', 'k1\nk2\nK3\n')
    await t.finish('clean')
    const reply2 = await t.call('room_collect', {})
    expect(collected(reply2)).toEqual(['keep.txt'])
    expect(read(repo, 'keep.txt')).toBe('k1\nk2\nK3\n')
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(repo, 'diff', '--cached')).toBe('')
  })
})
