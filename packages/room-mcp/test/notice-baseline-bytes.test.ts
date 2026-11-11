import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RoomDoc, outgoing } from '@room/shared'
import { ConflictSlots, slotKey, type Evaluation } from '../src/conflict-set.js'
import type { Session } from '../src/session.js'
import type { Post } from '../src/post.js'

const random = vi.hoisted(() => ({ n: 0 }))
vi.mock('node:crypto', async original => ({ ...await original<typeof import('node:crypto')>(), randomUUID: () => `review-uuid-${++random.n}` }))
let baseline: typeof ConflictSlots, scratch: string
beforeAll(async () => {
  const testDir = dirname(fileURLToPath(import.meta.url)), sourceDir = join(testDir, '../src')
  scratch = mkdtempSync(join(testDir, '.review-notice-baseline-'))
  const source = execFileSync('git', ['show', 'v0.17.47:packages/room-mcp/src/conflict-set.ts'], { cwd: testDir, encoding: 'utf8' })
    .replaceAll(/from '\.\/(.*?)'/g, (_match, relative) => `from '${join(sourceDir, relative)}'`)
  const module = join(scratch, 'baseline.ts')
  writeFileSync(module, source)
  baseline = (await import(/* @vite-ignore */ module)).ConflictSlots
})
afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }) })

async function traffic(Slots: typeof ConflictSlots, kind: Evaluation['kind'], capable = false, worker = false): Promise<string[]> {
  random.n = 0
  const room = new RoomDoc(), frames: string[] = []
  const post: Post = ((from: any, body: any, options: any) => {
    const msg = outgoing(from, body, options.id)
    // Full message bytes and post options, including deterministic IDs and urgency.
    frames.push(JSON.stringify({ op: 'post', msg, auto: options.auto }))
    return Object.assign(Promise.resolve({ ok: true as const, msg: { ...msg, at: 123 } }), { id: options.id })
  }) as Post
  room.participants.set('A\0holder', { sessionId: 's', epoch: 1 })
  if (worker) room.participants.set('B\0holder', { sessionId: 'b', epoch: 2, workerId: 'w1' })
  const session = { room, me: { name: 'A', kind: 'agent' }, post, lease: { sessionId: 's', fence: () => '1' },
    contract: { legacy: false, capabilities: { 'room.notice-lifecycle': 1 } }, hub: { noticeIncarnation: () => 1,
      noticeLifecycle: async (intent: any) => {
        expect(intent.action).toBe('register')
        frames.push(JSON.stringify({ op: 'post', msg: intent.msg, auto: true }))
        return { ok: true, managed: true }
      } } } as unknown as Session
  const slots = new Slots(room, post, '1', () => 123, () => {}, post, () => true, capable ? session : undefined)
  const settle = (member: string, status: Evaluation['status'], factId = status) => slots.settle(
    slotKey('A', kind, 'B', kind === 'merge' ? member : 'x', kind === 'merge' ? '' : member),
    { kind, owner: 'A', other: 'B', path: kind === 'merge' ? member : 'x', subject: member,
      status, inputs: `${member}:${status}:${factId}`, factId: status === 'clean' ? '' : factId })
  try {
    await settle('c1', 'conflict')
    await settle('c2', kind === 'edit-in-claim' ? 'possible' : 'conflict')
    await slots.replay('A')
    await settle('c1', 'unknown')
    await slots.replay('A')
    await settle('c1', 'clean')
    await settle('c2', 'clean')
    await slots.replay('A')
    await settle('c1', 'possible')
    await settle('c1', 'conflict')
    await settle('c1', 'clean')
    slots.drop(slotKey('A', kind, 'B', kind === 'merge' ? 'c1' : 'x', kind === 'merge' ? '' : 'c1'))
    await settle('c1', 'conflict')
    await slots.replay('A')
    return frames
  } finally { room.doc.destroy() }
}

describe.each([false, true])('notice compatibility with pinned v0.17.47 (capable=%s)', capable => {
  it.each(['merge', 'edit-in-claim', 'claims', 'contract'] as const)('%s messages, ids and post options remain byte-identical', async kind => {
    expect(await traffic(ConflictSlots, kind, capable)).toEqual(await traffic(baseline, kind))
  })
})


it.each(['merge', 'edit-in-claim', 'claims', 'contract'] as const)('%s worker notices keep v0.17.47 bytes on old hubs and change only id on capable hubs', async kind => {
  const old = await traffic(baseline, kind, false, true)
  expect(await traffic(ConflictSlots, kind, false, true)).toEqual(old)
  const current = await traffic(ConflictSlots, kind, true, true)
  expect(current).toHaveLength(old.length)
  expect(current.map(frame => {
    const parsed = JSON.parse(frame)
    expect(parsed.msg.id).toMatch(/:worker:[0-9a-f]{64}$/)
    parsed.msg.id = parsed.msg.id.replace(/:worker:[0-9a-f]{64}$/, '')
    return JSON.stringify(parsed)
  })).toEqual(old)
})
