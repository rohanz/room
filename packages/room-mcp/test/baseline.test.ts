import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RoomDoc, type Identity, type Worker } from '@room/shared'
import { gitShow } from '@room/roomd/git'
import { carriedUnchanged, carriedUnchangedPaths, workerBaseline } from '@room/roomd/baseline'
import { mergePath, type ConflictDeps } from '../src/conflicts.js'
import { addCarriedUntrackedModes, mergedFileMode } from '../src/tools/files.js'
import { saveDiscardPatch } from '../src/workers.js'
import { buildCombinedTree } from '../src/tools/combined-tree.js'
import type { HandlerState } from '../src/tools/context.js'
import type { Session } from '../src/session.js'

const LEAD = 'lead', WORKER = 'lead+w'
const LINES = Array.from({ length: 10 }, (_, i) => `line${i + 1}`)
const text = (edit: Record<number, string> = {}, eol = '\n') => LINES.map((line, i) => edit[i + 1] ?? line).join(eol) + eol
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
const put = (dir: string, file: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), body)
}
const read = (dir: string, file: string) => { try { return fs.readFileSync(path.join(dir, file), 'utf8') } catch { return null } }

let root: string, lead: string, wdir: string, head: string
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-baseline-')))
  lead = path.join(root, 'lead'); wdir = path.join(root, 'w'); fs.mkdirSync(lead)
  git(lead, 'init', '-q', '-b', 'main')
  git(lead, 'config', 'user.name', 'lead'); git(lead, 'config', 'user.email', 'lead@example.test')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

/** Commit `files`, then spawn a worker the way carry does: tracked WIP in a carried commit, untracked files copied with their blobs stored. */
function spawn(files: Record<string, string>, wip: Record<string, string>, untracked: Record<string, string> = {}) {
  for (const [file, body] of Object.entries(files)) put(lead, file, body)
  git(lead, 'add', '.'); git(lead, 'commit', '-qm', 'base'); head = git(lead, 'rev-parse', 'HEAD')
  for (const [file, body] of Object.entries({ ...wip, ...untracked })) put(lead, file, body)
  git(lead, 'worktree', 'add', '-q', '-b', 'room/w', wdir, head)
  for (const [file, body] of Object.entries(wip)) put(wdir, file, body)
  if (Object.keys(wip).length) { git(wdir, 'add', '-A'); git(wdir, '-c', 'user.name=Room', '-c', 'user.email=room@localhost', 'commit', '-qm', 'room: carried-in uncommitted work from lead') }
  const base = git(wdir, 'rev-parse', 'HEAD')
  for (const [file, body] of Object.entries(untracked)) put(wdir, file, body)
  const carriedUntracked = Object.keys(untracked).map(file => ({ path: file, sha: git(lead, 'hash-object', '-w', `--path=${file}`, file), mode: fs.statSync(path.join(wdir, file)).mode & 0o777 }))
  const room = new RoomDoc()
  room.setMeta({ repo: 'test', branch: 'main', base: head })
  const record = { id: 'lead/w#1', tag: 'w', name: WORKER, host: 'codex', task: 't', dir: wdir, branch: 'room/w', base, pid: 1, startedAt: 1, status: 'running', lead: LEAD, carriedUntracked, ...(base === head ? {} : { carriedBase: base }) } as Worker
  room.setWorker(record)
  const dirOf = (person: string) => person === LEAD ? lead : wdir
  const baseOf = (person: string) => person === LEAD ? head : base
  /** Publish a side's changed files the way its daemon would. */
  const publish = (person: string, files: string[]) => { for (const file of files) room.setOverlay(person, file, read(dirOf(person), file) ?? '') }
  const session = (name: string) => ({ me: { name, kind: 'agent' }, dir: dirOf(name), room, local: true, awareness: { getStates: () => new Map() } }) as unknown as Session
  const sessions = { [LEAD]: session(LEAD), [WORKER]: session(WORKER) }
  const state = {
    rooms: { holding: (name: string) => sessions[name as keyof typeof sessions] },
    liveText: async (_s: Session, file: string, person: string) => read(dirOf(person), file),
    baseFor: (_s: Session, person: string) => baseOf(person),
    shareOf: () => 'full',
  } as unknown as HandlerState
  const preview = (from: string, to: string) => buildCombinedTree(state, sessions[from as keyof typeof sessions], [{ person: to, session: sessions[from as keyof typeof sessions] }])
  const deps = (me: string): ConflictDeps => ({
    room, me: { name: me, kind: 'agent' } as Identity,
    liveText: async (file, person) => read(dirOf(person), file),
    baseText: (sha, file) => gitShow(lead, sha, file),
    baseFor: baseOf,
    mergeBase: async (a, b) => git(lead, 'merge-base', a, b),
  })
  return { base, room, publish, preview, deps }
}

describe('a carried worker\'s own changes', () => {
  it('merges the lead\'s later edit to a carried line with a distant worker edit, from both callers', async () => {
    const t = spawn({ 'shared.txt': text(), 'keep.txt': 'keep\n' }, { 'shared.txt': text({ 2: 'W' }) })
    put(lead, 'shared.txt', text({ 2: 'W2' }))
    put(wdir, 'keep.txt', 'worker\n'); put(wdir, 'shared.txt', text({ 2: 'W', 9: 'X9' }))
    t.publish(LEAD, ['shared.txt']); t.publish(WORKER, ['shared.txt', 'keep.txt'])
    const byLead = await t.preview(LEAD, WORKER), byWorker = await t.preview(WORKER, LEAD)
    for (const result of [byLead, byWorker]) {
      expect(result.conflictCount).toBe(0)
      expect(result.merged.get('shared.txt')).toBe(text({ 2: 'W2', 9: 'X9' }))
      expect(result.merged.get('keep.txt')).toBe('worker\n')
    }
    expect(await mergePath(t.deps(LEAD), WORKER, 'shared.txt')).toEqual({ status: 'clean', lines: [] })
    expect(await mergePath(t.deps(WORKER), LEAD, 'shared.txt')).toEqual({ status: 'clean', lines: [] })
  })

  it('does not report a carried file the worker never touched', async () => {
    const t = spawn({ 'shared.txt': text(), 'keep.txt': 'keep\n' }, { 'shared.txt': text({ 2: 'W' }) })
    put(lead, 'shared.txt', text({ 2: 'W2' }))
    put(wdir, 'keep.txt', 'worker\n')
    t.publish(LEAD, ['shared.txt']); t.publish(WORKER, ['shared.txt', 'keep.txt'])
    for (const result of [await t.preview(LEAD, WORKER), await t.preview(WORKER, LEAD)]) {
      expect(result.conflictCount).toBe(0)
      expect(result.merged.get('shared.txt')).toBe(text({ 2: 'W2' }))
      expect(result.owners.get('shared.txt')).toEqual([LEAD])
    }
    expect((await mergePath(t.deps(WORKER), LEAD, 'shared.txt')).status).toBe('one-side')
    expect((await mergePath(t.deps(LEAD), WORKER, 'shared.txt')).status).toBe('one-side')
  })

  it('still reports a real conflict on a carried line both changed', async () => {
    const t = spawn({ 'shared.txt': text() }, { 'shared.txt': text({ 2: 'W' }) })
    put(lead, 'shared.txt', text({ 2: 'W2' })); put(wdir, 'shared.txt', text({ 2: 'MINE' }))
    t.publish(LEAD, ['shared.txt']); t.publish(WORKER, ['shared.txt'])
    for (const result of [await t.preview(LEAD, WORKER), await t.preview(WORKER, LEAD)]) expect(result.conflictCount).toBe(1)
    expect(await mergePath(t.deps(LEAD), WORKER, 'shared.txt')).toEqual({ status: 'conflict', lines: [2] })
    expect(await mergePath(t.deps(WORKER), LEAD, 'shared.txt')).toEqual({ status: 'conflict', lines: [2] })
  })

  it('measures carried untracked files against their spawn-time blobs', async () => {
    const t = spawn({ 'keep.txt': 'keep\n' }, {}, { 'notes.txt': 'draft\n', 'mine.txt': 'draft\n', 'both.txt': text() })
    put(lead, 'notes.txt', 'draft 2\n'); put(lead, 'both.txt', text({ 2: 'LEAD' }))
    put(wdir, 'mine.txt', 'worker\n'); put(wdir, 'both.txt', text({ 9: 'WORKER' }))
    t.publish(LEAD, ['notes.txt', 'mine.txt', 'both.txt']); t.publish(WORKER, ['notes.txt', 'mine.txt', 'both.txt'])
    for (const result of [await t.preview(LEAD, WORKER), await t.preview(WORKER, LEAD)]) {
      expect(result.conflictCount).toBe(0)
      expect(result.merged.get('notes.txt')).toBe('draft 2\n')
      expect(result.owners.get('notes.txt')).not.toContain(WORKER)
      expect(result.merged.get('mine.txt')).toBe('worker\n')
      expect(result.owners.get('mine.txt')).toContain(WORKER)
      expect(result.merged.get('both.txt')).toBe(text({ 2: 'LEAD', 9: 'WORKER' }))
    }
    for (const [me, other] of [[LEAD, WORKER], [WORKER, LEAD]]) {
      expect((await mergePath(t.deps(me), other, 'notes.txt')).status).toBe('one-side')
      expect((await mergePath(t.deps(me), other, 'mine.txt')).status).toBe('one-side')
      expect((await mergePath(t.deps(me), other, 'both.txt')).status).toBe('clean')
    }
    const own = workerBaseline(t.room.workerOf(WORKER))!
    expect(carriedUnchanged(own, 'notes.txt')).toBe(true)
    expect(carriedUnchanged(own, 'mine.txt')).toBe(false)
    expect(carriedUnchanged(own, 'keep.txt')).toBe(false)
  })

  it('counts a carried untracked file\'s mode change as the worker\'s in collect, preview and discard alike', async () => {
    const t = spawn({ 'keep.txt': 'keep\n' }, {}, { 'run.sh': 'echo hi\n', 'notes.txt': 'draft\n' })
    fs.chmodSync(path.join(wdir, 'run.sh'), 0o755)
    const w = t.room.workerOf(WORKER)!
    const unchanged = carriedUnchangedPaths(workerBaseline(w))
    expect([...unchanged]).toEqual(['notes.txt'])
    const participant = { dir: wdir, baseModes: addCarriedUntrackedModes(new Map(), w), unchangedCarried: unchanged, carriedPaths: new Set(['run.sh', 'notes.txt']) }
    expect(mergedFileMode('run.sh', 0o644, [participant])).toBe(0o755)
    const patch = fs.readFileSync((await saveDiscardPatch(lead, w))!, 'utf8')
    expect(patch).toContain('diff --git a/run.sh b/run.sh\nnew file mode 100755')
    expect(patch).not.toContain('notes.txt')
  })

  it('refuses a carried untracked file whose private base blob is gone', async () => {
    const t = spawn({ 'keep.txt': 'keep\n' }, {}, { 'notes.txt': 'draft\n' })
    const record = t.room.workerOf(WORKER)!
    t.room.setWorker({ ...record, carriedUntracked: [{ path: 'notes.txt', sha: '1'.repeat(40) }] } as Worker)
    put(lead, 'notes.txt', 'draft 2\n'); put(wdir, 'notes.txt', 'worker\n')
    t.publish(LEAD, ['notes.txt']); t.publish(WORKER, ['notes.txt'])
    for (const result of [await t.preview(LEAD, WORKER), await t.preview(WORKER, LEAD)]) {
      expect(result.ignoredNotes).toContain('missing private base blob: notes.txt')
      expect(result.paths).not.toContain('notes.txt')
    }
    expect((await mergePath(t.deps(LEAD), WORKER, 'notes.txt')).status).toBe('unknown')
  })

  it('compares CRLF checkouts in one representation', async () => {
    git(lead, 'config', 'core.autocrlf', 'true')
    const t = spawn({ 'app.py': text({}, '\r\n'), 'keep.txt': 'keep\r\n' }, { 'app.py': text({ 2: 'W' }, '\r\n') })
    expect(git(lead, 'show', `${t.base}:app.py`)).toBe(text({ 2: 'W' }).trim())
    put(lead, 'app.py', text({ 2: 'W', 5: 'LEAD' }, '\r\n'))
    put(wdir, 'keep.txt', 'worker\r\n')
    for (const result of [await t.preview(LEAD, WORKER), await t.preview(WORKER, LEAD)]) {
      expect(result.conflictCount).toBe(0)
      expect(result.merged.get('app.py')).toBe(text({ 2: 'W', 5: 'LEAD' }, '\r\n'))
      expect(result.owners.get('app.py')).toEqual([LEAD])
    }
  })
})
