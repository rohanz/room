import { expect } from 'vitest'
import { fixture, git, names, put } from './combined-kept-preview-fixture.js'
import { mutateWorkerFixture } from './fixtures/worker-record.js'
import { publishFixture } from './fixtures/manifest.js'
import { preparedEach, preparedTest } from './fixtures/prepared-test.js'
import fs from 'node:fs'
import path from 'node:path'
import { nameLeaseFile } from '../src/names.js'
import { buildCombinedTree } from '../src/tools/combined-tree.js'

preparedEach(['pending', 'missing'] as const, 'covers kept workers with %s publication bookkeeping without a message',
  () => fixture({ shared: 'disjoint', publicationUnavailable: true }), async (t, kind) => {
    for (const name of ['lead+api', 'lead+backend']) {
      const record = (await t.registry.reservedByTagOrName(name))!
      await mutateWorkerFixture(t.registry, record.id, old => ({ ...old,
        collectedKeep: kind === 'missing' ? undefined : old.collectedKeep,
        keptPublication: kind === 'missing' ? undefined : { paths: [], pending: true, base: old.base }, seq: old.seq + 1 }))
    }
    const before = t.snapshot()
    const result = await t.preview('lead+consumer', names.filter(name => name !== 'lead+consumer'))
    expect(result.complete, JSON.stringify(result.gaps)).toBe(true)
    expect(result.conflictingPaths.size).toBe(0)
    expect(result.merged).toEqual(t.expected)
    expect(t.snapshot()).toEqual(before)
  })

preparedTest('does not cover delivered content using an older complete lead publication', () => fixture(), async t => {
  publishFixture(t.room, 'lead', 'src/api.ts', 'stale lead contents\n')
  const result = await t.preview('lead+consumer', names.filter(name => name !== 'lead+consumer'))
  expect(result.complete).toBe(false)
  expect(result.gaps).toContainEqual(expect.objectContaining({ person: 'lead', path: 'src/api.ts',
    why: expect.stringContaining('published lead version differs from its local checkout') }))
  expect(result.merged.has('src/api.ts')).toBe(false)
})

preparedTest('invalidates a preview when the lead edits before publishing those bytes', () => fixture(), async t => {
  const result = await t.preview('lead+consumer', names.filter(name => name !== 'lead+consumer'))
  expect(result.complete, JSON.stringify(result.gaps)).toBe(true)
  expect(await result.isCurrent()).toBe(true)
  put(t.root, 'src/api.ts', 'new unpublished lead edit\n')
  expect(await result.isCurrent()).toBe(false)
  expect(await result.moved()).toContain('lead')
})

preparedTest('invalidates a preview when the local publisher checkout binding changes', () => fixture(), async t => {
  const result = await t.preview('lead+consumer', names.filter(name => name !== 'lead+consumer'))
  expect(result.complete, JSON.stringify(result.gaps)).toBe(true)
  const file = nameLeaseFile(t.registry.commonDir, 'local/test', 'lead')
  const lease = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...lease, worktree: path.join(t.root, 'another-checkout') }))
  expect(await result.isCurrent()).toBe(false)
  expect(await result.movementDetails()).toContain('lead: local publisher checkout binding')
})

preparedTest('reports an actionable gap when no local publisher location fact exists', () => fixture(), async t => {
  const people = names.filter(name => name !== 'lead+consumer')
  expect((await t.preview('lead+consumer', people)).complete).toBe(true)
  fs.rmSync(nameLeaseFile(t.registry.commonDir, 'local/test', 'lead'))
  const caller = t.sessions.get('lead+consumer')!
  const result = await buildCombinedTree(t.stateFor(caller), caller, people.map(person => ({ person, session: caller })))
  expect(result.complete).toBe(false)
  expect(result.gaps.some(gap => gap.why.includes('run the preview from the publishing lead checkout'))).toBe(true)
})

preparedTest('verifies a same-clone team publisher using the server-qualified local name lease', () => fixture(), async t => {
  const roomName = 'github/example/repo'
  for (const session of t.sessions.values()) {
    session.local = undefined
    session.roomName = roomName
    session.roomUrl = `wss://room.example/${roomName}`
  }
  for (const name of names.slice(1)) {
    const record = (await t.registry.reservedByTagOrName(name))!
    await mutateWorkerFixture(t.registry, record.id, old => ({ ...old, room: roomName,
      lead: { ...old.lead, room: roomName }, seq: old.seq + 1 }))
  }
  const result = await t.preview('lead+consumer', names.filter(name => name !== 'lead+consumer'))
  expect(result.complete, JSON.stringify(result.gaps)).toBe(true)
})

preparedTest('witnesses the current lead checkout rather than deriving it from worker paths', () => fixture(), async t => {
  const newRoot = path.join(t.root, '.room', 'current-lead')
  git(t.root, 'worktree', 'add', '-qb', 'current-lead', newRoot)
  for (const file of t.expected.keys()) if (fs.existsSync(path.join(t.root, file)))
    put(newRoot, file, fs.readFileSync(path.join(t.root, file), 'utf8'))
  t.sessions.get('lead')!.dir = newRoot
  const result = await t.preview('lead+consumer', names.filter(name => name !== 'lead+consumer'))
  expect(result.complete, JSON.stringify(result.gaps)).toBe(true)
  expect(result.merged).toEqual(t.expected)
  put(newRoot, 'src/api.ts', 'unpublished current lead edit\n')
  expect(await result.isCurrent()).toBe(false)
})
