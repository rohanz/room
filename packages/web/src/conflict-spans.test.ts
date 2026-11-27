import { JSDOM } from 'jsdom'
import { gitMergeFile } from '../../room-mcp/src/merge.js'
import { classifyNWay } from './merged.ts'
import * as merged from './merged.ts'
import { publish } from './test-manifest.ts'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RoomDoc, formatConflictLine, openConflicts, type Claim, type ConflictKind, type ConflictSlot, type Msg } from '@room/shared'
import { currentConflicts } from './conflicts.ts'
import { timelineEntries, groupEpisodes } from './timeline.ts'
import { boardPanel } from './board.ts'
import { conflictCard, createFocusState, centrePanel, renderCodeLines, timelinePanel } from './panels.ts'
import type { Conn } from './conn.ts'
import { renderScheduler } from './scheduler.ts'

let dom: JSDOM
let room: RoomDoc
const claims: Claim[] = ['money', 'tiers'].map((by, i) => ({ id: 'c' + i, by, byKind: 'agent', path: 'a.ts', from: 2, to: 7, intent: 'update ' + by, at: 1 }))
const slot = (kind: ConflictKind, changes: Partial<ConflictSlot> = {}): ConflictSlot => ({
  kind, owner: 'money', other: 'tiers', path: kind + '.ts', subject: kind === 'claims' ? 'c0\0c1' : kind === 'edit-in-claim' ? 'c1' : kind === 'contract' ? 'f' : undefined,
  status: 'conflict', settled: 'conflict', inputs: 'inputs', factId: 'fact', fence: 'fence', checkedAt: 10, confirmedAt: 10, evaluatedRanges: [{ from: 2, to: 7 }], lines: [2, 7], ...changes,
  openId: changes.openId ?? 'opening', endpoints: changes.endpoints ?? [{ name: changes.owner ?? 'money' }, { name: changes.other ?? 'tiers' }],
})
const map = () => room.doc.getMap<ConflictSlot>('conflicts')
const conn = () => ({ room, provider: { awareness: { getStates: () => new Map(), on: vi.fn() } } }) as unknown as Conn

beforeEach(() => {
  room = new RoomDoc()
  dom = new JSDOM('<body></body>')
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} })
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  for (const claim of claims) room.claims.set(claim.id, claim)
})
afterEach(() => { room.doc.destroy(); renderScheduler.flushNow(); dom.window.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each(['merge', 'edit-in-claim', 'claims', 'contract'] as const)('shows and clears a %s conflict from state alone in file-level cards', kind => {
  map().set('state', slot(kind))
  expect(room.messages()).toEqual([])
  const entries = currentConflicts(room)
  expect(entries).toHaveLength(1)
  const conflict = entries[0]
  const text = formatConflictLine(conflict)
  expect(conflictCard(conflict).textContent).toContain(text)
  const timeline = timelinePanel(conn(), createFocusState())
  const board = boardPanel(conn(), vi.fn())
  expect(timeline.querySelector('.conflict-card')?.textContent).toContain(text)
  expect(board.querySelector('.conflict-card')?.textContent).toContain(text)
  map().set('state', slot(kind, { status: 'clean', settled: 'clean' }))
  expect(timelineEntries(room)).toEqual([])
  renderScheduler.flushNow()
  expect(timeline.querySelector('.conflict-card')).toBeNull()
  expect(board.querySelector('.conflict-card')).toBeNull()
})

it('ignores old conflict messages even when they are malformed or their old claims still overlap', () => {
  const old = ['merge-conflict', 'conflict', 'contract'].map((type, i) => ({ type, id: 'old' + i, from: 'room', priority: 'notify', at: i, text: 'old conflict' }))
  room.bus.push(old as unknown as Msg[])
  expect(currentConflicts(room)).toEqual([])
  expect(timelineEntries(room)).toEqual([])
  expect(groupEpisodes(old as unknown as Msg[])).toEqual([])
  expect(boardPanel(conn(), vi.fn()).textContent).not.toContain('old conflict')
  expect(timelinePanel(conn(), createFocusState()).textContent).not.toContain('old conflict')
})

it('does not infer an open conflict from overlapping claims alone', () => {
  expect(currentConflicts(room)).toEqual([])
  expect(timelineEntries(room)).toEqual([])
})

it('observes a completed pair publication without showing its intermediate empty or mixed state', () => {
  map().set('a', slot('merge', { path: 'a.ts' }))
  const openPaths = () => currentConflicts(room).flatMap(c => c.slots.map(s => s.path))
  expect(openPaths()).toEqual(['a.ts'])
  const snapshots: string[][] = []
  map().observe(() => snapshots.push(openPaths()))
  room.doc.transact(() => {
    map().delete('a')
    map().set('b', slot('merge', { path: 'b.ts' }))
    map().set('c', slot('merge', { path: 'c.ts' }))
  })
  expect(snapshots).toEqual([['b.ts', 'c.ts']])
})

it('keeps merge-preview text annotations independent of recorded state', () => {
  const host = document.createElement('div')
  renderCodeLines(host, [{ text: 'competing change', side: 'a', changedBy: 'a', conflict: true, aLine: 2 }], ['money', 'tiers'])
  expect(host.querySelector('.conflict-tag')?.textContent).toBe('conflict')
  expect(host.querySelector('.resolved')).toBeNull()
})

it('uses the original owner perspective in file-level cards regardless of recipient sort order', () => {
  map().set('edit', slot('edit-in-claim', { owner: 'z-editor', other: 'a-holder' }))
  const expected = formatConflictLine(openConflicts(room, 'z-editor')[0])
  expect(conflictCard(currentConflicts(room)[0]).textContent).toContain(expected)
})

it('shows last confirmed evidence without treating an unavailable diagnostic recheck as fresh confirmation', () => {
  const confirmedAt = Date.UTC(2026, 10, 25, 1, 2, 3)
  const checkedAt = Date.UTC(2026, 10, 25, 4, 5, 6)
  map().set('state', slot('claims', { confirmedAt, checkedAt, status: 'unknown' }))
  const card = conflictCard(currentConflicts(room)[0])
  expect(card.textContent).toContain('Last confirmed 2026-11-25 01:02:03 UTC')
  expect(card.textContent).toContain('recheck unavailable')
  expect(card.textContent).not.toContain('04:05:06')
  map().set('state', slot('claims', { confirmedAt: undefined, checkedAt, status: 'unknown' }))
  const legacy = conflictCard(currentConflicts(room)[0])
  expect(legacy.textContent).toContain('Confirmation time unavailable')
  expect(legacy.textContent).not.toContain('Last confirmed')
})

it('keeps current conflicts outside chronological speech, stable across rechecks, priority filters and message windows', () => {
  room.bus.push([{ id: 'scope', type: 'scope', priority: 'notify', from: 'money', fromKind: 'agent', at: 1, area: 'api', summary: 'ordinary work', paths: ['a.ts'] }])
  for (let i = 0; i < 40; i++) room.bus.push([{ id: 'n' + i, type: 'note', priority: 'notify', from: 'money', fromKind: 'agent', at: 2 + i, text: 'speech ' + i }])
  map().set('first', slot('merge', { other: 'a-peer', confirmedAt: 2, checkedAt: 2 }))
  map().set('second', slot('merge', { other: 'z-peer', confirmedAt: 1, checkedAt: 1 }))
  const timeline = timelinePanel(conn(), createFocusState())
  const board = boardPanel(conn(), vi.fn())
  const order = (panel: HTMLElement) => [...panel.querySelectorAll('.open-conflicts .conflict-card strong')].map(node => node.textContent)
  const speech = timeline.querySelector('.timeline-list')!.textContent
  const feed = board.querySelector('.board-feed')!.textContent
  expect(order(timeline)).toEqual(['money ↔ a-peer', 'money ↔ z-peer'])
  expect(order(board)).toEqual(order(timeline))
  expect(timeline.querySelector('.timeline-list .conflict-card')).toBeNull()
  expect(board.querySelector('.board-feed .conflict-card')).toBeNull()
  expect(timelineEntries(room)).toHaveLength(41)
  map().set('first', slot('merge', { other: 'a-peer', confirmedAt: 2, checkedAt: 999999, status: 'unknown' }))
  renderScheduler.flushNow()
  expect(order(timeline)).toEqual(['money ↔ a-peer', 'money ↔ z-peer'])
  expect(order(board)).toEqual(order(timeline))
  expect(timeline.querySelector('.timeline-list')!.textContent).toBe(speech)
  expect(board.querySelector('.board-feed')!.textContent).toBe(feed)
  timeline.querySelector<HTMLButtonElement>('.priority-filter-chip.priority-notify')!.click()
  expect(order(timeline)).toEqual(['money ↔ a-peer', 'money ↔ z-peer'])
})

it('does not mark unrelated source lines using merge-result conflict positions after an insertion', async () => {
  const base = Array.from({ length: 20 }, (_, i) => 'base ' + (i + 1) + '\n').join('')
  const ours = 'inserted\n' + base.replace('base 15\n', 'A15\n')
  const theirs = base.replace('base 15\n', 'B15\n')
  const result = await gitMergeFile(base, ours, theirs, { ours: 'money', base: 'base', theirs: 'tiers' })
  expect(result.conflicts.length).toBeGreaterThan(0)
  map().set('merge', slot('merge', { path: 'x', lines: result.conflicts.map(c => c.from), evaluatedRanges: undefined }))
  const mergedLines = classifyNWay(base, [{ name: 'money', text: ours }, { name: 'tiers', text: theirs }])
  const host = document.createElement('div')
  renderCodeLines(host, mergedLines, ['money', 'tiers'])
  const marked = [...host.querySelectorAll('.code-line')].flatMap((node, i) => node.classList.contains('conflict-line') ? [mergedLines[i].text] : [])
  expect(marked).toEqual(['A15', 'B15'])
  expect(marked).not.toContain('base 16')
  expect(currentConflicts(room)).toHaveLength(1)
  expect(conflictCard(currentConflicts(room)[0]).textContent).toContain('x conflicts with')
})

it('never maps A100 conflict state onto unrelated A190/B100 source rows', async () => {
  publish(room, 'A', 'x.ts', 'owner version\n', 'base\n')
  publish(room, 'B', 'x.ts', 'holder version\n', 'base\n')
  room.claims.set('b-claim', { id: 'b-claim', by: 'B', byKind: 'agent', path: 'x.ts', from: 10, to: 10, intent: 'edit', at: 1 })
  map().set('claim-coordinate', slot('edit-in-claim', {
    owner: 'A', other: 'B', path: 'x.ts', subject: 'b-claim',
    lines: [100], evaluatedRanges: undefined, claimRanges: [{ from: 10, to: 10 }], merges: 'clean',
  }))
  // A inserted ninety lines above B:10. B:100 belongs to an unrelated later row.
  vi.spyOn(merged, 'classifyNWay').mockReturnValue([
    { text: 'evaluated overlap', side: 'common', changedBy: [], conflict: false, lineNumbers: { A: 100, B: 10 } },
    { text: 'unrelated later line', side: 'common', changedBy: [], conflict: false, lineNumbers: { A: 190, B: 100 } },
  ])
  const pane = centrePanel(conn(), createFocusState())
  await vi.waitFor(() => expect(pane.querySelectorAll('.code-line')).toHaveLength(2))
  const unrelated = [...pane.querySelectorAll('.code-line')].find(row => row.querySelector('code')?.textContent === 'unrelated later line')!
  expect(unrelated).toBeDefined()
  expect(unrelated.classList.contains('claim-overlap-line')).toBe(false)
  expect(pane.querySelector('.conflict-bar')).toBeNull()
  expect(currentConflicts(room)).toHaveLength(1)
  const card = conflictCard(currentConflicts(room)[0])
  expect(card.textContent).toContain("Evaluated lines in A's x.ts: 100")
  expect(card.textContent).toContain("Evaluated claim lines in B's x.ts: 10")
})
