import fs from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import { digestPath, manifestKey } from '@room/shared'
import { fixture, git, names, put } from './combined-kept-preview-fixture.js'
import { preparedTest, preparedEach } from './fixtures/prepared-test.js'
import { mutateWorkerFixture } from './fixtures/worker-record.js'
import { publishFixture } from './fixtures/manifest.js'

const people = names.filter(name => name !== 'lead+consumer')

preparedEach(['edit', 'delete', 'excluded', 'intent', 'second-keep'] as const,
  'independent review rejects stale delivered path: %s',
  kind => fixture({ keeps: kind === 'second-keep' ? 2 : 1 }), async (t, kind) => {
    const file = 'src/api.ts'
    if (kind === 'delete') fs.rmSync(path.join(t.root, file))
    else put(t.root, file, 'unpublished lead edit\n')
    const head = t.room.manifestHead.get('lead')!
    if (kind === 'excluded') {
      t.room.manifest.get(manifestKey('lead', head.fence))!.delete(file)
      t.room.manifestHead.set('lead', { ...head, excluded: [digestPath(t.room.ensureRoomSalt(), file)] })
    }
    if (kind === 'intent') t.room.manifestHead.set('lead', { ...head, level: 'intent' })
    const result = await t.preview('lead+consumer', people)
    expect(result.complete, JSON.stringify(result.gaps)).toBe(false)
    expect(result.merged.has(file)).toBe(false)
  })

preparedTest('independent review loads a valid legacy acknowledgement', () => fixture(), async t => {
  const head = t.room.manifestHead.get('lead')!
  const holder = t.room.participants.get('lead\0holder')! as { sessionId: string }
  const record = (await t.registry.reservedByTagOrName('lead+api'))!
  const keptPublication = { paths: ['src/api.ts'], pending: false, base: record.base,
    ack: { publisher: 'lead', sessionId: holder.sessionId, fence: head.fence, rev: head.rev, roomSalt: t.room.ensureRoomSalt() } }
  await mutateWorkerFixture(t.registry, record.id, old => ({ ...old, keptPublication, seq: old.seq + 1 }))
  expect((await t.registry.read(record.id))!.keptPublication).toEqual(keptPublication)
  expect((await t.preview('lead+consumer', people)).complete).toBe(true)
})

preparedTest('independent review checks same-clone team-room kept publication', () => fixture(), async t => {
  for (const session of t.sessions.values()) session.roomName = 'github/example/repo'
  for (const name of names.slice(1)) {
    const record = (await t.registry.reservedByTagOrName(name))!
    await mutateWorkerFixture(t.registry, record.id, old => ({ ...old, room: 'github/example/repo',
      lead: { ...old.lead, room: 'github/example/repo' }, seq: old.seq + 1 }))
  }
  expect((await t.preview('lead+consumer', people)).complete).toBe(true)
  put(t.root, 'src/api.ts', 'unpublished team lead edit\n')
  expect((await t.preview('lead+consumer', people)).complete).toBe(false)
})

preparedEach(['worktree', 'clone'] as const, 'independent review rejects a replacement lead publishing from another %s', () => fixture(), async (t, kind) => {
  // A new lead session takes the same name in another checkout. Separate clones
  // communicate through a team room; linked worktrees also share a local room.
  if (kind === 'clone') {
    for (const session of t.sessions.values()) session.roomName = 'github/example/repo'
    for (const name of names.slice(1)) {
      const record = (await t.registry.reservedByTagOrName(name))!
      await mutateWorkerFixture(t.registry, record.id, old => ({ ...old, room: 'github/example/repo',
        lead: { ...old.lead, room: 'github/example/repo' }, seq: old.seq + 1 }))
    }
  }
  // The last valid publication and the old checkout retain matching bytes.
  const newRoot = path.join(t.root, '.room', 'replacement-lead')
  if (kind === 'worktree') git(t.root, 'worktree', 'add', '-qb', 'replacement-lead', newRoot)
  else git(t.root, 'clone', '-q', '--no-hardlinks', t.root, newRoot)
  for (const file of t.expected.keys()) {
    const old = path.join(t.root, file)
    if (fs.existsSync(old)) put(newRoot, file, fs.readFileSync(old, 'utf8'))
  }
  t.sessions.get('lead')!.dir = newRoot
  const holder = t.room.participants.get('lead\0holder')! as { sessionId: string; epoch: number }
  t.room.participants.set('lead\0holder', { ...holder, sessionId: 'replacement-lead-session', epoch: holder.epoch + 1 })
  for (const file of t.expected.keys()) if (fs.existsSync(path.join(newRoot, file)))
    publishFixture(t.room, 'lead', file, fs.readFileSync(path.join(newRoot, file), 'utf8'), { base: git(newRoot, 'rev-parse', 'HEAD') })
  put(newRoot, 'src/api.ts', 'new lead checkout unpublished edit\n')
  const result = await t.preview('lead+consumer', people)
  expect(result.complete, JSON.stringify({ gaps: result.gaps, merged: result.merged.get('src/api.ts') })).toBe(false)
})
