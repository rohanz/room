import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, openConflicts, type ConflictKind } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import { ConflictSlots, slotKey } from '../src/conflict-set.js'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'

async function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'room-state-wait-'))
  execFileSync('git', ['init', '-q', dir])
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'init'])
  const base = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const room = new RoomDoc(), awareness = new Awareness(room.doc), seam = hubSeam(room)
  room.ensureRoomSalt(); epochPublication(room, 'A', base, 1)
  const held = room.participants.get('A\0holder') as { sessionId: string }
  awareness.setLocalState({ user: { name: 'A', kind: 'agent' }, sessionId: held.sessionId })
  const policyStore = testPolicyStore(); await policyStore.markDisclosed('full', 2)
  const session = { room, awareness, me: { name: 'A', kind: 'agent' }, dir, roomName: 'r', roomUrl: 'ws://127.0.0.1:9/r', browserUrl: 'http://x',
    policyStore, ...seam, provider: { synced: true }, daemon: { touch() {}, async stop() {}, dir, branch: 'main', base, name: 'A', roomDoc: room } } as unknown as Session
  const tools = createTools({ cwd: dir, getSession: () => session, setSession() {}, binding: { bound: () => undefined, id: () => held.sessionId, dir: () => undefined, commonDir: () => undefined } })
  const slots = new ConflictSlots(room, '1')
  return { room, tools, slots, session, async close() {
    await tools.shutdown(); awareness.destroy(); seam.hub.close(); room.doc.destroy(); fs.rmSync(dir, { recursive: true, force: true })
  } }
}

it.each((['merge', 'edit-in-claim', 'claims', 'contract'] as ConflictKind[]).flatMap(kind => [false, true].map(closed => ({ kind, closed }))))('room_wait observes $kind state without a bus post (closed before wait=$closed)', async ({ kind, closed }) => {
  const f = await fixture(), { room, tools, slots, session } = f
  try {
    if (closed) {
      const result = { owner: 'A', other: 'B', kind, path: 'x', subject: 'subject', inputs: 'i', factId: 'f' }
      const key = slotKey('A', kind, 'B', 'x', 'subject')
      await slots.settle(key, { ...result, status: 'conflict' }); await slots.settle(key, { ...result, status: 'clean' })
      const reply = await tools.call('room_wait', { timeoutMs: 1500 })
      expect(reply).toContain('previous alert no longer active'); expect(reply).not.toContain('timeout')
      expect(tools.ledger.candidates(session)).toEqual([])
      return
    }
    const waiting = tools.call('room_wait', { timeoutMs: 1500 })
    await new Promise(resolve => setTimeout(resolve, 40))
    await slots.settle(slotKey('A', kind, 'B', 'x', 'subject'), { owner: 'A', other: 'B', kind, path: 'x', subject: 'subject', status: 'conflict', inputs: 'i', factId: 'f' })
    const reply = await waiting
    expect(reply).toContain(kind === 'contract' ? 'CONTRACT' : 'CONFLICT')
    expect(reply).not.toContain('timeout')
    expect(room.messages().filter(m => ['conflict', 'merge-conflict', 'contract'].includes(m.type))).toEqual([])
  } finally { await f.close() }
})

it.each(['participants', 'manifestHead'] as const)('room_wait immediately observes a lead opening restored through %s', async restored => {
  const f = await fixture(), { room, tools, slots } = f
  try {
    room.participants.set('W\0holder', { workerId: 'w' } as never)
    const projection = { projectedFrom: 'w', projectedBy: 'A' }
    if (restored === 'participants') room.manifestHead.set('W', projection as never)
    else room.participants.set('W\0proj', projection)
    await slots.settle(slotKey('W', 'merge', 'P', 'x'), { owner: 'W', other: 'P', kind: 'merge', path: 'x', status: 'conflict', inputs: 'i', factId: 'f' })
    expect(openConflicts(room, 'A')).toEqual([])
    const waiting = tools.call('room_wait', { timeoutMs: 1500 })
    await new Promise(resolve => setTimeout(resolve, 40))
    if (restored === 'participants') room.participants.set('W\0proj', projection)
    else room.manifestHead.set('W', projection as never)
    expect(openConflicts(room, 'A')).toHaveLength(1)
    const reply = await waiting
    expect(reply).toContain('CONFLICT')
    expect(reply).not.toContain('timeout')
  } finally { await f.close() }
})
