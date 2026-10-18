import { fixture, git, gitOracle, names, put, rooms, roots, sharedText, source } from './combined-kept-preview-fixture.js'
import { manifestHeadOf, RoomDoc } from '@room/shared'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { acknowledgeKeptPublication } from '../src/kept-publication.js'
import type { Session } from '../src/session.js'
import { handlers as collectHandlers } from '../src/tools/collect.js'
import { buildCombinedTree } from '../src/tools/combined-tree.js'
import type { HandlerState } from '../src/tools/context.js'
import { prepareWorktree } from '../src/worker-git.js'
import { localWorkers } from '../src/worker-registry.js'
import { hubSeam } from './fixtures/hub.js'
import { publishFixture } from './fixtures/manifest.js'
import { testPolicyStore } from './policy-fixture.js'
import { registerWorkers } from './registry-fixture.js'

it('real collect matches the independent repeated-line Git oracle and the full preview', async () => {
  const t = await fixture({ shared: 'repeated' })
  gitOracle(t)
  const before = t.snapshot(), result = await t.preview('lead', names.slice(1))
  expect(result.complete, result.out.join('\n')).toBe(true)
  expect(result.conflictingPaths.size, result.out.join('\n')).toBe(0)
  expect(result.merged).toEqual(t.expected)
  expect(t.snapshot()).toEqual(before)
  expect(await collectHandlers(t.stateFor(t.sessions.get('lead')!)).room_collect({ keep: true })).toContain('kept api')
  for (const [file, expected] of t.expected) {
    expect(fs.readFileSync(path.join(t.root, file), 'utf8')).toBe(expected)
  }
})

it('reports unknown delivered provenance for sibling-only different snapshots instead of losing a deliberate revert', async () => {
  const t = await fixture({ shared: 'disjoint' }), before = t.snapshot()
  const result = await t.preview('lead+api', ['lead+backend', 'lead+consumer'])
  expect(result.complete).toBe(false)
  expect(result.gaps.some(gap => gap.path === 'shared.txt' && gap.why.includes('include lead'))).toBe(true)
  expect(result.merged.has('shared.txt')).toBe(false)
  expect(t.snapshot()).toEqual(before)
})

it('refuses a held or partially shared lead anchor without reading its disk or substituting the caller', async () => {
  const t = await fixture(), before = t.snapshot()
  const head = t.room.manifestHead.get('lead')!
  t.room.manifestHead.set('lead', { ...head, level: 'declared', rev: head.rev + 1 })
  const result = await t.preview('lead+api', ['lead+backend', 'lead+consumer', 'lead'])
  expect(result.complete).toBe(false)
  expect(result.gaps.some(gap => gap.person === 'lead' && gap.why.includes('anchor unavailable'))).toBe(true)
  expect(result.merged.has('src/api.ts')).toBe(false)
  expect(t.snapshot()).toEqual(before)
})

it('requires a new post-application acknowledgement after publisher replacement', async () => {
  const t = await fixture(), lead = t.sessions.get('lead')!, head = t.room.manifestHead.get('lead')!
  const holder = t.room.participants.get('lead\0holder')! as { sessionId: string; epoch: number }
  t.room.participants.set('lead\0holder', { ...holder, sessionId: 'replacement', epoch: holder.epoch + 1 })
  lead.daemon.fence = String(holder.epoch + 1)
  await lead.daemon.reconcileGitChanges()
  let result = await t.preview('lead+api', ['lead+backend', 'lead+consumer', 'lead'])
  expect(result.complete).toBe(false)
  expect(result.gaps.some(gap => gap.why.includes('acknowledged post-baseline'))).toBe(true)
  const records = t.registry.list()
  for (const record of records) {
    const proof = await acknowledgeKeptPublication(lead, record.keptPublication, [])
    expect(proof.pending).toBe(false)
    await t.registry.update(record.id, old => ({ ...old, keptPublication: { ...proof, base: record.base }, seq: old.seq + 1 }))
  }
  result = await t.preview('lead+api', ['lead+backend', 'lead+consumer', 'lead'])
  expect(result.complete, result.out.join('\n')).toBe(true)
  expect(result.conflictingPaths.size, result.out.join('\n')).toBe(0)
  expect(result.merged).toEqual(t.expected)
  expect(t.room.manifestHead.get('lead')!.fence).not.toBe(head.fence)
})

it('tracks own-caller record, collection ref and merge-order key changes in snapshot freshness', async () => {
  const t = await fixture(), result = await t.preview('lead+api', ['lead+backend', 'lead+consumer', 'lead'])
  expect(result.isCurrent()).toBe(true)
  const record = t.registry.reservedByTagOrName('lead+api')!
  await t.registry.update(record.id, old => ({ ...old, seq: old.seq + 1 }))
  expect(result.moved()).toContain('lead+api')
  const keySnapshot = await t.preview('lead+api', ['lead+backend', 'lead+consumer', 'lead'])
  const report = t.registry.reports(record.id)[0]
  await t.registry.writeReport(record.id, { ...report, done: { ...report.done!, at: report.done!.at + 1000 } })
  expect(t.registry.read(record.id)!.seq).toBe(record.seq + 1)
  expect(keySnapshot.moved()).toContain('lead+api')
  const next = await t.preview('lead+api', ['lead+backend', 'lead+consumer', 'lead'])
  git(t.root, 'update-ref', `refs/room/collect-head/${record.tag}/${record.id}`, git(t.root, 'rev-parse', 'HEAD'))
  expect(next.moved()).toContain('lead+api')
})

async function carriedFixture(carry = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-carried-preview-'))); roots.push(root)
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Lead'); git(root, 'config', 'user.email', 'lead@example.test')
  put(root, 'shared.txt', sharedText()); put(root, '.gitignore', '.room/\n')
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'base')
  const base = git(root, 'rev-parse', 'HEAD'), room = new RoomDoc(); rooms.push(room); room.setMeta({ base })
  publishFixture(room, 'lead', 'shared.txt', sharedText(), { base })
  room.participants.set('lead\0git', { ...room.participants.get('lead\0git')!, head: base })
  put(root, 'shared.txt', sharedText([2, 'carried input'])); put(root, 'new.txt', 'carried untracked input\n')
  const prepared = await prepareWorktree(root, 'carry', 'lead', [], undefined, 0, carry)
  const session = (name: string, dir: string) => ({ ...hubSeam(room), policyStore: testPolicyStore(), dir, me: { name, kind: 'agent' }, room,
    local: {}, roomName: 'local/test', awareness: { getStates: () => new Map() }, daemon: { touch() {}, fence: '1', settle: async () => {} } } as unknown as Session)
  const lead = session('lead', root), worker = session('lead+carry', prepared.dir)
  const registry = await registerWorkers(lead, [{ tag: 'carry', name: 'lead+carry', lead: 'lead', dir: prepared.dir, branch: prepared.branch,
    status: 'done', base: prepared.base, carriedBase: prepared.carriedBase, carriedUntracked: prepared.carriedUntracked, host: 'codex', task: 'carry', pid: 0, startedAt: 1 }])
  put(worker.dir, 'own.txt', 'worker own comment\n'); publishFixture(room, worker.me.name, 'own.txt', 'worker own comment\n', { base: prepared.base })
  lead.daemon.reconcileGitChanges = async () => {
    for (const p of ['shared.txt', 'new.txt']) publishFixture(room, 'lead', p, fs.readFileSync(path.join(root, p), 'utf8'), { base })
    room.participants.set('lead\0git', { ...room.participants.get('lead\0git')!, head: base })
  }
  const state = { S: () => worker, rooms: { holding: () => worker }, baseFor: (_s: Session, person: string) => manifestHeadOf(room, person)?.base ?? base,
    shareOf: () => 'full' } as unknown as HandlerState
  return { root, room, lead, worker, registry, prepared, preview: () => buildCombinedTree(state, worker, [{ person: 'lead', session: worker }]) }
}

it('rejects a complete stale pre-carry lead frame including unchanged carried untracked input', async () => {
  const t = await carriedFixture(), result = await t.preview()
  expect(result.complete).toBe(false)
  expect(result.gaps.some(g => g.why.includes('acknowledged'))).toBe(true)
})

it('accepts a verified carried publication and requires reacknowledgement after replacement', async () => {
  const t = await carriedFixture(), record = t.registry.reservedByTagOrName('lead+carry')!
  const proof = await acknowledgeKeptPublication(t.lead, undefined, t.prepared.carried!.paths)
  expect(proof.pending).toBe(false)
  await t.registry.update(record.id, old => ({ ...old, keptPublication: { ...proof, base: record.base }, seq: old.seq + 1 }))
  const result = await t.preview()
  expect(result.complete, result.out.join('\n')).toBe(true)
  expect(result.merged.get('shared.txt')).toBe(sharedText([2, 'carried input']))
  expect(result.merged.get('new.txt')).toBe('carried untracked input\n')
  expect(result.merged.get('own.txt')).toBe('worker own comment\n')
  t.room.participants.set('lead\0holder', { ...t.room.participants.get('lead\0holder')!, sessionId: 'replacement' })
  expect((await t.preview()).complete).toBe(false)
})

it('does not require carried-publication acknowledgement for carry=false', async () => {
  const t = await carriedFixture(false), result = await t.preview()
  expect(t.prepared.carried).toBeUndefined()
  expect(result.complete, result.out.join('\n')).toBe(true)
  expect(result.merged.get('shared.txt')).toBe(sharedText())
  expect(result.merged.get('own.txt')).toBe('worker own comment\n')
})

it.each(['missing', 'rewritten'])('refuses real collect when a kept baseline ref is %s without changing lead/worker bytes or indexes', async kind => {
  const t = await fixture(), record = t.registry.reservedByTagOrName('lead+api')!
  const ref = `refs/room/collect-head/${record.tag}/${record.id}`
  if (kind === 'missing') git(t.root, 'update-ref', '-d', ref)
  else git(t.root, 'update-ref', ref, git(t.root, 'rev-parse', 'HEAD'))
  const before = t.snapshot(), refs = git(t.root, 'show-ref')
  const reply = await collectHandlers(t.stateFor(t.sessions.get('lead')!)).room_collect({ keep: true })
  expect(reply).toContain('Nothing written; preview provenance is incomplete')
  expect(t.snapshot()).toEqual(before); expect(git(t.root, 'show-ref')).toBe(refs)
})

it('refuses collect after a plain worker baseline falls off the lead history', async () => {
  const t = await fixture(), record = t.registry.reservedByTagOrName('lead+api')!
  const dir = t.sessions.get('lead+api')!.dir
  git(dir, 'add', 'src/api.ts'); git(dir, 'commit', '-qm', 'private checkpoint before spawn')
  const base = git(dir, 'rev-parse', 'HEAD')
  await t.registry.update(record.id, old => ({ ...old, base, collectedKeep: undefined, carriedBase: undefined, keptPublication: undefined, seq: old.seq + 1 }))
  put(dir, 'src/api.ts', source('api', 3))
  const before = t.snapshot(), refs = git(t.root, 'show-ref')
  const reply = await collectHandlers(t.stateFor(t.sessions.get('lead')!)).room_collect({ tag: 'api', keep: true })
  expect(reply).toContain('Nothing written; preview provenance is incomplete')
  expect(t.snapshot()).toEqual(before); expect(git(t.root, 'show-ref')).toBe(refs)
})

it.each(['missing', 'mismatched'])('does not certify a plain checkpoint from a %s published actual HEAD', async kind => {
  const t = await carriedFixture(false), record = t.registry.reservedByTagOrName('lead+carry')!
  const dir = t.worker.dir
  git(dir, 'add', 'own.txt'); git(dir, 'commit', '-qm', 'checkpoint')
  const base = git(dir, 'rev-parse', 'HEAD')
  await t.registry.update(record.id, old => ({ ...old, base, seq: old.seq + 1 }))
  publishFixture(t.room, t.worker.me.name, 'own.txt', 'changed after checkpoint\n', { base })
  const leadGit = t.room.participants.get('lead\0git')!
  t.room.participants.set('lead\0git', { ...leadGit, head: kind === 'missing' ? undefined : base, ...(kind === 'mismatched' ? { fence: 'wrong' } : {}) })
  expect((await t.preview()).complete).toBe(false)
})

it.each([false, true])('checks the immediate worker-lead publication in a three-generation preview (stale=%s)', async stale => {
  const t = await carriedFixture(), parentRecord = t.registry.reservedByTagOrName('lead+carry')!
  const parentProof = await acknowledgeKeptPublication(t.lead, undefined, t.prepared.carried!.paths)
  await t.registry.update(parentRecord.id, old => ({ ...old, keptPublication: { ...parentProof, base: old.base }, seq: old.seq + 1 }))
  const child = await prepareWorktree(t.worker.dir, 'grand', t.worker.me.name, [])
  await registerWorkers(t.worker, [{ tag: 'grand', name: 'lead+carry+grand', lead: t.worker.me.name, dir: child.dir, branch: child.branch,
    status: 'done', base: child.base, carriedBase: child.carriedBase, carriedUntracked: child.carriedUntracked, host: 'codex', task: 'grand', pid: 0, startedAt: 2 }])
  t.worker.daemon.reconcileGitChanges = async () => {
    for (const p of ['shared.txt', 'new.txt', 'own.txt']) publishFixture(t.room, t.worker.me.name, p, fs.readFileSync(path.join(t.worker.dir, p), 'utf8'), { base: t.prepared.base })
    t.room.participants.set(`${t.worker.me.name}\0git`, { ...t.room.participants.get(`${t.worker.me.name}\0git`)!, head: git(t.worker.dir, 'rev-parse', 'HEAD') })
  }
  const record = t.registry.reservedByTagOrName('lead+carry+grand')!
  const proof = await acknowledgeKeptPublication(t.worker, undefined, child.carried!.paths)
  expect(proof.pending).toBe(false)
  await t.registry.update(record.id, old => ({ ...old, keptPublication: { ...proof, base: old.base }, seq: old.seq + 1 }))
  if (stale) t.room.participants.set(`${t.worker.me.name}\0holder`, { ...t.room.participants.get(`${t.worker.me.name}\0holder`)!, sessionId: 'replacement' })
  put(child.dir, 'grand.txt', 'grand own note\n')
  publishFixture(t.room, record.name, 'grand.txt', 'grand own note\n', { base: child.base })
  const caller = { ...t.worker, dir: child.dir, me: { name: record.name, kind: 'agent' } } as Session
  const state = { S: () => caller, rooms: { holding: () => caller }, shareOf: () => 'full',
    baseFor: (_s: Session, person: string) => manifestHeadOf(t.room, person)!.base } as unknown as HandlerState
  const result = await buildCombinedTree(state, caller, [{ person: 'lead', session: caller }, { person: t.worker.me.name, session: caller }])
  expect(result.complete, result.out.join('\n')).toBe(!stale)
  if (!stale) {
    expect(result.merged.get('shared.txt')).toBe(sharedText([2, 'carried input']))
    expect(result.merged.get('new.txt')).toBe('carried untracked input\n')
    expect(result.merged.get('own.txt')).toBe('worker own comment\n')
    expect(result.merged.get('grand.txt')).toBe('grand own note\n')
  }
})

it('retains the worker and marks unknown freshness when optional ACK metadata is malformed', async () => {
  const t = await fixture(), record = t.registry.reservedByTagOrName('lead+api')!
  fs.writeFileSync(path.join(t.registry.root, 'workers', `${record.id}.json`), JSON.stringify({ ...record, keptPublication: { pending: false, paths: [7], ack: {} } }))
  expect(t.registry.read(record.id)).toMatchObject({ id: record.id, keptPublication: { paths: [], pending: true, overflow: true } })
  expect(localWorkers(t.root).some(worker => worker.id === record.id)).toBe(true)
  expect((await t.preview('lead+api', ['lead+backend', 'lead+consumer', 'lead'])).complete).toBe(false)
})

it('gaps a lead-absent later baseline that reverts an earlier delivery back to the common ancestor', async () => {
  const t = await fixture({ shared: 'disjoint' }), api = t.registry.reservedByTagOrName('lead+api')!, backend = t.registry.reservedByTagOrName('lead+backend')!
  const dir = t.sessions.get('lead+backend')!.dir
  git(dir, 'reset', '-q', '--hard', api.base!)
  put(dir, 'shared.txt', sharedText()); git(dir, 'add', 'shared.txt'); git(dir, 'commit', '-qm', 'later baseline reverts earlier delivery')
  const base = git(dir, 'rev-parse', 'HEAD')
  await t.registry.update(backend.id, old => ({ ...old, base, seq: old.seq + 1 }))
  publishFixture(t.room, backend.name, 'shared.txt', sharedText(), { base })
  const result = await t.preview('lead+api', ['lead+backend', 'lead+consumer'])
  expect(result.complete).toBe(false)
  expect(result.gaps.some(g => g.path === 'shared.txt' && g.why.includes('include lead'))).toBe(true)
})
