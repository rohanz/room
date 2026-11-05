import { requireWorkerInventory } from '../src/worker-store.js'
import { mutateWorkerFixture } from './fixtures/worker-record.js'
import { fixture, git, gitOracle, names, put, rooms, roots, sharedText, source } from './combined-kept-preview-fixture.js'
import { manifestHeadOf, RoomDoc } from '@room/shared'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import * as gitModule from '@room/roomd/git'
import { acknowledgeKeptPublication } from '../src/kept-publication.js'
import type { Session } from '../src/session.js'
import { handlers as collectHandlers } from '../src/tools/collect.js'
import { handlers as previewHandlers } from '../src/tools/files.js'
import { disposePreviewFixture } from './fixtures/preview-disposal.js'
import { buildCombinedTree } from '../src/tools/combined-tree.js'
import type { HandlerState } from '../src/tools/context.js'
import { prepareWorktree } from '../src/worker-git.js'
import { localWorkers } from '../src/worker-registry.js'
import * as registryModule from '../src/worker-registry.js'
import { refreshWorkerBase } from '../src/worker-refresh.js'
import { hubSeam } from './fixtures/hub.js'
import { publishFixture } from './fixtures/manifest.js'
import { testPolicyStore } from './policy-fixture.js'
import { registerWorkers } from './registry-fixture.js'

it('real collect matches the independent repeated-line Git oracle and the full preview', async () => {
  const t = await fixture({ shared: 'repeated' })
  await gitOracle(t)
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
  const records = (requireWorkerInventory(await t.registry.list()))
  for (const record of records) {
    const proof = await acknowledgeKeptPublication(lead, record.keptPublication, [])
    expect(proof.pending).toBe(false)
    await mutateWorkerFixture(t.registry, record.id, old => ({ ...old, keptPublication: { ...proof, base: record.base }, seq: old.seq + 1 }))
  }
  result = await t.preview('lead+api', ['lead+backend', 'lead+consumer', 'lead'])
  expect(result.complete, result.out.join('\n')).toBe(true)
  expect(result.conflictingPaths.size, result.out.join('\n')).toBe(0)
  expect(result.merged).toEqual(t.expected)
  expect(t.room.manifestHead.get('lead')!.fence).not.toBe(head.fence)
})

it('ignores registry bookkeeping but tracks own-caller baseline, collection ref and merge-order inputs', async () => {
  const t = await fixture(), result = await t.preview('lead+api', ['lead+backend', 'lead+consumer', 'lead'])
  expect((await result.isCurrent())).toBe(true)
  const record = (await t.registry.reservedByTagOrName('lead+api'))!
  await mutateWorkerFixture(t.registry, record.id, old => ({ ...old,
    keptPublication: { ...old.keptPublication!, ack: { ...old.keptPublication!.ack!, rev: old.keptPublication!.ack!.rev + 1 } }, seq: old.seq + 1 }))
  expect((await result.isCurrent())).toBe(true)
  // Repacking refs also preserves their applied values.
  git(t.root, 'pack-refs', '--all')
  expect((await result.isCurrent())).toBe(true)
  const keySnapshot = await t.preview('lead+api', ['lead+backend', 'lead+consumer', 'lead'])
  const report = (await t.registry.reports(record.id))[0]
  await t.registry.writeReport(record.id, { ...report, done: { ...report.done!, at: report.done!.at + 1000 } })
  expect((await t.registry.read(record.id))!.seq).toBe(record.seq + 1)
  expect((await keySnapshot.moved())).toContain('lead+api')
  const next = await t.preview('lead+api', ['lead+backend', 'lead+consumer', 'lead'])
  git(t.root, 'update-ref', `refs/room/collect-head/${record.tag}/${record.id}`, git(t.root, 'rev-parse', 'HEAD'))
  expect((await next.moved())).toContain('lead+api')
  expect((await next.movementDetails()).join('\n')).toContain('lead+api: baseline ref refs/room/collect-head/')
  const baselineSnapshot = await t.preview('lead+api', ['lead+backend', 'lead+consumer', 'lead'])
  await mutateWorkerFixture(t.registry, record.id, old => ({ ...old, carriedUntracked: [{ path: 'new.txt', sha: 'a'.repeat(40) }], seq: old.seq + 1 }))
  expect((await baselineSnapshot.moved())).toContain('lead+api')
})

it.each(['collection ref', 'HEAD'])('does not certify a baseline from a split %s read during an A→B→A move', async input => {
  const t = await fixture(), record = (await t.registry.reservedByTagOrName('lead+api'))!
  const ref = `refs/room/collect-head/${record.tag}/${record.id}`
  const a = git(t.root, 'rev-parse', 'HEAD'), b = record.base!
  // Neither inheritance nor the lead's actual HEAD proves this private baseline.
  await mutateWorkerFixture(t.registry, record.id, old => ({ ...old, carriedBase: undefined, seq: old.seq + 1 }))
  if (input === 'collection ref') git(t.root, 'update-ref', ref, a)
  else git(t.root, 'update-ref', '-d', ref)
  const targetRef = input === 'collection ref' ? ref : git(t.root, 'symbolic-ref', 'HEAD')
  const file = path.join(t.registry.commonDir, targetRef)
  const readFile = fs.readFileSync, realGit = gitModule.git
  let captured = false, restored = false
  const restore = () => { fs.writeFileSync(file, a + '\n'); restored = true }
  const reader = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]) !== file) return readFile(...args)
    if (captured) { restore(); return readFile(...args) }
    const value = readFile(...args)
    captured = true
    fs.writeFileSync(file, b + '\n')
    return value
  })
  const resolver = vi.spyOn(gitModule, 'git').mockImplementation(async (dir, args) => {
    const value = await realGit(dir, args)
    // The old independent provenance read sees B, then freshness sees A again.
    if (captured && !restored && args[0] === 'rev-parse'
      && args.at(-1) === (input === 'collection ref' ? ref : 'HEAD')) restore()
    return value
  })
  try {
    const result = await t.preview('lead', ['lead+api'])
    expect(captured).toBe(true)
    expect(restored).toBe(true)
    expect((await result.isCurrent())).toBe(true)
    expect(result.complete).toBe(false)
    expect(result.gaps).toContainEqual(expect.objectContaining({ kind: 'provenance', person: record.name,
      why: expect.stringContaining('worker baseline provenance could not be verified') }))
    expect(result.deltaBases.get(record.name)).not.toBe(b)
  } finally { reader.mockRestore(); resolver.mockRestore(); restore() }
})

it('proves a kept worker baseline after a real refresh rebase onto the committed lead tree', async () => {
  const t = await fixture(), record = (await t.registry.reservedByTagOrName('lead+api'))!
  const lead = t.sessions.get('lead')!, worker = t.sessions.get('lead+api')!
  git(t.root, 'add', '.'); git(t.root, 'commit', '-qm', 'commit delivered output and lead note')
  const refreshed = await refreshWorkerBase(t.root, record)
  expect(refreshed.kind).toBe('rebased')
  if (refreshed.kind !== 'rebased') throw new Error(JSON.stringify(refreshed))
  await mutateWorkerFixture(t.registry, record.id, old => ({ ...old, base: refreshed.base, carriedBase: refreshed.carriedBase,
    carriedUntracked: refreshed.carriedUntracked, keptPublication: undefined, seq: old.seq + 1 }))
  git(t.root, 'update-ref', `refs/room/collect-head/${record.tag}/${record.id}`, refreshed.base)
  await lead.daemon.reconcileGitChanges()
  for (const file of ['src/api.ts', 'tests/api.test.ts']) publishFixture(t.room, record.name, file,
    fs.readFileSync(path.join(worker.dir, file), 'utf8'), { base: refreshed.base })
  // A refresh baseline is a real lead commit, not a private kept-snapshot commit.
  expect(git(t.root, 'log', '-1', '--format=%s', refreshed.base)).not.toBe('room: kept collection baseline')
  const result = await t.preview(record.name, ['lead+backend', 'lead+consumer', 'lead'])
  expect(result.gaps).toEqual([])
  expect(result.conflictingPaths.size).toBe(0)
  expect(result.merged.get('src/api.ts')).toBe(t.expected.get('src/api.ts'))
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
  const prepared = await prepareWorktree(root, 'carry', 'lead', { linkExclusions: [], carry: carry })
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
  const t = await carriedFixture(), record = (await t.registry.reservedByTagOrName('lead+carry'))!
  const proof = await acknowledgeKeptPublication(t.lead, undefined, t.prepared.carried!.paths)
  expect(proof.pending).toBe(false)
  await mutateWorkerFixture(t.registry, record.id, old => ({ ...old, keptPublication: { ...proof, base: record.base }, seq: old.seq + 1 }))
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
  const t = await fixture(), record = (await t.registry.reservedByTagOrName('lead+api'))!
  const ref = `refs/room/collect-head/${record.tag}/${record.id}`
  if (kind === 'missing') git(t.root, 'update-ref', '-d', ref)
  else git(t.root, 'update-ref', ref, git(t.root, 'rev-parse', 'HEAD'))
  const before = t.snapshot(), refs = git(t.root, 'show-ref')
  const reply = await collectHandlers(t.stateFor(t.sessions.get('lead')!)).room_collect({ keep: true })
  expect(reply).toContain('Nothing written; preview provenance is incomplete')
  expect(t.snapshot()).toEqual(before); expect(git(t.root, 'show-ref')).toBe(refs)
})

it('refuses collect after a plain worker baseline falls off the lead history', async () => {
  const t = await fixture(), record = (await t.registry.reservedByTagOrName('lead+api'))!
  const dir = t.sessions.get('lead+api')!.dir
  git(dir, 'add', 'src/api.ts'); git(dir, 'commit', '-qm', 'private checkpoint before spawn')
  const base = git(dir, 'rev-parse', 'HEAD')
  await mutateWorkerFixture(t.registry, record.id, old => ({ ...old, base, collectedKeep: undefined, carriedBase: undefined, keptPublication: undefined, seq: old.seq + 1 }))
  put(dir, 'src/api.ts', source('api', 3))
  const before = t.snapshot(), refs = git(t.root, 'show-ref')
  const reply = await collectHandlers(t.stateFor(t.sessions.get('lead')!)).room_collect({ tag: 'api', keep: true })
  expect(reply).toContain('Nothing written; preview provenance is incomplete')
  expect(t.snapshot()).toEqual(before); expect(git(t.root, 'show-ref')).toBe(refs)
})

it.each(['missing', 'mismatched'])('does not certify a plain checkpoint from a %s published actual HEAD', async kind => {
  const t = await carriedFixture(false), record = (await t.registry.reservedByTagOrName('lead+carry'))!
  const dir = t.worker.dir
  git(dir, 'add', 'own.txt'); git(dir, 'commit', '-qm', 'checkpoint')
  const base = git(dir, 'rev-parse', 'HEAD')
  await mutateWorkerFixture(t.registry, record.id, old => ({ ...old, base, seq: old.seq + 1 }))
  publishFixture(t.room, t.worker.me.name, 'own.txt', 'changed after checkpoint\n', { base })
  const leadGit = t.room.participants.get('lead\0git')!
  t.room.participants.set('lead\0git', { ...leadGit, head: kind === 'missing' ? undefined : base, ...(kind === 'mismatched' ? { fence: 'wrong' } : {}) })
  expect((await t.preview()).complete).toBe(false)
})

it.each([false, true])('checks the immediate worker-lead publication in a three-generation preview (stale=%s)', async stale => {
  const t = await carriedFixture(), parentRecord = (await t.registry.reservedByTagOrName('lead+carry'))!
  const parentProof = await acknowledgeKeptPublication(t.lead, undefined, t.prepared.carried!.paths)
  await mutateWorkerFixture(t.registry, parentRecord.id, old => ({ ...old, keptPublication: { ...parentProof, base: old.base }, seq: old.seq + 1 }))
  const child = await prepareWorktree(t.worker.dir, 'grand', t.worker.me.name, { linkExclusions: [] })
  await registerWorkers(t.worker, [{ tag: 'grand', name: 'lead+carry+grand', lead: t.worker.me.name, dir: child.dir, branch: child.branch,
    status: 'done', base: child.base, carriedBase: child.carriedBase, carriedUntracked: child.carriedUntracked, host: 'codex', task: 'grand', pid: 0, startedAt: 2 }])
  t.worker.daemon.reconcileGitChanges = async () => {
    for (const p of ['shared.txt', 'new.txt', 'own.txt']) publishFixture(t.room, t.worker.me.name, p, fs.readFileSync(path.join(t.worker.dir, p), 'utf8'), { base: t.prepared.base })
    t.room.participants.set(`${t.worker.me.name}\0git`, { ...t.room.participants.get(`${t.worker.me.name}\0git`)!, head: git(t.worker.dir, 'rev-parse', 'HEAD') })
  }
  const record = (await t.registry.reservedByTagOrName('lead+carry+grand'))!
  const proof = await acknowledgeKeptPublication(t.worker, undefined, child.carried!.paths)
  expect(proof.pending).toBe(false)
  await mutateWorkerFixture(t.registry, record.id, old => ({ ...old, keptPublication: { ...proof, base: old.base }, seq: old.seq + 1 }))
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
  const t = await fixture(), record = (await t.registry.reservedByTagOrName('lead+api'))!
  fs.writeFileSync(path.join(t.registry.root, 'workers', `${record.id}.json`), JSON.stringify({ ...record, keptPublication: { pending: false, paths: [7], ack: {} } }))
  expect((await t.registry.read(record.id))).toMatchObject({ id: record.id, keptPublication: { paths: [], pending: true, overflow: true } })
  expect((await localWorkers(t.root)).some(worker => worker.id === record.id)).toBe(true)
  expect((await t.preview('lead+api', ['lead+backend', 'lead+consumer', 'lead'])).complete).toBe(false)
})

it('gaps a lead-absent later baseline that reverts an earlier delivery back to the common ancestor', async () => {
  const t = await fixture({ shared: 'disjoint' }), api = (await t.registry.reservedByTagOrName('lead+api'))!, backend = (await t.registry.reservedByTagOrName('lead+backend'))!
  const dir = t.sessions.get('lead+backend')!.dir
  git(dir, 'reset', '-q', '--hard', api.base!)
  put(dir, 'shared.txt', sharedText()); git(dir, 'add', 'shared.txt'); git(dir, 'commit', '-qm', 'later baseline reverts earlier delivery')
  const base = git(dir, 'rev-parse', 'HEAD')
  await mutateWorkerFixture(t.registry, backend.id, old => ({ ...old, base, seq: old.seq + 1 }))
  publishFixture(t.room, backend.name, 'shared.txt', sharedText(), { base })
  const result = await t.preview('lead+api', ['lead+backend', 'lead+consumer'])
  expect(result.complete).toBe(false)
  expect(result.gaps.some(g => g.path === 'shared.txt' && g.why.includes('include lead'))).toBe(true)
})


it('uses one captured carried baseline for freshness, text and executable modes when the registry changes during assembly', async () => {
  const t = await carriedFixture(), record = (await t.registry.reservedByTagOrName('lead+carry'))!
  // The worker chmods a carried untracked file. Until its baseline moves this
  // is its own mode change; afterwards the lead's independent 0644 mode wins.
  fs.chmodSync(path.join(t.root, 'new.txt'), 0o644)
  fs.chmodSync(path.join(t.worker.dir, 'new.txt'), 0o755)
  await mutateWorkerFixture(t.registry, record.id, old => ({ ...old,
    carriedUntracked: old.carriedUntracked!.map(file => ({ ...file, mode: 0o644 })), seq: old.seq + 1 }))
  const realGit = gitModule.git
  let changed = false, offset = 0
  const spy = vi.spyOn(gitModule, 'git').mockImplementation(async (dir, args) => {
    // roomRemote was between trustedWorker's capture and the later registry
    // capture. The old preview certified B's freshness while applying A's mode.
    if (!changed && args[0] === 'remote') {
      changed = true
      await mutateWorkerFixture(t.registry, record.id, old => ({ ...old,
        carriedUntracked: old.carriedUntracked!.map(file => ({ ...file, mode: 0o755 })), seq: old.seq + 1 }))
    }
    return realGit(dir, args)
  })
  const state = { S: () => t.lead, rooms: { all: () => [t.lead], holding: () => t.lead, holdingWorker: () => t.lead },
    others: () => [t.worker.me.name], presences: () => [], myWorkers: () => localWorkers(t.root),
    baseFor: (_s: Session, person: string) => manifestHeadOf(t.room, person)?.base ?? t.prepared.base,
    now: () => Date.now() + offset,
    ctx: { sleep: async (ms: number) => { offset += ms; await new Promise<void>(resolve => setImmediate(resolve)) } },
  } as unknown as HandlerState
  try {
    const reply = await previewHandlers(state).room_preview_merge({ person: t.worker.me.name,
      run: 'test ! -x new.txt && test "$(cat own.txt)" = "worker own comment" && echo "1 passed"' })
    expect(changed).toBe(true)
    expect(reply).toContain('tests: PASSED (exit 0)')
    expect(reply).not.toContain('SNAPSHOT result')
    expect(t.lead.lastPreview?.testsPassed).toBe(true)
    expect(fs.statSync(path.join(t.root, 'new.txt')).mode & 0o777).toBe(0o644)
    expect(fs.statSync(path.join(t.worker.dir, 'new.txt')).mode & 0o777).toBe(0o755)
  } finally { spy.mockRestore(); await disposePreviewFixture(t.root) }
})

it('rejects a disk authorization from a different captured worker record even when the registry moves back', async () => {
  const t = await carriedFixture(), record = (await t.registry.reservedByTagOrName('lead+carry'))!
  const trusted = t.registry.trusted.bind(t.registry)
  let authorizations = 0, offset = 0
  const spy = vi.spyOn(t.registry, 'trusted').mockImplementation(async (...args) => {
    authorizations++
    if (authorizations !== 1) return trusted(...args)
    await mutateWorkerFixture(t.registry, record.id, old => ({ ...old,
      carriedUntracked: old.carriedUntracked!.map(file => ({ ...file, mode: 0o755 })), seq: old.seq + 1 }))
    const authorized = await trusted(...args)
    // Freshness alone would see A again; the authorization used B. This attempt
    // must be rejected before any B-authorized worktree enters the A assembly.
    await mutateWorkerFixture(t.registry, record.id, old => ({ ...old, carriedUntracked: record.carriedUntracked, seq: old.seq + 1 }))
    return authorized
  })
  const state = { baseFor: (_s: Session, person: string) => manifestHeadOf(t.room, person)?.base ?? t.prepared.base,
    now: () => Date.now() + offset,
    ctx: { sleep: async (ms: number) => { offset += ms; await new Promise<void>(resolve => setImmediate(resolve)) } },
  } as unknown as HandlerState
  try {
    const result = await buildCombinedTree(state, t.lead, [{ person: t.worker.me.name, session: t.lead }])
    expect(authorizations).toBe(2)
    expect(result.complete).toBe(true)
    expect((await result.isCurrent())).toBe(true)
    expect(result.inputs.records.get(record.name)?.carriedUntracked).toEqual(record.carriedUntracked)
    expect(result.diskWorkers.get(record.name)?.carriedUntracked).toEqual(record.carriedUntracked)
  } finally { spy.mockRestore() }
})


it('enriches captured status without replacing lifecycle facts or querying the store again', async () => {
  const t = await fixture(), record = (await t.registry.reservedByTagOrName('lead+api'))!
  const facts = await t.registry.snapshot(), captured = await t.registry.statusFromSnapshot(facts, record.id)
  const report = (await t.registry.reports(record.id))[0]
  await t.registry.writeReport(record.id, { ...report, done: { ...report.done!, at: report.done!.at + 1000 } })
  expect((await t.registry.status(record.id))?.finishedAt).toBe(report.done!.at + 1000)
  const snapshot = vi.spyOn(t.registry, 'snapshot').mockRejectedValue(new Error('unexpected registry reread'))
  try {
    expect(await t.registry.statusFromSnapshot(facts, record.id)).toEqual(captured)
    expect(snapshot).not.toHaveBeenCalled()
    if (!facts.available) throw new Error('fixture snapshot unavailable')
    await expect(t.registry.statusFromSnapshot({ ...facts, blockers: ['damaged sibling evidence'] }, record.id))
      .rejects.toThrow('worker evidence blocked: damaged sibling evidence')
    await expect(t.registry.statusFromSnapshot({ available: false, reason: 'unavailable', detail: 'restarting' }, record.id))
      .rejects.toThrow('worker snapshot unavailable: restarting')
  } finally { snapshot.mockRestore() }
})

it.each([false, true])('refuses a blocked inventory before assembling valid workers (diskOnly=%s)', async diskOnly => {
  const t = await fixture(), caller = t.sessions.get('lead')!, before = t.snapshot()
  const reader = await registryModule.openWorkerReader(t.root), facts = await reader.snapshot()
  if (!facts.available) throw new Error('fixture snapshot unavailable')
  expect(facts.workers.length).toBeGreaterThan(0)
  const snapshot = vi.fn().mockResolvedValue({ ...facts, blockers: ['damaged sibling evidence'] })
  const status = vi.fn().mockRejectedValue(new Error('must reject before enriching a partial inventory'))
  const open = vi.spyOn(registryModule, 'openWorkerReader').mockResolvedValue({ ...reader, snapshot, statusFromSnapshot: status })
  try {
    await expect(buildCombinedTree(t.stateFor(caller), caller, [{ person: 'lead+api', session: caller }], { diskOnly }))
      .rejects.toThrow('worker evidence blocked: damaged sibling evidence')
    expect(snapshot).toHaveBeenCalledOnce()
    expect(status).not.toHaveBeenCalled()
    const reply = await collectHandlers(t.stateFor(caller)).room_collect({ keep: true })
    expect(reply).toContain('worker evidence blocked: damaged sibling evidence')
    expect(reply).not.toContain('Changes from')
    expect(status).not.toHaveBeenCalled()
    expect(t.snapshot()).toEqual(before)
  } finally { open.mockRestore(); reader.close() }
})

it('refuses freshness certification when an inventory becomes blocked after capture', async () => {
  const t = await fixture(), result = await t.preview('lead', ['lead+api'])
  expect(await result.isCurrent()).toBe(true)
  const reader = registryModule.WorkerRegistry.prototype.snapshot
  const snapshot = vi.spyOn(registryModule.WorkerRegistry.prototype, 'snapshot').mockImplementation(async function (...args) {
    const facts = await reader.apply(this, args)
    return facts.available ? { ...facts, blockers: ['damaged sibling evidence'] } : facts
  })
  try {
    await expect(result.isCurrent()).rejects.toThrow('worker evidence blocked: damaged sibling evidence')
    await expect(result.settledWorkers()).rejects.toThrow('worker evidence blocked: damaged sibling evidence')
  } finally { snapshot.mockRestore() }
})
