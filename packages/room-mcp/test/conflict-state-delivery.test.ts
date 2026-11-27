import { selectWithin, INBOX_BUDGET } from '../src/inbox-budget.js'
import * as Y from 'yjs'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomDoc, openConflicts, memorySnapshot, type ConflictKind } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { ConflictSlots, slotKey, type Evaluation } from '../src/conflict-set.js'
import { Ledger, formatDeliveryItem, isConflictItem } from '../src/ledger.js'
import { WakeReconciler, type WakeReconcilerOptions } from '../src/wake-reconciler.js'
import type { Session } from '../src/session.js'
const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.splice(0)) close() })
function fixture(options: Partial<WakeReconcilerOptions> = {}, workerIdentity = false) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'room-conflict-state-')), room = new RoomDoc()
  const s = { room, dir, roomName: 'r', me: { name: 'A', kind: 'agent' }, awareness: { setLocalStateField() {} } } as unknown as Session
  const slots = new ConflictSlots(room, '1', Date.now, () => true, workerIdentity ? names => names.map(name => {
    const holder = room.participants.get(name + '\0holder') as { workerId?: string } | undefined
    return { name, ...(holder?.workerId ? { workerId: holder.workerId } : {}) }
  }) : undefined)
  const makeLedger = () => new Ledger({ sessionId: () => 'session', sessionDir: () => dir, route: () => ({}) })
  let ledger = makeLedger(), wakes: WakeReconciler
  const send = vi.fn(async () => 'socket' as const)
  const start = () => { ledger.bind(s); wakes = new WakeReconciler({ ledger, bound: () => ({ host: 'claude', id: 'session' }), sessionDir: () => dir, send, windowMs: 0, ...options }); wakes.attach(s) }
  start()
  const settle = async (kind: ConflictKind, status: Evaluation['status'] = 'conflict', extra: Partial<Evaluation> = {}) => {
    const result: Evaluation = { kind, owner: 'A', other: 'B', path: 'x', subject: kind === 'merge' ? undefined : 'subject', status, inputs: Math.random().toString(), factId: 'fact', lines: [1], ...extra }
    await slots.settle(slotKey(result.owner, kind, result.other, result.path, result.subject), result)
  }
  const read = () => { const batch = ledger.open('reply'), items = ledger.select(s, batch); ledger.commit(batch); return items }
  cleanups.push(() => { wakes.stop(); room.doc.destroy(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { room, s, slots, send, settle, read, peerWorker(id: string) { room.participants.set('B\0holder', { sessionId: 'peer', epoch: 1, workerId: id }) }, ledger: () => ledger, restart() { wakes.stop(); ledger.unbind(s); ledger = makeLedger(); start() } }
}
for (const kind of ['merge', 'edit-in-claim', 'claims', 'contract'] as const) describe(kind, () => {
  it('wakes once through updates and restart; shows current lines; clears quietly and wakes after reopen', async () => {
    const f = fixture()
    await f.settle(kind)
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1))
    await f.settle(kind, 'conflict', { lines: [8], why: 'latest' })
    f.restart()
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(f.send).toHaveBeenCalledTimes(1)
    const first = f.read()
    expect(first).toHaveLength(1)
    expect(formatDeliveryItem(first[0]!)).toContain(kind === 'merge' ? 'lines 8' : kind === 'claims' ? 'overlapping claims' : 'latest')
    expect(f.room.messages()).toEqual([])
    expect(f.room.seen('A').size).toBe(0)
    f.restart(); expect(f.read()).toEqual([])
    await f.settle(kind, 'clean')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.read()).toMatchObject([{ type: 'conflict-state', status: 'inactive', priority: 'fyi', label: expect.stringContaining('x') }])
    expect(f.read()).toEqual([]); expect(f.send).toHaveBeenCalledTimes(1)
    await f.settle(kind)
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2))
    expect(f.read()[0]!.id).not.toBe(first[0]!.id)
  })
  it('shows possibilities and clean overlaps without a wake', async () => {
    const f = fixture()
    await f.settle(kind, 'possible')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.send).not.toHaveBeenCalled()
    expect(formatDeliveryItem(f.read()[0]!)).toContain('POSSIBLE')
    await f.settle(kind, 'clean'); f.read()
    await f.settle(kind, 'conflict', { merges: 'clean' })
    expect(formatDeliveryItem(f.read()[0]!)).toContain('merges cleanly')
    expect(f.send).not.toHaveBeenCalled()
  })
})
it('keeps one merge entry as files join and move atomically', async () => {
  const f = fixture(); await f.settle('merge')
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  const original = openConflicts(f.room, 'A')[0]!.id
  const result = (path: string, status: Evaluation['status']): Evaluation => ({ owner: 'A', other: 'B', kind: 'merge', path, status, inputs: path, factId: path, lines: [9] })
  await f.slots.settlePair('A', 'B', new Map([result('x', 'clean'), result('y', 'conflict')].map(value => [slotKey('A', 'merge', 'B', value.path), value])))
  expect(openConflicts(f.room, 'A')).toHaveLength(1)
  expect(openConflicts(f.room, 'A')[0]!.id).toBe(original)
  expect(formatDeliveryItem(f.read()[0]!)).toContain('y conflicts'); expect(f.send).toHaveBeenCalledOnce()
})
it('retries failed handoffs and receipts only the selected presentation', async () => {
  const f = fixture(); await f.settle('merge')
  const batch = f.ledger().open('hook'), old = f.ledger().select(f.s, batch)[0]!
  f.ledger().discard(batch)
  await f.settle('merge', 'conflict', { lines: [33] })
  const current = f.read()[0]!
  expect(current.id).toBe(old.id); expect(formatDeliveryItem(current)).toContain('lines 33')
})
it('shows an owed unshown closed alert and wakes conservatively with unreadable receipts', async () => {
  const f = fixture(); await f.settle('merge')
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  await f.settle('merge', 'clean'); expect(f.read()).toMatchObject([{ status: 'inactive', priority: 'notify' }])
  await f.settle('merge'); await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2))
  fs.writeFileSync(join(f.s.dir, 'conflicts.json'), '{broken')
  f.restart(); await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(3))
})
it('ignores legacy conflict messages and preserves ordinary message delivery', async () => {
  const f = fixture()
  hubAppend(f.room, { name: 'room', kind: 'agent' }, { type: 'merge-conflict', path: 'old', to: 'A', text: 'old conflict' })
  hubAppend(f.room, { name: 'B', kind: 'agent' }, { type: 'note', to: 'A', text: 'ordinary' })
  expect(f.read()).toMatchObject([{ type: 'note', text: 'ordinary' }])
})
it('bounds receipts: live openings, pending clears and at most 64 delivered wakes for departed openings', async () => {
  const f = fixture()
  for (let n = 0; n < 80; n++) { await f.settle('merge'); f.read(); await f.settle('merge', 'clean'); f.read() }
  const saved = JSON.parse(fs.readFileSync(join(f.s.dir, 'conflicts.json'), 'utf8')).r
  expect(saved.entries).toEqual({})
  expect(Object.values(saved.delivered)).toHaveLength(64)
  expect(Object.values(saved.delivered).every(at => Number.isFinite(at))).toBe(true)
})
it('groups possible merge paths and exact upgrade opens one new episode', async () => {
  const f = fixture()
  await f.settle('merge', 'possible')
  const possible = openConflicts(f.room, 'A')[0]!.id
  await f.settle('merge', 'possible', { path: 'y' })
  expect(openConflicts(f.room, 'A')).toMatchObject([{ id: possible, slots: [{ path: 'x' }, { path: 'y' }] }])
  f.read()
  await f.settle('merge')
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  expect(openConflicts(f.room, 'A').some(entry => entry.id !== possible && entry.priority === 'notify')).toBe(true)
})
it('wakes when a shown clean overlap becomes an exact conflict, then keeps its identity through line updates', async () => {
  const f = fixture()
  await f.settle('edit-in-claim', 'conflict', { merges: 'clean' }); f.read()
  await f.settle('edit-in-claim')
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  const entry = openConflicts(f.room, 'A')[0]!.id
  await f.settle('edit-in-claim', 'conflict', { lines: [8] })
  expect(openConflicts(f.room, 'A')[0]!.id).toBe(entry)
  expect(f.send).toHaveBeenCalledOnce()
})
it('does not rescan conflict storage for unrelated edits or another participant updates', async () => {
  const f = fixture()
  await f.settle('merge')
  const first = openConflicts(f.room, 'A'), map = f.room.doc.getMap('conflicts')
  const entries = vi.spyOn(map, 'entries'), values = vi.spyOn(map, 'values')
  f.room.metaMap.set('unrelated', 1)
  expect(openConflicts(f.room, 'A')).toBe(first)
  await f.settle('merge', 'conflict', { owner: 'C', other: 'D' })
  entries.mockClear(); values.mockClear()
  expect(openConflicts(f.room, 'A')).toBe(first)
  expect(entries).not.toHaveBeenCalled(); expect(values).not.toHaveBeenCalled()
})
it('keeps the same opening when an edit-in-claim representative is renewed or replaced', async () => {
  const f = fixture(); await f.settle('edit-in-claim')
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  const before = openConflicts(f.room, 'A')[0]!.id
  const map = f.room.doc.getMap<import('@room/shared').ConflictSlot>('conflicts')
  const key = [...map.keys()][0]!, slot = map.get(key)!
  map.set(key, { ...slot, subject: 'replacement', why: 'current representative' })
  expect(openConflicts(f.room, 'A')[0]!.id).toBe(before)
  f.restart(); await new Promise(resolve => setTimeout(resolve, 10))
  expect(f.send).toHaveBeenCalledOnce()
})
it('uses evaluated claim ranges even when a claim moves before the next evaluation', async () => {
  const f = fixture()
  f.room.claims.set('subject', { id: 'subject', by: 'B', byKind: 'agent', path: 'x', from: 10, to: 20, intent: 'edit', at: 1 })
  await f.settle('edit-in-claim', 'conflict', { lines: [10] })
  f.room.claims.set('subject', { ...f.room.claims.get('subject')!, from: 500, to: 510 })
  const line = openConflicts(f.room, 'A')[0]!.text
  expect(line).toContain('10-20'); expect(line).not.toContain('500-510')
})
it.each([false, true])('a confirmed turn wakes once; an uncertain turn keeps the idle fallback (uncertain=%s)', async uncertain => {
  let active = true
  const midTurn = vi.fn(async () => uncertain ? 'uncertain-turn' as const : 'turn' as const)
  const f = fixture({ bound: () => ({ host: 'codex', id: 'session' }), turnProbe: { busy: async () => active }, midTurn, busyPollMs: 10 })
  await f.settle('merge')
  await vi.waitFor(() => expect(midTurn).toHaveBeenCalledOnce())
  active = false
  f.restart()
  if (uncertain) await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  else { await new Promise(resolve => setTimeout(resolve, 20)); expect(f.send).not.toHaveBeenCalled() }
  expect(midTurn).toHaveBeenCalledOnce()
})
it.each([
  { survivor: true, behavior: 'preserves the opening and receipt without a second wake' },
  { survivor: false, behavior: 'creates a new opening and wakes exactly once more' },
])('local snapshot recovery $behavior', async ({ survivor }) => {
  const f = fixture(); await f.settle('merge')
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  const before = openConflicts(f.room, 'A')[0]!.id
  expect(f.read().map(item => item.id)).toContain(before)
  const restored = new RoomDoc()
  const ledger = new Ledger({ sessionId: () => 'session', sessionDir: () => f.s.dir, route: () => ({}) })
  const s = { ...f.s, room: restored }
  let wakes: WakeReconciler | undefined
  try {
    Y.applyUpdate(restored.doc, memorySnapshot(f.room.doc))
    expect(openConflicts(restored, 'A')).toEqual([])
    if (survivor) Y.applyUpdate(restored.doc, Y.encodeStateAsUpdate(f.room.doc))
    const slots = new ConflictSlots(restored, '2')
    const recheck = (line: number) => slots.settle(slotKey('A', 'merge', 'B', 'x'), {
      owner: 'A', other: 'B', kind: 'merge', path: 'x', status: 'conflict', inputs: `restarted-${line}`, factId: 'fact', lines: [line],
    })
    await recheck(2)
    const current = openConflicts(restored, 'A')[0]!
    if (survivor) expect(current.id).toBe(before)
    else expect(current.id).not.toBe(before)
    ledger.bind(s)
    const item = ledger.candidates(s).filter(isConflictItem).find(item => item.id === current.id)!
    expect(ledger.conflictWakeable(s, item)).toBe(!survivor)
    if (survivor) expect(ledger.conflictWakeRecorded(s, before)).toBe(true)
    wakes = new WakeReconciler({ ledger, bound: () => ({ host: 'claude', id: 'session' }),
      sessionDir: () => f.s.dir, send: f.send, windowMs: 0 })
    wakes.attach(s)
    if (!survivor) await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2))
    await recheck(3); wakes.reconcile()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(openConflicts(restored, 'A')[0]!.id).toBe(current.id)
    expect(f.send).toHaveBeenCalledTimes(survivor ? 1 : 2)
    expect(ledger.conflictWakeRecorded(s, current.id)).toBe(true)
  } finally { wakes?.stop(); ledger.unbind(s); restored.doc.destroy() }
})
it.each(['merge', 'edit-in-claim', 'claims', 'contract'] as const)('%s transition matrix: quiet upgrade, uncertainty, unseen/shown reopen, successor', async kind => {
  const f = fixture({}, true); f.peerWorker('w1')
  await f.settle(kind, 'unknown'); expect(openConflicts(f.room, 'A')).toEqual([])
  await f.settle(kind, 'possible'); f.read()
  const confirmed = openConflicts(f.room, 'A')[0]!.slots[0]!.confirmedAt
  await f.settle(kind, 'unknown')
  expect(openConflicts(f.room, 'A')[0]!.slots[0]!.confirmedAt).toBe(confirmed)
  expect(formatDeliveryItem(f.ledger().candidates(f.s)[0]!)).toContain('recheck unavailable')
  await f.settle(kind); await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1))
  const first = openConflicts(f.room, 'A')[0]!.id
  await f.settle(kind, 'clean'); await f.settle(kind)
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2))
  expect(openConflicts(f.room, 'A')[0]!.id).not.toBe(first)
  // The shown possibility has a courtesy; the unshown confirmed opening remains owed too.
  const closed = f.read().filter(item => isConflictItem(item) && item.status === 'inactive')
  expect(closed).toHaveLength(2)
  expect(closed.filter(item => item.priority !== 'fyi')).toHaveLength(1)
  await f.settle(kind, 'clean'); await new Promise(resolve => setTimeout(resolve, 10))
  expect(f.send).toHaveBeenCalledTimes(2)
  const inactive = f.read(); expect(inactive).toHaveLength(1)
  expect(formatDeliveryItem(inactive[0]!)).toContain('previous alert no longer active')
  expect(formatDeliveryItem(inactive[0]!)).not.toContain('merges cleanly')
  await f.settle(kind); await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(3)); f.read()
  const predecessor = openConflicts(f.room, 'A')[0]!.id
  f.peerWorker('w2'); await f.settle(kind)
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(4))
  expect(openConflicts(f.room, 'A')[0]!.id).not.toBe(predecessor)
})
it('scopes inactive labels and writes fingerprints once for a committed batch', async () => {
  const f = fixture(); await f.settle('merge'); await f.settle('contract')
  const batch = f.ledger().open('reply'); f.ledger().select(f.s, batch)
  const rename = vi.spyOn(fs, 'renameSync'); f.ledger().commit(batch)
  expect(rename.mock.calls.filter(([, target]) => String(target).endsWith('conflicts.json'))).toHaveLength(1); rename.mockRestore()
  const saved = JSON.parse(fs.readFileSync(join(f.s.dir, 'conflicts.json'), 'utf8')).r.entries
  for (const receipt of Object.values(saved) as { shown: string; label: string }[]) {
    expect(receipt.shown).toMatch(/^[a-f0-9]{64}$/); expect(receipt.label.length).toBeLessThanOrEqual(270)
  }
  await f.settle('contract', 'clean')
  const inactive = f.ledger().candidates(f.s).filter(item => isConflictItem(item) && item.status === 'inactive')
  expect(inactive).toHaveLength(1); expect(formatDeliveryItem(inactive[0]!)).toContain('contract x:subject')
  expect(openConflicts(f.room, 'A').some(entry => entry.kind === 'merge')).toBe(true)
})
it('stages the affected pair and drops closed slots instead of retaining history', async () => {
  const f = fixture()
  for (let n = 0; n < 200; n++) await f.settle('contract', 'conflict', { owner: 'owner' + n, other: 'peer' + n })
  const map = f.room.doc.getMap('conflicts'), entries = vi.spyOn(map, 'entries'), values = vi.spyOn(map, 'values')
  const iterate = vi.spyOn(map, Symbol.iterator)
  for (let n = 0; n < 100; n++) new ConflictSlots(f.room, '1')
  expect(iterate).not.toHaveBeenCalled()
  await f.settle('merge')
  await f.slots.settlePair('A', 'B', new Map([['pair', { owner: 'A', other: 'B', kind: 'merge', path: 'y', status: 'conflict', inputs: 'i', factId: 'f' }]]))
  expect(entries).not.toHaveBeenCalled(); expect(values).not.toHaveBeenCalled()
  await f.settle('merge', 'clean'); expect(f.slots.get(slotKey('A', 'merge', 'B', 'x'))).toBeUndefined()
})
it('compacts old detached-room receipts without evicting the current room', async () => {
  const f = fixture(); await f.settle('merge'); f.read()
  const file = join(f.s.dir, 'conflicts.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  saved.detached = { participant: 'A', delivered: {}, touchedAt: Date.now() - 8 * 86400_000, entries: { old: { shown: 'a'.repeat(64), label: 'old merge x with B' } } }
  saved.r.touchedAt = Date.now() - 8 * 86400_000
  fs.writeFileSync(file, JSON.stringify(saved)); f.restart()
  await f.settle('contract'); f.read()
  const current = JSON.parse(fs.readFileSync(file, 'utf8'))
  expect(current).not.toHaveProperty('detached'); expect(Object.keys(current.r.entries)).toHaveLength(2)
})
it.each(['missing', 'corrupt', 'wrong-shape'] as const)('repeats when only conflicts.json is %s, keeping wakes.json intact', async failure => {
  const f = fixture(); await f.settle('merge')
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  if (failure !== 'missing') f.read() // shown receipts must also lose their suppression when the file is lost
  const wakeFile = join(f.s.dir, 'wakes.json')
  // Simulate an older plugin's independent confirmed wake record surviving the upgrade.
  fs.writeFileSync(wakeFile, JSON.stringify({ r: { [openConflicts(f.room, 'A')[0]!.id]: { via: 'socket', at: Date.now() } } }))
  const before = fs.readFileSync(wakeFile, 'utf8')
  if (failure === 'missing') fs.rmSync(join(f.s.dir, 'conflicts.json'))
  else if (failure === 'wrong-shape') {
    const saved = JSON.parse(fs.readFileSync(join(f.s.dir, 'conflicts.json'), 'utf8'))
    saved.r.entries.invalid = { label: 'invalid', unsupported: true }
    fs.writeFileSync(join(f.s.dir, 'conflicts.json'), JSON.stringify(saved))
  }
  else fs.writeFileSync(join(f.s.dir, 'conflicts.json'), '{broken')
  expect(fs.readFileSync(wakeFile, 'utf8')).toBe(before)
  f.restart(); await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2), { timeout: 250 })
})
it.each(['missing', 'corrupt'] as const)('does not repeat when only wakes.json is %s and conflict delivery is confirmed', async failure => {
  const f = fixture(); await f.settle('merge')
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  if (failure === 'missing') fs.rmSync(join(f.s.dir, 'wakes.json'))
  else fs.writeFileSync(join(f.s.dir, 'wakes.json'), '{broken')
  f.restart(); await new Promise(resolve => setTimeout(resolve, 20))
  expect(f.send).toHaveBeenCalledOnce()
})
it('bounds courtesy receipts when forty cycles of notify content starve inactive alerts', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'room-conflict-budget-')), room = new RoomDoc(), slots = new ConflictSlots(room, '1')
  const session = { room, dir, roomName: 'r', me: { name: 'A', kind: 'agent' } } as Session
  const ledger = new Ledger({ sessionId: () => 'session', sessionDir: () => dir, route: () => ({}) }); ledger.bind(session)
  cleanups.push(() => { room.doc.destroy(); fs.rmSync(dir, { recursive: true, force: true }) })
  const f = { room, s: session, ledger: () => ledger, async settle(kind: ConflictKind, status: Evaluation['status'], extra: Partial<Evaluation>) {
    const result: Evaluation = { owner: 'A', other: 'B', kind, path: 'x', status, inputs: 'i', factId: 'f', ...extra }
    await slots.settle(slotKey('A', kind, 'B', 'x', result.subject), result)
  } }
  const subjects = Array.from({ length: 20 }, (_, n) => 'fn' + n)
  for (let turn = 0; turn < 40; turn++) {
    for (const subject of subjects) await f.settle('contract', 'conflict', { subject, why: 'signature changed: ' + 'parameter: string, '.repeat(23) })
    const batch = f.ledger().open('hook')
    selectWithin(f.ledger(), [f.s], batch, INBOX_BUDGET, c => formatDeliveryItem(c.m).length + 1)
    f.ledger().commit(batch)
    for (const subject of subjects) await f.settle('contract', 'clean', { subject })
    f.ledger().candidates(f.s); f.ledger().flushConflicts()
  }
  const saved = JSON.parse(fs.readFileSync(join(f.s.dir, 'conflicts.json'), 'utf8'))
  expect(openConflicts(f.room, 'A')).toHaveLength(0)
  expect(Object.keys(saved.r.entries).length).toBeLessThanOrEqual(8)
  expect(f.ledger().candidates(f.s).filter(item => isConflictItem(item) && item.status === 'inactive').length).toBeLessThanOrEqual(8)
})
