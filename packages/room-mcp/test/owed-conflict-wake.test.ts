import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { RoomDoc, openConflicts, type ConflictKind } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { ConflictSlots, slotKey, type Evaluation } from '../src/conflict-set.js'
import { Ledger, formatDeliveryItem, isConflictItem } from '../src/ledger.js'
import { WakeReconciler } from '../src/wake-reconciler.js'
import type { Session } from '../src/session.js'

const close: (() => void)[] = []
afterEach(() => { for (const stop of close.splice(0)) stop() })
function fixture(initialDirectory = true) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'room-owed-conflict-')), room = new RoomDoc(), slots = new ConflictSlots(room, '1')
  const s = { room, dir, roomName: 'r', me: { name: 'A', kind: 'agent' }, awareness: { setLocalStateField() {} } } as unknown as Session
  let sessionDirectory: string | undefined = initialDirectory ? dir : undefined
  room.participants.set('A\0holder', { sessionId: 'session', epoch: 1 }); room.participants.set('R\0holder', { sessionId: 'r', epoch: 1 });
  let bound = false, ledger: Ledger, wakes: WakeReconciler
  const send = vi.fn(async () => 'socket' as const)
  const start = () => {
    ledger = new Ledger({ sessionId: () => 'session', sessionDir: () => sessionDirectory, route: () => ({}) }); ledger.bind(s)
    wakes = new WakeReconciler({ ledger, bound: () => bound ? { host: 'claude', id: 'session' } : undefined,
      sessionDir: () => sessionDirectory, send, windowMs: 0, pollMs: 10 }); wakes.attach(s)
  }
  start()
  close.push(() => { wakes.stop(); ledger.unbind(s); room.doc.destroy(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { room, s, send, ledger: () => ledger,
    directory(value: string | undefined) { sessionDirectory = value },
    async settle(kind: ConflictKind, status: Evaluation['status'] = 'conflict', extra: Partial<Evaluation> = {}) {
      const result: Evaluation = { kind, owner: 'A', other: 'B', path: 'x', subject: 'subject', status, inputs: Math.random().toString(), factId: 'fact', lines: [1], ...extra }
      await slots.settle(slotKey('A', kind, 'B', 'x', result.subject), result)
    },
    restart() { wakes.stop(); ledger.unbind(s); start() },
    wake() { bound = true; wakes.reconcile() },
    read() { const batch = ledger.open('reply'), items = ledger.select(s, batch); ledger.commit(batch); return items },
  }
}
for (const kind of ['merge', 'edit-in-claim', 'claims', 'contract'] as const) {
  it.each(['clean', 'possible', 'new-opening'] as const)(kind + ' keeps an observed owed wake across %s and restart', async transition => {
    const f = fixture()
    await f.settle(kind)
    expect(f.ledger().candidates(f.s)).toHaveLength(1)
    const original = openConflicts(f.room, 'A')[0]!
    if (transition === 'clean') await f.settle(kind, 'clean')
    else if (transition === 'possible') await f.settle(kind, 'possible', { lines: [9] })
    else {
      const map = f.room.doc.getMap<import('@room/shared').ConflictSlot>('conflicts')
      const [key, slot] = [...map][0]!
      map.set(key, { ...slot, openId: 'changed-opening', lines: [17] })
    }
    f.ledger().candidates(f.s); f.restart(); f.wake()
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce(), { timeout: 500 })
    const items = f.read()
    expect(items).toHaveLength(transition === 'clean' ? 1 : 2)
    expect(items.filter(isConflictItem).find(item => item.status === 'inactive')!.priority).toBe(original.priority)
    const line = formatDeliveryItem(items.find(item => isConflictItem(item) && item.status === (transition === 'clean' ? 'inactive' : 'open'))!)
    if (transition === 'clean') expect(line).toMatch(/alert.*no longer active/)
    else if (transition === 'possible') expect(line).toContain('POSSIBLE')
    else if (kind === 'merge') expect(line).toContain('lines 17')
    f.restart(); expect(f.read()).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 20)); expect(f.send).toHaveBeenCalledOnce()
  })
}
it('an old quiet presentation cannot acknowledge the pending note for a departed opening', async () => {
  const f = fixture()
  const slots = new ConflictSlots(f.room, '1')
  const settle = (path: string, status: 'possible' | 'conflict') => slots.settle(slotKey('A', 'merge', 'B', path), {
    owner: 'A', other: 'B', kind: 'merge', path, status, inputs: path + status, factId: path, lines: [1],
  })
  await settle('x', 'possible')
  const old = f.ledger().open('reply'), selected = f.ledger().select(f.s, old).filter(isConflictItem)
  expect(selected).toHaveLength(1); expect(selected[0]!.wakeId).toBeUndefined()
  await settle('y', 'conflict'); await settle('y', 'possible')
  const current = f.ledger().candidates(f.s).filter(isConflictItem)
  expect(current.find(item => item.status === 'open')!.conflict?.slots.map(slot => slot.path)).toEqual(['x', 'y'])
  const before = current.find(item => item.status === 'inactive')!
  expect(f.ledger().conflictWakeable(f.s, before)).toBe(true)
  f.ledger().commit(old)
  const after = f.ledger().candidates(f.s).filter(isConflictItem).find(item => item.status === 'inactive')!
  expect(f.ledger().conflictWakeable(f.s, after)).toBe(true)
  f.ledger().flushConflicts()
  const saved = JSON.parse(fs.readFileSync(join(f.s.dir, 'conflicts.json'), 'utf8')).r
  expect(saved.entries[selected[0]!.id].shown).toBe(selected[0]!.fingerprint)
  expect(saved.pending.wake.id).toBe(before.wakeId)
  f.restart(); f.wake()
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  expect(f.read().filter(isConflictItem).find(item => item.status === 'inactive')).toMatchObject({ priority: 'notify' })
})

it('an old quiet courtesy cannot delete a newer debt in an opening revealed again', async () => {
  const f = fixture(), slots = new ConflictSlots(f.room, '1')
  const projection = { projectedFrom: 'w', projectedBy: 'A' }
  f.room.participants.set('W\0proj', projection); f.room.manifestHead.set('W', { ...projection, fence: '1' } as never)
  const settle = (path: string, status: 'possible' | 'conflict') => slots.settle(slotKey('W', 'merge', 'P', path), {
    owner: 'W', other: 'P', kind: 'merge', path, status, inputs: path + status, factId: path,
  })
  await settle('x', 'possible'); expect(f.read()).toHaveLength(1)
  f.room.manifestHead.delete('W')
  const old = f.ledger().open('reply'), selected = f.ledger().select(f.s, old).filter(isConflictItem)
  expect(selected).toMatchObject([{ status: 'inactive', priority: 'fyi' }]); expect(selected[0]!.wakeId).toBeUndefined()
  f.room.manifestHead.set('W', { ...projection, fence: '1' } as never)
  await settle('y', 'conflict'); await settle('y', 'possible')
  expect(f.ledger().candidates(f.s).filter(isConflictItem).some(item => f.ledger().conflictWakeable(f.s, item))).toBe(true)
  f.ledger().commit(old)
  expect(f.ledger().candidates(f.s).filter(isConflictItem).some(item => f.ledger().conflictWakeable(f.s, item))).toBe(true)
})

it('a late shown notify line finally delivers its opening even if the undelivered debt rose to interrupt', async () => {
  const f = fixture()
  const view = { id: 'w', name: 'B', lead: 'A', status: 'running', run: 1, startedAt: 1, fence: '1' } as const
  f.room.workerViews.set('w', view as never)
  await f.settle('edit-in-claim')
  const old = f.ledger().open('reply'), selected = f.ledger().select(f.s, old).filter(isConflictItem)[0]!
  expect(selected.priority).toBe('notify')
  f.room.workerViews.set('w', { ...view, lead: 'R' } as never)
  const current = f.ledger().candidates(f.s).filter(isConflictItem)[0]!
  expect(current.id).toBe(selected.id); expect(current.priority).toBe('interrupt')
  expect(current.wakeId).toBe(selected.wakeId)
  f.ledger().commit(old)
  expect(f.ledger().conflictWakeRecorded(f.s, selected.id)).toBe(true)
  expect(f.ledger().conflictWakeable(f.s, f.ledger().candidates(f.s).filter(isConflictItem)[0]!)).toBe(false)
  f.restart(); f.wake(); await new Promise(resolve => setTimeout(resolve, 30)); expect(f.send).not.toHaveBeenCalled()
  expect(f.read()[0]!.priority).toBe('interrupt')
})

it('an opening delivered at notify does not wake again when its urgency rises to interrupt', async () => {
  const f = fixture(), view = { id: 'w', name: 'B', lead: 'A', status: 'running', run: 1, startedAt: 1, fence: '1' } as const
  f.room.workerViews.set('w', view as never)
  await f.settle('edit-in-claim'); f.wake()
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  const original = f.ledger().candidates(f.s).filter(isConflictItem)[0]!
  expect(original.priority).toBe('notify')
  f.room.workerViews.set('w', { ...view, lead: 'R' } as never)
  const higher = f.ledger().candidates(f.s).filter(isConflictItem)[0]!
  expect(higher.id).toBe(original.id); expect(higher.priority).toBe('interrupt')
  expect(f.ledger().conflictWakeable(f.s, higher)).toBe(false)
  f.restart(); await new Promise(resolve => setTimeout(resolve, 30))
  expect(f.send).toHaveBeenCalledOnce()
  expect(f.read()[0]!.priority).toBe('interrupt')
})

it.each(['downgrade', 'upgrade', 'joined-opening', 'changed-opening', 'disappeared'].flatMap(transition =>
  [false, true].map(restart => ({ transition, restart }))))('a late batch cannot acknowledge another token after $transition (restart=$restart)', async ({ transition, restart }) => {
  const f = fixture(), slots = new ConflictSlots(f.room, '1')
  const settle = (path: string, status: 'possible' | 'conflict' | 'clean', kind: ConflictKind = 'merge', owner = 'A', other = 'B') =>
    slots.settle(slotKey(owner, kind, other, path), { owner, other, kind, path, status, inputs: path + status, factId: path, lines: [1] })
  if (transition === 'upgrade' || transition === 'downgrade') {
    f.room.participants.set('W\0proj', { projectedFrom: 'w', projectedBy: 'A' })
    f.room.manifestHead.set('W', { projectedFrom: 'w', projectedBy: 'A', fence: '1' } as never)
    f.room.participants.set('P\0holder', { workerId: 'p' } as never)
    await settle('x', 'possible', 'merge', 'W', 'P')
  } else await settle('x', transition === 'joined-opening' ? 'possible' : 'conflict')
  const old = f.ledger().open('reply'), selected = f.ledger().select(f.s, old).filter(isConflictItem)
  expect(selected).toHaveLength(1)
  if (transition === 'upgrade' || transition === 'downgrade') {
    f.room.participants.set('P\0proj', { projectedFrom: 'p', projectedBy: 'R' })
    f.room.manifestHead.set('P', { projectedFrom: 'p', projectedBy: 'R', fence: '1' } as never)
    expect(openConflicts(f.room, 'A')[0]!.priority).toBe('notify')
    if (transition === 'downgrade') f.room.manifestHead.delete('P')
  } else if (transition === 'joined-opening') {
    await settle('y', 'conflict'); await settle('y', 'possible')
  } else if (transition === 'changed-opening') {
    const map = f.room.doc.getMap<import('@room/shared').ConflictSlot>('conflicts'), [key, slot] = [...map][0]!
    map.set(key, { ...slot, openId: 'second-opening' })
  } else {
    await settle('x', 'clean'); await settle('y', 'conflict', 'contract'); await settle('y', 'clean', 'contract')
  }
  const before = f.ledger().candidates(f.s).filter(isConflictItem).filter(item => f.ledger().conflictWakeable(f.s, item) && item.wakeId !== selected[0]!.wakeId)
  expect(before).toHaveLength(1)
  expect(before[0]!.wakeId).not.toBe(selected[0]!.wakeId)
  if (restart) f.restart()
  f.ledger().commit(old)
  const after = f.ledger().candidates(f.s).filter(isConflictItem).filter(item => f.ledger().conflictWakeable(f.s, item))
  expect(after).toHaveLength(1); expect(after[0]!.wakeId).toBe(before[0]!.wakeId)
  f.ledger().flushConflicts(); f.restart()
  const matching = f.ledger().open('reply')
  expect(f.ledger().select(f.s, matching).filter(isConflictItem).map(item => item.wakeId)).toContain(after[0]!.wakeId)
  f.ledger().commit(matching); f.restart(); f.wake()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(f.send).not.toHaveBeenCalled()
  expect(f.ledger().candidates(f.s).filter(isConflictItem).some(item => f.ledger().conflictWakeable(f.s, item))).toBe(false)
})

it.each([false, true])('a late delivery carrying the same wake token acknowledges it after a downgrade (restart=%s)', async restart => {
  const f = fixture(); await f.settle('merge')
  const old = f.ledger().open('reply'), selected = f.ledger().select(f.s, old).filter(isConflictItem)[0]!
  await f.settle('merge', 'possible')
  const current = f.ledger().candidates(f.s).filter(isConflictItem).find(item => item.status === 'inactive')!
  expect(current.id).not.toBe(selected.id); expect(current.wakeId).toBe(selected.wakeId)
  if (restart) f.restart()
  f.ledger().commit(old)
  expect(f.ledger().candidates(f.s).filter(isConflictItem).some(item => f.ledger().conflictWakeable(f.s, item))).toBe(false)
})

it('records an observed opening synchronously even when it closes before the wake pass', async () => {
  const f = fixture()
  await f.settle('contract'); await f.settle('contract', 'clean')
  f.restart(); f.wake()
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce(), { timeout: 500 })
  expect(f.read().map(formatDeliveryItem).join('\n')).toMatch(/alert.*no longer active/)
})
it.each(['participants', 'manifestHead'] as const)('records a lead opening restored through %s before it clears synchronously', async restored => {
  const f = fixture()
  f.room.participants.set('W\0holder', { workerId: 'w' } as never)
  const projection = { projectedFrom: 'w', projectedBy: 'A' }
  if (restored === 'participants') f.room.manifestHead.set('W', { ...projection, fence: '1' } as never)
  else f.room.participants.set('W\0proj', projection)
  await f.settle('merge', 'conflict', { owner: 'W', other: 'P' })
  f.restart() // Bind the lead with the existing W-P conflict but no accepted projection.
  expect(openConflicts(f.room, 'A')).toEqual([])
  if (restored === 'participants') f.room.participants.set('W\0proj', projection)
  else f.room.manifestHead.set('W', { ...projection, fence: '1' } as never)
  expect(openConflicts(f.room, 'A')).toHaveLength(1)
  f.room.doc.getMap('conflicts').clear()
  // No microtask may intervene between restoration and clearance.
  expect(f.ledger().candidates(f.s)).toMatchObject([{ status: 'inactive', priority: 'notify' }])
  f.restart(); f.wake()
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  expect(f.read().map(formatDeliveryItem).join('\n')).toMatch(/alert.*no longer active/)
})
it('coalesces unlimited disappeared obligations, retains highest urgency, and clears only on presentation', async () => {
  const f = fixture()
  for (let n = 0; n < 100; n++) {
    await f.settle('edit-in-claim', 'conflict', { subject: 'subject-' + n })
    f.ledger().candidates(f.s)
    await f.settle('edit-in-claim', 'clean', { subject: 'subject-' + n })
    f.ledger().candidates(f.s)
  }
  expect(f.ledger().flushConflicts()).toBe(true)
  const saved = fs.readFileSync(join(f.s.dir, 'conflicts.json'), 'utf8')
  expect(saved.length).toBeLessThan(3000)
  expect(f.ledger().candidates(f.s).filter(isConflictItem)).toHaveLength(1)
  f.restart(); f.wake(); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce(), { timeout: 500 })
  const pending = f.read(); expect(pending).toHaveLength(1); expect(pending[0]!.priority).toBe('interrupt')
  f.restart(); expect(f.read()).toEqual([])
})
it('a shown opening clears quietly while an unshown confirmed wake keeps its inactive line', async () => {
  const f = fixture(); await f.settle('merge'); f.wake()
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  await f.settle('merge', 'clean'); f.restart()
  const pending = f.read(); expect(pending).toHaveLength(1)
  expect(formatDeliveryItem(pending[0]!)).toMatch(/alert.*no longer active/)
  await new Promise(resolve => setTimeout(resolve, 20)); expect(f.send).toHaveBeenCalledOnce()
})
it('reading before transport delivery discharges the owed wake', async () => {
  const f = fixture(); await f.settle('claims'); await f.settle('claims', 'clean')
  expect(f.read()).toHaveLength(1); f.restart(); f.wake()
  await new Promise(resolve => setTimeout(resolve, 30)); expect(f.send).not.toHaveBeenCalled()
})
it('a failed hook handoff leaves a disappeared wake owed', async () => {
  const f = fixture(); await f.settle('contract'); await f.settle('contract', 'clean')
  const batch = f.ledger().open('hook'); f.ledger().select(f.s, batch); f.ledger().discard(batch)
  f.restart(); f.wake(); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  expect(f.read()).toHaveLength(1)
})
it('a late confirmed send follows an opening into its inactive record', async () => {
  const f = fixture(); await f.settle('merge')
  const original = f.ledger().candidates(f.s).filter(isConflictItem)
  await f.settle('merge', 'clean')
  f.ledger().conflictsWoken(original.map(m => ({ s: f.s, m })))
  f.restart(); f.wake(); await new Promise(resolve => setTimeout(resolve, 30))
  expect(f.send).not.toHaveBeenCalled(); expect(f.read()).toHaveLength(1)
})
it('an old in-flight confirmation cannot receipt another disappeared opening', async () => {
  const f = fixture(); await f.settle('merge'); await f.settle('merge', 'clean')
  const first = f.ledger().candidates(f.s).filter(isConflictItem)
  await f.settle('contract'); await f.settle('contract', 'clean')
  f.ledger().conflictsWoken(first.map(m => ({ s: f.s, m })))
  f.restart(); f.wake(); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  expect(f.read()).toHaveLength(1)
})
it('an old in-flight read cannot receipt a newer disappeared opening', async () => {
  const f = fixture(); await f.settle('merge'); await f.settle('merge', 'clean')
  const batch = f.ledger().open('hook'); f.ledger().select(f.s, batch)
  await f.settle('contract'); await f.settle('contract', 'clean')
  f.ledger().commit(batch); f.restart(); f.wake()
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  expect(f.read()).toHaveLength(1)
})
it('a late read of the original open line clears the singleton pending note carrying its token', async () => {
  const f = fixture(); await f.settle('merge')
  const batch = f.ledger().open('hook'); f.ledger().select(f.s, batch)
  await f.settle('merge', 'clean'); f.ledger().commit(batch)
  const items = f.read(); expect(items).toHaveLength(1); expect(items[0]!.priority).toBe('fyi')
  f.restart(); f.wake(); await new Promise(resolve => setTimeout(resolve, 30))
  expect(f.send).not.toHaveBeenCalled(); expect(f.read()).toEqual([])
})
it('inactive room expiry never evicts an unshown owed wake', async () => {
  const f = fixture(); await f.settle('merge'); await f.settle('merge', 'clean')
  f.ledger().flushConflicts()
  const file = join(f.s.dir, 'conflicts.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  saved.detached = { ...saved.r, touchedAt: Date.now() - 8 * 86400_000 }
  fs.writeFileSync(file, JSON.stringify(saved)); f.restart()
  await f.settle('contract'); f.read()
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).detached.pending.wake.priority).toBe('notify')
})
it('persists a whole observed pass once instead of writing each opening', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'room-owed-pass-')), room = new RoomDoc(), slots = new ConflictSlots(room, '1')
  const s = { room, dir, roomName: 'r', me: { name: 'A', kind: 'agent' } } as Session
  const ledger = new Ledger({ sessionId: () => 'session', sessionDir: () => dir, route: () => ({}) }); ledger.bind(s)
  const rename = vi.spyOn(fs, 'renameSync')
  try {
    for (let n = 0; n < 20; n++) await slots.settle(slotKey('A', 'contract', 'B', 'x', 'fn' + n), {
      owner: 'A', other: 'B', kind: 'contract', path: 'x', subject: 'fn' + n, status: 'conflict', inputs: 'i', factId: 'f',
    })
    const writes = () => rename.mock.calls.filter(([, target]) => String(target).endsWith('conflicts.json'))
    expect(writes()).toHaveLength(0)
    expect(ledger.flushConflicts()).toBe(true); expect(writes()).toHaveLength(1)
    expect(Object.keys(JSON.parse(fs.readFileSync(join(dir, 'conflicts.json'), 'utf8')).r.entries)).toHaveLength(20)
    ledger.flushConflicts(); expect(writes()).toHaveLength(1)
  } finally { rename.mockRestore(); ledger.unbind(s); room.doc.destroy(); fs.rmSync(dir, { recursive: true, force: true }) }
})
it('persists the owed opening before submitting its host wake', async () => {
  const f = fixture(); await f.settle('claims')
  f.send.mockImplementation(async () => {
    const receipts = JSON.parse(fs.readFileSync(join(f.s.dir, 'conflicts.json'), 'utf8')).r.entries
    expect(Object.values(receipts)).toContainEqual(expect.objectContaining({ wake: expect.objectContaining({ priority: 'notify', woken: undefined }) }))
    return 'socket'
  })
  f.wake(); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
})
it('does not submit a host wake until its owed record can be written', async () => {
  const f = fixture(); await f.settle('claims')
  const original = fs.renameSync
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).endsWith('conflicts.json')) throw new Error('unwritable receiver record')
    original(from, to)
  })
  try {
    f.wake(); await new Promise(resolve => setTimeout(resolve, 30)); expect(f.send).not.toHaveBeenCalled()
  } finally { rename.mockRestore() }
  f.wake(); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
})
it('an unwritable conflict record leaves ordinary message wakes working', async () => {
  const f = fixture(); await f.settle('claims')
  hubAppend(f.room, { name: 'B', kind: 'agent' }, { type: 'note', to: 'A', text: 'ordinary note', priority: 'notify' })
  const original = fs.renameSync
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).endsWith('conflicts.json')) throw new Error('unwritable receiver record')
    original(from, to)
  })
  try {
    f.wake(); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce(), { timeout: 250 })
    expect(f.send.mock.calls[0]).toEqual(expect.arrayContaining([expect.stringContaining('B sent a note')]))
    expect(f.send.mock.calls[0]?.join(' ')).not.toContain('conflict with')
  } finally { rename.mockRestore() }
})

for (const initiallyBound of [false, true]) {
  it.each(['possible', 'clean'] as const)('directory boundary keeps a previously observed owed %s alert (initially bound=' + initiallyBound + ')', async status => {
    const f = fixture(initiallyBound); await f.settle('claims')
    await f.settle('claims', status)
    const before = f.ledger().candidates(f.s).filter(isConflictItem).filter(item => item.wakeId)
    expect(before).toHaveLength(1); expect(before[0]!.priority).toBe('notify')
    const target = initiallyBound ? join(f.s.dir, 'rebound') : f.s.dir
    fs.mkdirSync(target, { recursive: true }); f.directory(target)
    const after = f.ledger().candidates(f.s).filter(isConflictItem).filter(item => item.wakeId)
    expect(after).toHaveLength(1); expect(after[0]!.priority).toBe('notify')
    expect(f.ledger().conflictWakeable(f.s, after[0]!)).toBe(true)
    expect(f.ledger().flushConflicts()).toBe(true)
    f.restart(); f.wake(); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
    expect(f.read().map(formatDeliveryItem).join('\n')).toContain(status === 'possible' ? 'POSSIBLE' : 'no longer active')
  })
  it('directory boundary keeps a shown opening and its fingerprint (initially bound=' + initiallyBound + ')', async () => {
    const f = fixture(initiallyBound); await f.settle('contract')
    expect(f.read()).toHaveLength(1)
    const target = initiallyBound ? join(f.s.dir, 'rebound') : f.s.dir
    fs.mkdirSync(target, { recursive: true }); f.directory(target)
    expect(f.read()).toEqual([])
    f.ledger().flushConflicts(); f.restart(); expect(f.read()).toEqual([])
    await f.settle('contract', 'clean')
    expect(f.read()).toMatchObject([{ priority: 'fyi', status: 'inactive' }])
  })
  it('directory boundary keeps a confirmed wake for an unshown opening (initially bound=' + initiallyBound + ')', async () => {
    const f = fixture(initiallyBound); await f.settle('merge'); f.wake()
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
    const target = initiallyBound ? join(f.s.dir, 'rebound') : f.s.dir
    fs.mkdirSync(target, { recursive: true }); f.directory(target)
    const item = f.ledger().candidates(f.s).filter(isConflictItem)[0]!
    expect(f.ledger().conflictWakeable(f.s, item)).toBe(false)
    f.ledger().flushConflicts(); f.restart()
    await new Promise(resolve => setTimeout(resolve, 20)); expect(f.send).toHaveBeenCalledOnce()
  })
}
it('a direct flush follows a later directory change and persists the whole current record', async () => {
  const f = fixture(); await f.settle('contract'); f.ledger().flushConflicts()
  const target = join(f.s.dir, 'rebound'); fs.mkdirSync(target); f.directory(target)
  expect(f.ledger().flushConflicts()).toBe(true)
  expect(JSON.parse(fs.readFileSync(join(target, 'conflicts.json'), 'utf8')).r.entries).toEqual(expect.any(Object))
  f.restart(); f.wake(); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
})
it.each(['shown', 'woken'] as const)('initial binding combines disk %s proof with the opening observed in memory', async proof => {
  const f = fixture(false); await f.settle('claims')
  const item = f.ledger().candidates(f.s).filter(isConflictItem)[0]!
  fs.writeFileSync(join(f.s.dir, 'conflicts.json'), JSON.stringify({ r: { participant: 'A', delivered: { [item.id]: 1 }, entries: {
    [item.id]: { label: item.label, ...(proof === 'shown' ? { shown: item.fingerprint } : {}) },
  } } }))
  f.directory(f.s.dir)
  const current = f.ledger().candidates(f.s).filter(isConflictItem)
  if (proof === 'shown') expect(current).toEqual([])
  else { expect(current).toHaveLength(1); expect(f.ledger().conflictWakeable(f.s, current[0]!)).toBe(false) }
  f.ledger().flushConflicts(); f.restart()
  const restored = f.ledger().candidates(f.s).filter(isConflictItem)
  expect(restored.map(item => item.id)).toEqual(current.map(item => item.id))
  f.wake(); await new Promise(resolve => setTimeout(resolve, 20)); expect(f.send).not.toHaveBeenCalled()
})
it('initial binding preserves an in-memory shown receipt over an older disk obligation', async () => {
  const f = fixture(false); await f.settle('contract')
  const item = f.read().filter(isConflictItem)[0]!
  fs.writeFileSync(join(f.s.dir, 'conflicts.json'), JSON.stringify({ r: { participant: 'A', delivered: {}, entries: {
    [item.id]: { label: 'old contract', wake: { id: item.wakeId, priority: 'notify' } },
  } } }))
  f.directory(f.s.dir); expect(f.read()).toEqual([])
  f.ledger().flushConflicts(); f.restart(); expect(f.read()).toEqual([])
})
it('initial binding cannot use a disk presentation alone to discharge memory debt', async () => {
  const f = fixture(false); await f.settle('claims')
  const item = f.ledger().candidates(f.s).filter(isConflictItem)[0]!
  fs.writeFileSync(join(f.s.dir, 'conflicts.json'), JSON.stringify({ r: { participant: 'A', delivered: {}, entries: {
    [item.id]: { label: item.label, shown: item.fingerprint },
  } } }))
  f.directory(f.s.dir)
  const current = f.ledger().candidates(f.s).filter(isConflictItem)[0]!
  expect(current.wakeId).toBe(item.wakeId); expect(f.ledger().conflictWakeable(f.s, current)).toBe(true)
})
it('initial binding coalesces disk and memory inactive obligations without losing either urgency or unshown debt', async () => {
  const f = fixture(false); await f.settle('edit-in-claim'); await f.settle('edit-in-claim', 'clean')
  fs.writeFileSync(join(f.s.dir, 'conflicts.json'), JSON.stringify({ r: { participant: 'A', delivered: {}, entries: {},
    pending: { label: 'old contract with C', wake: { id: 'disk-inactive', priority: 'notify', woken: true } },
  } }))
  f.directory(f.s.dir)
  const pending = f.ledger().candidates(f.s).filter(isConflictItem)
  expect(pending).toHaveLength(1); expect(pending[0]!.priority).toBe('interrupt')
  expect(f.ledger().conflictWakeable(f.s, pending[0]!)).toBe(true)
  f.ledger().flushConflicts(); f.restart(); f.wake()
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  expect(f.read()).toHaveLength(1)
})
it('initial binding keeps confirmation of the same pending token from either memory or disk', async () => {
  const f = fixture(false); await f.settle('merge'); await f.settle('merge', 'clean')
  const pending = f.ledger().candidates(f.s).filter(isConflictItem)[0]!
  f.ledger().conflictsWoken([{ s: f.s, m: pending }])
  fs.writeFileSync(join(f.s.dir, 'conflicts.json'), JSON.stringify({ r: { participant: 'A', entries: {}, delivered: {},
    pending: { label: pending.label, wake: { id: pending.wakeId, priority: pending.priority } },
  } }))
  f.directory(f.s.dir)
  const merged = f.ledger().candidates(f.s).filter(isConflictItem)[0]!
  expect(merged.wakeId).toBe(pending.wakeId)
  expect(f.ledger().conflictWakeable(f.s, merged)).toBe(false)
})
it('initial binding retains disk urgency but confirmation of the same opening is final', async () => {
  const f = fixture(false); await f.settle('claims')
  const original = f.ledger().candidates(f.s).filter(isConflictItem)[0]!
  fs.writeFileSync(join(f.s.dir, 'conflicts.json'), JSON.stringify({ r: { participant: 'A', delivered: {}, entries: {
    [original.id]: { label: original.label, wake: { id: 'disk-urgent', priority: 'interrupt' } },
  } } }))
  f.directory(f.s.dir)
  const merged = f.ledger().candidates(f.s).filter(isConflictItem)[0]!
  expect(merged.priority).toBe('interrupt'); expect(merged.wakeId).toBe(original.wakeId)
  f.ledger().conflictsWoken([{ s: f.s, m: original }])
  expect(f.ledger().conflictWakeRecorded(f.s, original.id)).toBe(true)
  expect(f.ledger().conflictWakeable(f.s, merged)).toBe(false)
})
it('returning to an older directory cannot resurrect an inactive obligation already shown in this process', async () => {
  const f = fixture(); await f.settle('merge'); await f.settle('merge', 'clean'); f.ledger().flushConflicts()
  const target = join(f.s.dir, 'rebound'); fs.mkdirSync(target); f.directory(target)
  f.ledger().candidates(f.s); expect(f.read()).toHaveLength(1)
  f.directory(f.s.dir); expect(f.read()).toEqual([])
  f.ledger().flushConflicts(); f.restart(); expect(f.read()).toEqual([])
})
it('temporarily losing the backing directory keeps current shown and coalesced records in memory', async () => {
  const f = fixture(); await f.settle('contract'); f.read()
  await f.settle('merge'); await f.settle('merge', 'clean'); f.ledger().flushConflicts()
  f.directory(undefined)
  const pending = f.ledger().candidates(f.s).filter(isConflictItem)
  expect(pending).toHaveLength(1); expect(pending[0]!.status).toBe('inactive')
  const target = join(f.s.dir, 'rebound'); fs.mkdirSync(target); f.directory(target)
  expect(f.read()).toHaveLength(1); expect(f.read()).toEqual([])
  f.restart(); expect(f.read()).toEqual([])
})
it('an in-flight confirmation still names its obligation across initial binding', async () => {
  const f = fixture(false); await f.settle('merge')
  const original = f.ledger().candidates(f.s).filter(isConflictItem)
  f.directory(f.s.dir); f.ledger().conflictsWoken(original.map(m => ({ s: f.s, m })))
  f.restart(); f.wake(); await new Promise(resolve => setTimeout(resolve, 20))
  expect(f.send).not.toHaveBeenCalled(); expect(f.read()).toHaveLength(1)
})
for (const initiallyBound of [false, true]) {
  it('directory boundary keeps a pending shown-alert courtesy (initially bound=' + initiallyBound + ')', async () => {
    const f = fixture(initiallyBound); await f.settle('contract'); f.read(); await f.settle('contract', 'clean')
    const target = initiallyBound ? join(f.s.dir, 'rebound') : f.s.dir
    fs.mkdirSync(target, { recursive: true }); f.directory(target)
    expect(f.read()).toMatchObject([{ status: 'inactive', priority: 'fyi' }])
    f.restart(); expect(f.read()).toEqual([])
  })
  it('directory boundary keeps an already-woken coalesced alert quiet until shown (initially bound=' + initiallyBound + ')', async () => {
    const f = fixture(initiallyBound); await f.settle('merge'); f.wake()
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce()); await f.settle('merge', 'clean')
    const target = initiallyBound ? join(f.s.dir, 'rebound') : f.s.dir
    fs.mkdirSync(target, { recursive: true }); f.directory(target)
    const pending = f.ledger().candidates(f.s).filter(isConflictItem)
    expect(pending).toHaveLength(1); expect(f.ledger().conflictWakeable(f.s, pending[0]!)).toBe(false)
    f.ledger().flushConflicts(); f.restart()
    await new Promise(resolve => setTimeout(resolve, 20)); expect(f.send).toHaveBeenCalledOnce()
    expect(f.read()).toHaveLength(1); expect(f.read()).toEqual([])
  })
}
it('initial binding carries all in-memory room buckets and retains unrelated disk buckets', async () => {
  const f = fixture(false), secondary = { ...f.s, roomName: 'secondary' }
  f.ledger().bind(secondary); await f.settle('claims')
  fs.writeFileSync(join(f.s.dir, 'conflicts.json'), JSON.stringify({ detached: { participant: 'D', entries: {}, delivered: {}, touchedAt: Date.now() } }))
  f.directory(f.s.dir); f.ledger().flushConflicts()
  const saved = JSON.parse(fs.readFileSync(join(f.s.dir, 'conflicts.json'), 'utf8'))
  expect(Object.keys(saved).sort()).toEqual(['detached', 'r', 'secondary'])
  for (const room of ['r', 'secondary']) expect(Object.values(saved[room].entries)).toContainEqual(expect.objectContaining({ wake: expect.objectContaining({ priority: 'notify' }) }))
  f.ledger().unbind(secondary)
})
it.each([false, true])('an unreadable destination record cannot discard live debt (initially bound=%s)', async initiallyBound => {
  const f = fixture(initiallyBound); await f.settle('claims'); await f.settle('claims', 'clean')
  const target = initiallyBound ? join(f.s.dir, 'rebound') : f.s.dir
  fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(join(target, 'conflicts.json'), '{broken')
  f.directory(target)
  const pending = f.ledger().candidates(f.s).filter(isConflictItem)
  expect(pending).toHaveLength(1); expect(f.ledger().conflictWakeable(f.s, pending[0]!)).toBe(true)
  f.ledger().flushConflicts(); f.restart(); f.wake()
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
})

it.each(['shown', 'woken'] as const)('an opening already %s never wakes again after leaving the view and returning unchanged', async delivered => {
  const f = fixture(); await f.settle('merge')
  const before = f.ledger().candidates(f.s).filter(isConflictItem)[0]!
  if (delivered === 'shown') {
    f.read()
    // Presentation is bounded independently of remembered wakes: crowd out its courtesy.
    for (let n = 0; n < 9; n++) { await f.settle('contract', 'conflict', { subject: 'fn' + n }); f.read() }
  }
  else f.ledger().conflictsWoken([{ s: f.s, m: before }])
  const map = f.room.doc.getMap<import('@room/shared').ConflictSlot>('conflicts'), saved = [...map].filter(([, slot]) => slot.kind === 'merge')
  map.clear()
  f.read(); f.restart()
  for (const [key, slot] of saved) map.set(key, slot)
  const after = f.ledger().candidates(f.s).filter(isConflictItem)
  expect(after.some(item => item.id === before.id)).toBe(true)
  expect(after.some(item => f.ledger().conflictWakeable(f.s, item))).toBe(false)
  f.restart(); f.wake()
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(f.send).not.toHaveBeenCalled()
  f.read(); await f.settle('merge', 'clean')
  expect(f.read()).toMatchObject([{ status: 'inactive', priority: 'fyi' }])
})

it.each(['shown', 'woken'] as const)('a generic pending note already %s does not claim its departed opening was delivered', async delivery => {
  const f = fixture(); await f.settle('merge')
  const original = f.ledger().candidates(f.s).filter(isConflictItem)[0]!
  const map = f.room.doc.getMap<import('@room/shared').ConflictSlot>('conflicts'), saved = [...map]
  map.clear()
  const pending = f.ledger().candidates(f.s).filter(isConflictItem)
  expect(pending).toMatchObject([{ status: 'inactive', wakeId: original.wakeId }])
  if (delivery === 'shown') f.read()
  else f.ledger().conflictsWoken(pending.map(m => ({ s: f.s, m })))
  expect(f.ledger().conflictWakeRecorded(f.s, original.id)).toBe(false)
  f.restart()
  for (const [key, slot] of saved) map.set(key, slot)
  const returned = f.ledger().candidates(f.s).filter(isConflictItem).find(item => item.id === original.id)!
  expect(f.ledger().conflictWakeable(f.s, returned)).toBe(true)
  f.ledger().conflictsWoken([{ s: f.s, m: returned }])
  expect(f.ledger().conflictWakeRecorded(f.s, original.id)).toBe(true)
  expect(f.ledger().conflictWakeable(f.s, returned)).toBe(false)
})

it('keeps every current opening fact and only the newest 64 absent facts, independently of presentation', async () => {
  const f = fixture(); await f.settle('merge')
  const original = f.read().filter(isConflictItem)[0]!
  const file = join(f.s.dir, 'conflicts.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  saved.r.delivered[original.id] = 1
  for (let n = 0; n < 100; n++) saved.r.delivered['absent-' + n] = n + 2
  saved.detached = { participant: 'D', touchedAt: Date.now(), entries: {}, delivered: { kept: 1 } }
  fs.writeFileSync(file, JSON.stringify(saved)); f.restart(); f.ledger().flushConflicts()
  const current = JSON.parse(fs.readFileSync(file, 'utf8'))
  expect(current.r.delivered[original.id]).toBe(1)
  expect(Object.keys(current.r.delivered)).toHaveLength(65)
  expect(Object.keys(current.r.delivered).filter(id => id.startsWith('absent-'))).toEqual(Array.from({ length: 64 }, (_, n) => 'absent-' + (n + 36)))
  expect(current.detached.delivered).toEqual({ kept: 1 })
  f.ledger().conflictsWoken([{ s: f.s, m: original }]); f.read()
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).r.delivered[original.id]).toBe(1)
  await f.settle('merge', 'clean'); f.ledger().flushConflicts()
  expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).r.delivered)).toHaveLength(64)
})

async function projectedOpening() {
  const f = fixture(), slots = new ConflictSlots(f.room, '1')
  const head = { projectedFrom: 'w', projectedBy: 'A', fence: '1' }
  f.room.participants.set('W\0proj', { projectedFrom: 'w', projectedBy: 'A' }); f.room.manifestHead.set('W', head as never)
  await slots.settle(slotKey('W', 'merge', 'B', 'x'), { owner: 'W', other: 'B', kind: 'merge', path: 'x', status: 'conflict', inputs: 'i', factId: 'f' })
  return { ...f, leaveAndReturn() { f.room.manifestHead.delete('W'); f.room.manifestHead.set('W', head as never) } }
}

it.each(['wake', 'shown'] as const)('Ledger records a late %s for an unchanged opening that left and returned while delivery was in flight', async delivery => {
  const f = await projectedOpening(), batch = f.ledger().open('reply')
  const original = (delivery === 'shown' ? f.ledger().select(f.s, batch) : f.ledger().candidates(f.s)).filter(isConflictItem)[0]!
  f.leaveAndReturn()
  expect(openConflicts(f.room, 'A')[0]!.id).toBe(original.id)
  if (delivery === 'shown') f.ledger().commit(batch)
  else f.ledger().conflictsWoken([{ s: f.s, m: original }])
  expect(f.ledger().conflictWakeRecorded(f.s, original.id)).toBe(true)
  expect(f.ledger().candidates(f.s).filter(isConflictItem).some(item => f.ledger().conflictWakeable(f.s, item))).toBe(false)
  f.restart(); f.wake()
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(f.send).not.toHaveBeenCalled()
})

it('WakeReconciler records a delayed host confirmation after an unchanged opening left and returned without another wake', async () => {
  const f = await projectedOpening()
  const original = openConflicts(f.room, 'A')[0]!
  let confirm!: () => void
  const pending = new Promise<void>(resolve => { confirm = resolve })
  f.send.mockImplementationOnce(async () => { await pending; return 'socket' })
  f.wake(); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  f.leaveAndReturn(); confirm()
  await vi.waitFor(() => expect(f.ledger().conflictWakeRecorded(f.s, original.id)).toBe(true), { timeout: 500 })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(f.send).toHaveBeenCalledOnce()
  f.restart(); await new Promise(resolve => setTimeout(resolve, 30))
  expect(f.send).toHaveBeenCalledOnce()
})

it('a shown projected opening does not wake again after its courtesy and restart', async () => {
  const f = fixture(), slots = new ConflictSlots(f.room, '1')
  const head = { projectedFrom: 'w', projectedBy: 'A', fence: '1' }
  f.room.participants.set('W\0proj', { projectedFrom: 'w', projectedBy: 'A' }); f.room.manifestHead.set('W', head as never)
  await slots.settle(slotKey('W', 'merge', 'B', 'x'), { owner: 'W', other: 'B', kind: 'merge', path: 'x', status: 'conflict', inputs: 'i', factId: 'f' })
  const before = f.read().filter(isConflictItem)
  expect(before).toMatchObject([{ status: 'open' }]); expect(before[0]!.wakeId).toBeDefined()
  f.room.manifestHead.delete('W')
  expect(f.read().filter(isConflictItem)).toMatchObject([{ status: 'inactive' }])
  f.restart()
  f.room.manifestHead.set('W', head as never)
  const after = f.ledger().candidates(f.s).filter(isConflictItem)
  expect(after).toMatchObject([{ id: before[0]!.id, status: 'open' }])
  expect(after[0]!.wakeId).toBeUndefined(); expect(f.ledger().conflictWakeable(f.s, after[0]!)).toBe(false)
})

it.each(['possible', 'clean'] as const)('a worker observes an opening while its launch facts are unreadable and still owes the wake after it turns %s', async next => {
  const room = new RoomDoc(), dir = fs.mkdtempSync(join(tmpdir(), "room-gap-"))
  const s = { room, dir, roomName: 'r', me: { name: 'A', kind: 'agent' } } as unknown as Session
  const ready = { available: true, workers: [], blockers: [], revision: 'r' } as never
  const ledger = new Ledger({ sessionId: () => 'session', route: () => ({}) }), slots = new ConflictSlots(room, '1')
  vi.stubEnv('ROOM_WORKER_ID', 'worker-A')
  try {
    room.participants.set('A\0holder', { sessionId: 'session', epoch: 1, workerId: 'worker-A' })
    ledger.supplyWorkers(s, ready); ledger.bind(s)
    ledger.supplyWorkers(s, { available: false, reason: 'unavailable', detail: 'temporary read failure' } as never)
    const fact = { owner: 'A', other: 'B', kind: 'merge' as const, path: 'x', inputs: 'i', factId: 'f' }
    await slots.settle(slotKey('A', 'merge', 'B', 'x'), { ...fact, status: 'conflict' })
    await slots.settle(slotKey('A', 'merge', 'B', 'x'), { ...fact, status: next })
    expect(ledger.candidates(s)).toEqual([])
    ledger.supplyWorkers(s, ready)
    const items = ledger.candidates(s).filter(isConflictItem)
    expect(items.filter(item => item.wakeId)).toHaveLength(1)
  } finally { vi.unstubAllEnvs(); ledger.unbind(s); room.doc.destroy(); fs.rmSync(dir, { recursive: true, force: true }) }
})
