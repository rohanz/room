import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readDisk } from '../src/disk-scan.js'
import { gitShowManyCapped } from '../src/git.js'
import { plan, policyFromLevel, rulesFromText } from '../src/policy.js'
import type { PublicationInputs } from '../src/policy.js'
import * as Y from 'yjs'
import { RoomDoc, manifestKey, digestPath, snapshotPath, versionOf } from '@room/shared'
import { Publisher } from '../src/publisher.js'
import { DiskBatch } from '../src/disk-batch.js'
import * as gitReads from '../src/git.js'
import type { Baseline } from '../src/baseline.js'

const roots: string[] = []
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-publication-bounds-'))
  roots.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  fs.writeFileSync(path.join(dir, 'x'), 'base')
  git('add', '-A'); git('commit', '-qm', 'base')
  return { dir, git, head: git('rev-parse', 'HEAD') }
}

function publication(dir: string, head: string, budget = 8 * 1024 * 1024, carried?: Baseline) {
  const roomDoc = new RoomDoc(new Y.Doc())
  roomDoc.participants.set('Test\0holder', { sessionId: 'test', epoch: 1 })
  roomDoc.participants.set('Test\0git', { base: head, head, fence: '1' })
  const host = {
    dir, name: 'Test', fence: '1', roomDoc, batch: new DiskBatch(() => {}),
    skips: { size: new Set<string>(), budget: new Set<string>(), ignore: new Set<string>() },
    stopped: false, phase: 'watch', base: head,
    inputs: { head, policy: policyFromLevel('full'), rules: rulesFromText('', 512 * 1024, budget) } as PublicationInputs,
    log: vi.fn(), abs: (p: string) => path.join(dir, p), isSafeRoomPath: () => true,
    bumpLastActive: () => {}, syncSkipReasons: vi.fn(), reconcileGitChanges: async () => {}, carried: () => carried,
  }
  const publisher = new Publisher(host)
  cleanups.push(() => { publisher.stop(); host.batch.stop(); roomDoc.doc.destroy() })
  return { host, publisher, roomDoc }
}

it.each(['truncation', 'deletion'] as const)('bounds base-text preparation and publication after mass %s', async change => {
  const { dir, git } = repo()
  const blobSize = 500_000, budget = 8 * 1024 * 1024
  const paths = Array.from({ length: 20 }, (_, i) => `file-${String(i).padStart(2, '0')}.txt`)
  for (const p of paths) fs.writeFileSync(path.join(dir, p), 'a'.repeat(blobSize - 1) + '\n')
  git('add', '-A'); git('commit', '-qm', 'synthetic large bases')
  const head = git('rev-parse', 'HEAD')
  for (const p of paths) {
    if (change === 'deletion') fs.rmSync(path.join(dir, p))
    else fs.writeFileSync(path.join(dir, p), 'stub\n')
  }
  const { host, publisher, roomDoc } = publication(dir, head, budget)
  const read = vi.spyOn(gitReads, 'gitShowManyCapped')
  const prepared = await publisher.reconcile()
  expect(prepared).toBeDefined()
  const bytes = [...roomDoc.ownedBaseTexts.values()].reduce((n, text) => n + Buffer.byteLength(text), 0)
  expect(bytes).toBeLessThanOrEqual(budget)
  expect(prepared!.baseTexts.size).toBe(16)
  expect([...prepared!.baseTexts.values()].reduce((n, text) => n + Buffer.byteLength(text ?? ''), 0)).toBeLessThanOrEqual(budget)
  expect(bytes).toBe(8_000_000)
  if (change === 'deletion') expect(prepared!.desired.entries.get(paths[0])).toMatchObject({ change: 'D', baseHash: expect.any(String) })
  const dropped = paths.slice(16)
  expect([...host.skips.budget]).toEqual(dropped)
  expect(host.syncSkipReasons).toHaveBeenCalledWith(new Map(dropped.map(p => [p, 'budget'])))
  expect([...read.mock.calls[0][2]]).toEqual(paths.slice(0, 16))
  for (const p of dropped) {
    expect(prepared!.desired.excludedReasons.get(p)).toBe('budget')
    expect(roomDoc.manifest.get(manifestKey(host.name, host.fence))?.has(p)).toBe(false)
    expect(roomDoc.overlayText(manifestKey(host.name, host.fence), p)).toBeUndefined()
    expect(roomDoc.baseText(host.name, head, p)).toBeUndefined()
    expect(roomDoc.manifestHead.get(host.name)!.excluded).toContain(digestPath(roomDoc.ensureRoomSalt(), p))
    const snap = snapshotPath(roomDoc, host.name, [], p)
    expect(await versionOf(snap, p, { gitAt: async () => { throw new Error('excluded paths must not read Git') } })).toMatchObject({ kind: 'excluded' })
  }
  for (const p of paths.slice(0, 16)) fs.writeFileSync(path.join(dir, p), 'a'.repeat(blobSize - 1) + '\n')
  const recovered = (await publisher.reconcile())!
  expect(recovered.baseTextDeletes).toHaveLength(16)
  expect([...host.skips.budget]).toEqual([])
  expect([...recovered.baseTexts.keys()]).toEqual(dropped)
  expect([...roomDoc.ownedBaseTexts.values()].reduce((n, text) => n + Buffer.byteLength(text), 0)).toBe(2_000_000)
})

it('bounds deleted base texts and recovers dropped paths when other files are restored', async () => {
  const { dir, git } = repo()
  const paths = ['a.txt', 'b.txt', 'c.txt']
  for (const p of paths) fs.writeFileSync(path.join(dir, p), 'base\n')
  git('add', '-A'); git('commit', '-qm', 'deletion bases')
  const head = git('rev-parse', 'HEAD')
  for (const p of paths) fs.rmSync(path.join(dir, p))
  const { host, publisher, roomDoc } = publication(dir, head, 10)
  const first = (await publisher.reconcile())!
  expect([...first.desired.entries.keys()]).toEqual(paths.slice(0, 2))
  expect(first.desired.entries.get('a.txt')).toMatchObject({ change: 'D', baseHash: expect.any(String) })
  expect(host.skips.budget.has('c.txt')).toBe(true)
  expect([...roomDoc.ownedBaseTexts.values()]).toEqual(['base\n', 'base\n'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n')
  const recovered = (await publisher.reconcile())!
  expect(recovered.baseTextDeletes).toContain(`${host.name}\0${head}:a.txt`)
  expect(roomDoc.baseText(host.name, head, 'a.txt')).toBeUndefined()
  expect(roomDoc.baseText(host.name, head, 'c.txt')).toBe('base\n')
  expect(host.skips.budget.size).toBe(0)
  for (const p of paths) fs.writeFileSync(path.join(dir, p), 'base\n')
  const restored = (await publisher.reconcile())!
  expect(restored.baseTextDeletes).toHaveLength(2)
  expect(roomDoc.ownedBaseTexts.size).toBe(0)
  expect(restored.desired.entries.size).toBe(0)
  fs.writeFileSync(path.join(dir, 'c.txt'), 'edit\n')
  await publisher.reconcile()
  expect(roomDoc.baseText(host.name, head, 'c.txt')).toBe('base\n')
})

it('keeps ordinary small diffs and rename sides shared, then removes stale bases on narrowing', async () => {
  const { dir, git } = repo()
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n')
  fs.writeFileSync(path.join(dir, 'b.txt'), 'base\n')
  git('add', '-A'); git('commit', '-qm', 'rename bases')
  const head = git('rev-parse', 'HEAD')
  fs.renameSync(path.join(dir, 'a.txt'), path.join(dir, 'renamed.txt'))
  fs.writeFileSync(path.join(dir, 'b.txt'), 'edit\n')
  const { host, publisher, roomDoc } = publication(dir, head, 10)
  const prepared = (await publisher.reconcile())!
  expect([...prepared.desired.entries.keys()]).toEqual(['a.txt', 'b.txt', 'renamed.txt'])
  expect(prepared.desired.entries.get('a.txt')?.change).toBe('D')
  expect(prepared.desired.entries.get('renamed.txt')?.change).toBe('A')
  expect(prepared.desired.excludedReasons.size).toBe(0)
  expect(roomDoc.baseText(host.name, head, 'a.txt')).toBe('base\n')
  expect(roomDoc.baseText(host.name, head, 'b.txt')).toBe('base\n')
  expect(roomDoc.baseText(host.name, head, 'renamed.txt')).toBeUndefined()
  const next = { ...host.inputs, policy: policyFromLevel('declared', ['b.txt']) }
  publisher.applyInputs(next)
  host.inputs = next
  expect([...roomDoc.ownedBaseTexts.keys()]).toEqual([`${host.name}\0${head}:b.txt`])
  await publisher.reconcile()
  expect([...roomDoc.ownedBaseTexts.keys()]).toEqual([`${host.name}\0${head}:b.txt`])
})

it('narrows the current base-text snapshot synchronously when its budget shrinks', async () => {
  const { dir, git } = repo()
  for (const p of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(dir, p), 'base\n')
  git('add', '-A'); git('commit', '-qm', 'small bases')
  const head = git('rev-parse', 'HEAD')
  for (const p of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(dir, p), 'x\n')
  const { host, publisher, roomDoc } = publication(dir, head, 10)
  await publisher.reconcile()
  const next = { ...host.inputs, rules: rulesFromText('', 512 * 1024, 5) }
  publisher.applyInputs(next)
  host.inputs = next
  expect([...roomDoc.ownedBaseTexts.keys()]).toEqual([`${host.name}\0${head}:a.txt`])
  expect(roomDoc.overlayText(manifestKey(host.name, host.fence), 'b.txt')).toBeUndefined()
  await publisher.reconcile()
  expect(host.skips.budget.has('b.txt')).toBe(true)
})

it('does not replace unchanged base-text structs on an identical reconcile', async () => {
  const { dir, head } = repo()
  fs.writeFileSync(path.join(dir, 'x'), 'edit')
  const { publisher, roomDoc } = publication(dir, head)
  await publisher.reconcile()
  const mutations = vi.fn()
  roomDoc.ownedBaseTexts.observe(mutations)
  await publisher.reconcile()
  expect(mutations).not.toHaveBeenCalled()
})

it('prunes obsolete oversized-cache paths while retaining a current oversized observation', async () => {
  const { dir, git } = repo()
  for (const p of ['gone.txt', 'small.txt', 'still-large.txt']) fs.writeFileSync(path.join(dir, p), 'a'.repeat(100))
  git('add', '-A'); git('commit', '-qm', 'oversized bases')
  const head = git('rev-parse', 'HEAD')
  for (const p of ['gone.txt', 'small.txt', 'still-large.txt']) fs.writeFileSync(path.join(dir, p), 'b'.repeat(100))
  const { host, publisher } = publication(dir, head)
  host.inputs = { ...host.inputs, rules: rulesFromText('', 50, 100) }
  await publisher.reconcile()
  const cache = (publisher as unknown as { oversizedCache: Map<string, unknown> }).oversizedCache
  expect([...cache.keys()]).toEqual(['gone.txt', 'small.txt', 'still-large.txt'])
  fs.rmSync(path.join(dir, 'gone.txt'))
  fs.writeFileSync(path.join(dir, 'small.txt'), 'small\n')
  await publisher.reconcile()
  expect([...cache.keys()]).toEqual(['still-large.txt'])
  fs.writeFileSync(path.join(dir, 'still-large.txt'), 'a'.repeat(100))
  await publisher.reconcile()
  await publisher.reconcile()
  expect(cache.size).toBe(0)
})

it('uses actual carried blob sizes so ordinary small carried files keep their coverage', async () => {
  const { dir, git, head } = repo()
  const paths = Array.from({ length: 20 }, (_, i) => `carried-${String(i).padStart(2, '0')}.txt`)
  const blob = git('hash-object', '-w', 'x')
  for (const p of paths) fs.writeFileSync(path.join(dir, p), 'edit\n')
  const baseline: Baseline = { dir, worker: 'Test', sha: head, carriedCommit: false, untracked: new Map(paths.map(p => [p, { sha: blob }])) }
  const { publisher, roomDoc } = publication(dir, head, 100, baseline)
  const prepared = (await publisher.reconcile())!
  expect(prepared.desired.textPaths).toEqual(paths)
  expect(prepared.desired.excludedReasons.size).toBe(0)
  for (const p of paths) expect(roomDoc.baseText('Test', head, p)).toBe('base')
})

it('bounds filter-expanded carried bases and excludes the complete path when the budget fills', async () => {
  const { dir, git, head } = repo()
  fs.writeFileSync(path.join(dir, 'blob'), 'old')
  const sha = git('hash-object', '-w', 'blob')
  fs.rmSync(path.join(dir, 'blob'))
  // Synthetic Git checkout filter: 3 raw bytes expand to 6 checkout bytes.
  git('config', 'filter.expand.smudge', 'printf 123456')
  git('config', 'filter.expand.clean', 'cat')
  fs.writeFileSync(path.join(dir, '.git/info/attributes'), '*.txt filter=expand\n')
  const paths = ['a.txt', 'b.txt', 'c.txt']
  for (const p of paths) fs.writeFileSync(path.join(dir, p), 'x\n')
  const baseline: Baseline = { dir, worker: 'Test', sha: head, carriedCommit: false, untracked: new Map(paths.map(p => [p, { sha }])) }
  const { host, publisher, roomDoc } = publication(dir, head, 10, baseline)
  const prepared = (await publisher.reconcile())!
  expect([...prepared.baseTexts.values()]).toEqual(['123456'])
  expect(prepared.desired.textPaths).toEqual(['a.txt'])
  expect([...host.skips.budget]).toEqual(['b.txt', 'c.txt'])
  expect(roomDoc.ownedBaseTexts.size).toBe(1)
  expect(roomDoc.overlayText(manifestKey('Test', host.fence), 'b.txt')).toBeUndefined()
})

it('keeps newline paths and UTF-8 BOM bases intact and reports invalid UTF-8 as unavailable', async () => {
  const { dir, git } = repo()
  fs.writeFileSync(path.join(dir, 'new\nline.txt'), '\ufeffold\n')
  fs.writeFileSync(path.join(dir, 'invalid.txt'), Buffer.from([0xff, 0xff]))
  git('add', '-A'); git('commit', '-qm', 'synthetic encodings')
  const head = git('rev-parse', 'HEAD')
  const result = await gitShowManyCapped(dir, head, ['new\nline.txt', 'invalid.txt'], 10)
  expect(result.get('new\nline.txt')).toBe('\ufeffold\n')
  expect(result.get('invalid.txt')).toBeUndefined()
})

it('reads at most the cap plus one byte when a file grows after its first stat', async () => {
  const { dir, head } = repo()
  const cap = 64
  fs.writeFileSync(path.join(dir, 'x'), 'small edit')
  const originalOpen = fs.openSync
  const originalRead = fs.readSync
  let opened = false
  let requested = 0
  vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags: number, mode?: fs.Mode) => {
    if (String(p) === path.join(dir, 'x')) {
      opened = true
      fs.writeFileSync(path.join(dir, 'x'), 'z'.repeat(2_000_000))
    }
    return originalOpen(p, flags, mode)
  }) as typeof fs.openSync)
  vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
    requested += length
    return originalRead(fd, buffer, offset, length, position)
  }) as typeof fs.readSync)
  const inputs = { policy: policyFromLevel('full'), rules: rulesFromText('', cap, cap), head }
  const facts = await readDisk(dir, inputs, [], () => true)
  expect(opened).toBe(true)
  expect(requested).toBeLessThanOrEqual(cap + 1)
  expect(facts.find(f => f.path === 'x')?.kind).toBe('error')
})

it('retains at most the publication budget while scanning 512 eligible changed files', async () => {
  const { dir, head } = repo()
  const size = 64 * 1024, budget = 8 * 1024 * 1024
  for (let i = 0; i < 512; i++) fs.writeFileSync(path.join(dir, `changed-${String(i).padStart(3, '0')}.txt`), 'x'.repeat(size))
  const inputs = { policy: policyFromLevel('full'), rules: rulesFromText('', 512 * 1024, budget), head }
  const facts = await readDisk(dir, inputs, [], () => true)
  expect(facts.reduce((total, fact) => total + Buffer.byteLength(fact.text ?? ''), 0)).toBeLessThanOrEqual(budget)
  const desired = plan(inputs, facts, 'aa'.repeat(32))
  expect(desired.textPaths).toHaveLength(128)
  expect(desired.excludedReasons.size).toBe(384)
  expect([...desired.excludedReasons.values()].every(reason => reason === 'budget')).toBe(true)
})

it.each(['declared', 'intent'] as const)('discards unauthorized text at %s and reads it on a widened scan', async level => {
  const { dir, head } = repo()
  const size = 64 * 1024, budget = 8 * 1024 * 1024
  for (let i = 0; i < 512; i++) fs.writeFileSync(path.join(dir, `changed-${String(i).padStart(3, '0')}.txt`), 'x'.repeat(size))
  const restricted = { policy: policyFromLevel(level), rules: rulesFromText('', 512 * 1024, budget), head }
  const hidden = await readDisk(dir, restricted, [], () => true)
  expect(hidden.reduce((total, fact) => total + Buffer.byteLength(fact.text ?? ''), 0)).toBe(0)
  if (level === 'declared') expect(hidden.filter(fact => fact.kind === 'file' && fact.path.startsWith('changed-'))).toHaveLength(512)
  const widened = { ...restricted, policy: policyFromLevel('full') }
  const visible = await readDisk(dir, widened, [], () => true)
  expect(visible.reduce((total, fact) => total + Buffer.byteLength(fact.text ?? ''), 0)).toBe(budget)
  expect(plan(widened, visible, 'aa'.repeat(32)).textPaths).toHaveLength(128)
})

it('checks old blob sizes and reads only blobs within the publication cap', async () => {
  const { dir, git, head } = repo()
  fs.writeFileSync(path.join(dir, 'large'), 'a'.repeat(2_000_000))
  fs.writeFileSync(path.join(dir, 'small'), 'old')
  git('add', '-A'); git('commit', '-qm', 'blobs')
  const base = git('rev-parse', 'HEAD')
  const result = await gitShowManyCapped(dir, base, ['large', 'small', 'missing'], 64)
  expect(result).toEqual(new Map([['large', undefined], ['small', 'old'], ['missing', undefined]]))
  expect(head).not.toBe(base)
})
