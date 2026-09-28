import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkerRegistry } from '../src/worker-registry.js'
import type { WorkerRecord } from '../src/worker-status.js'
import { completionMessage } from '@room/shared'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const token = (nonce: string) => ({ pid: 100, startTime: 'born', executable: 'node', sessionId: 'host', nonce })
function fixture(): { root: string; record: WorkerRecord } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-writes-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, '.room/workers/tests'), { recursive: true })
  const record: WorkerRecord = {
    v: 1, id: 'w_write', tag: 'tests', name: 'lead+tests', mode: 'local', room: 'local/repo',
    lead: { participant: 'lead', room: 'local/repo', instance: token('lead') }, host: 'codex',
    budget: { threads: 1, memGb: 1, nice: 10 }, share: 'intent', task: 'tests',
    dir: path.join(root, '.room/workers/tests'), outside: false, branch: 'room/tests', prep: { step: 'plan' },
    capabilities: { resume: true, signal: true, collect: 'delta' }, phase: 'intent',
    runs: [{ n: 1, mode: 'fresh', intentAt: 1, nonce: 'nonce-1', busFrontier: [], promptMsgIds: [], launcher: token('lead'), logStart: 0 }],
    createdAt: 1, seq: 1,
  }
  return { root, record }
}
const open = (root: string, nonce = 'lead', alive: 'alive' | 'dead' = 'alive') => WorkerRegistry.open(root,
  { identity: token(nonce), migrate: false, watch: false, liveness: () => alive })

describe('registry write paths', () => {
  it('builds one deterministic completion message for a reported run', () => {
    const { record } = fixture()
    expect(completionMessage(record, record.runs[0], { status: 'done', summary: 'finished' },
      { done: { summary: 'finished', changed: ['src/a.ts'] } })).toEqual({
      id: 'wk:w_write:1', body: { type: 'done', tag: 'tests', summary: 'finished',
        changed: ['src/a.ts'], to: 'lead', priority: 'notify' },
    })
  })
  it('records a launch outcome after intent, and leaves a killed launcher ambiguous', async () => {
    const { root, record } = fixture()
    const lead = await open(root)
    await lead.writeIntent(record)
    await lead.update(record.id, old => ({ ...old, phase: 'prepared', prep: { step: 'prepared' }, seq: old.seq + 1 }))
    const observer = await open(root, 'observer', 'dead')
    expect(observer.status(record.id)?.status).toBe('ambiguous')
    expect(observer.read(record.id)?.runs).toHaveLength(1)
    await observer.reconcile()
    expect(observer.read(record.id)?.runs).toHaveLength(1)
  })

  it('keeps a tag reserved through retirement cleanup, then permits reuse', async () => {
    const { root, record } = fixture()
    const store = await open(root)
    await store.writeIntent(record)
    await store.update(record.id, old => ({ ...old, phase: 'retiring', cleanup: { [old.room]: 'pending' }, seq: old.seq + 1 }))
    const next = { ...record, id: 'w_next', runs: [{ ...record.runs[0], nonce: 'nonce-next' }] }
    await expect(store.writeIntent(next)).rejects.toThrow('tag in use: tests')
    await store.update(record.id, old => ({ ...old, phase: 'retired', cleanup: { [old.room]: 'done' }, seq: old.seq + 1 }))
    await store.writeIntent(next)
    expect(store.read(next.id)?.tag).toBe('tests')
  })

  it('admits one matching worker writer, preserves done, and posts the completion once', async () => {
    const { root, record } = fixture()
    const lead = await open(root)
    await lead.writeIntent({ ...record, phase: 'prepared' })
    const worker = await open(root, 'worker')
    const other = await open(root, 'other')
    const admission = { id: record.id, run: 1, nonce: 'nonce-1', dir: record.dir,
      chain: [{ pid: 201, startTime: 'child', executable: 'codex' }], hostSessionId: 'thread-1' }
    await worker.admit(admission)
    await lead.finishOperation(record.id)
    await worker.reconcile()
    expect(worker.read(record.id)?.hostSessionId).toBe('thread-1')
    await expect(other.admit(admission)).rejects.toThrow(/writer|admitted/)
    await worker.reportDone(record.id, 1, 'finished', ['src/a.ts'])
    await worker.postCompletion(record.id, 1, () => {})
    let posts = 0
    await worker.postCompletion(record.id, 1, () => { posts++ })
    expect(posts).toBe(0)
    expect(worker.reports(record.id)[0]).toMatchObject({ done: { summary: 'finished' }, posted: 'wk:w_write:1' })
  })

  it('posts a witnessed failure with the same deterministic run ID once', async () => {
    const { root, record } = fixture()
    const store = await open(root)
    await store.writeIntent(record)
    await store.update(record.id, old => ({ ...old, phase: 'active',
      runs: [{ ...old.runs[0], launch: { outcome: 'launched', pid: 201 } }], seq: old.seq + 1 }))
    await store.writeExit(record.id, { run: 1, code: 1, at: 10, witnessed: true })
    const posted: string[] = []
    expect(await store.postObservedFailure(record.id, 1, message => posted.push(message.id))).toBe(true)
    expect(await store.postObservedFailure(record.id, 1, message => posted.push(message.id))).toBe(false)
    expect(posted).toEqual(['wk:w_write:1'])
    expect(store.read(record.id)?.runs[0].posted).toBe('wk:w_write:1')
  })

  it('requires a hash-matching stable patch through discard replay', async () => {
    const { root, record } = fixture()
    const store = await open(root)
    await store.writeIntent(record)
    await store.update(record.id, old => ({ ...old, phase: 'active', runs: [{ ...old.runs[0], launch: { outcome: 'launched', pid: 201 } }], seq: old.seq + 1 }))
    await store.beginDiscard(record.id, false, [])
    await store.recordDiscardPatch(record.id, Buffer.from('patch body'))
    const patch = path.join(root, 'room/registry/patches/w_write.patch')
    expect(fs.readFileSync(patch, 'utf8')).toBe('patch body')
    await store.recordDiscardPatch(record.id, Buffer.from('patch body'))
    expect(fs.readdirSync(path.dirname(patch))).toEqual(['w_write.patch'])
    fs.writeFileSync(patch, 'wrong')
    await store.recordDiscardPatch(record.id, Buffer.from('patch body'))
    expect(fs.readFileSync(patch, 'utf8')).toBe('patch body')
    expect(fs.readdirSync(path.join(root, 'room/registry/quarantine')).length).toBe(1)
  })

  it('publishes the recorded patch identity after interruption before or after linking', async () => {
    const { root, record } = fixture()
    const store = await open(root)
    await store.writeIntent(record)
    await store.beginDiscard(record.id, true, [])
    const bytes = Buffer.from('recovery patch')
    const file = path.join(root, 'room/registry/patches/w_write.patch')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    await store.update(record.id, old => ({ ...old,
      discard: { ...old.discard!, patch: { path: file, sha256 } }, seq: old.seq + 1 }))
    expect(fs.existsSync(file)).toBe(false)
    await store.recordDiscardPatch(record.id, bytes)
    expect(fs.readFileSync(file)).toEqual(bytes)
    await store.recordDiscardPatch(record.id, bytes)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['w_write.patch'])
  })

  it('replays an abandoned discard plan and retires after publishing its patch', async () => {
    const { root, record } = fixture()
    const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
    git(root, 'init', '-q')
    git(root, 'config', 'user.name', 'Lead')
    git(root, 'config', 'user.email', 'lead@example.test')
    fs.writeFileSync(path.join(root, 'base.txt'), 'base\n')
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'base')
    const base = git(root, 'rev-parse', 'HEAD')
    fs.rmSync(record.dir, { recursive: true })
    git(root, 'worktree', 'add', '-qb', 'room/tests', record.dir)
    fs.writeFileSync(path.join(record.dir, 'change.txt'), 'recover me\n')
    const lead = await open(root)
    await lead.writeIntent(record)
    await lead.update(record.id, old => ({ ...old, base, prep: { step: 'prepared' }, phase: 'active',
      runs: [{ ...old.runs[0], launch: { outcome: 'launched', pid: 201 } }], seq: old.seq + 1 }))
    await lead.beginDiscard(record.id, true, [])
    const observer = await open(root, 'observer', 'dead')
    expect(observer.read(record.id)?.phase).toBe('retiring')
    expect(observer.read(record.id)?.discard?.steps).toEqual({ children: true, stop: true, patch: true, cleanup: true, prune: true })
    expect(fs.existsSync(record.dir)).toBe(false)
    expect(fs.readFileSync(path.join(root, 'room/registry/patches/w_write.patch'), 'utf8')).toContain('recover me')
  })

  it('restores an interrupted collect to active with a partial apply warning', async () => {
    const { root, record } = fixture()
    const lead = await open(root)
    await lead.writeIntent(record)
    await lead.update(record.id, old => ({ ...old, phase: 'active', runs: [{ ...old.runs[0], launch: { outcome: 'launched', pid: 201 } }], seq: old.seq + 1 }))
    await lead.beginCollect(record.id)
    const observer = await open(root, 'observer', 'dead')
    expect(observer.read(record.id)?.phase).toBe('active')
    expect(observer.read(record.id)?.interrupted?.detail).toMatch(/partial apply/)
  })
})
