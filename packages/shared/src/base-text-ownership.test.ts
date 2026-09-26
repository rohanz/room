import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc } from './doc.js'
import type { RetiredWorker } from './types.js'

function peers(): [RoomDoc, RoomDoc] {
  const a = new RoomDoc(), b = new RoomDoc()
  return [a, b]
}

function sync(a: RoomDoc, b: RoomDoc): void {
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc))
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc))
}

describe('participant-owned base texts', () => {
  it('keeps B’s text when A withdraws while B publishes', () => {
    const [a, b] = peers()
    a.setBaseOf('A', 'sha')
    a.setOverlay('A', 'file.py', 'A edit')
    a.setBaseText('A', 'sha', 'file.py', 'base')
    sync(a, b)

    a.clearOverlay('A', 'file.py')
    a.reconcileBaseTexts('A')
    b.setBaseOf('B', 'sha')
    b.setOverlay('B', 'file.py', 'B edit')
    b.setBaseText('B', 'sha', 'file.py', 'base')
    b.reconcileBaseTexts('B')
    sync(a, b)

    for (const room of [a, b]) {
      expect(room.baseText('A', 'sha', 'file.py')).toBeUndefined()
      expect(room.baseText('B', 'sha', 'file.py')).toBe('base')
    }
  })

  it('collects both owners after concurrent withdrawals', () => {
    const [a, b] = peers()
    for (const [room, person] of [[a, 'A'], [b, 'B']] as const) {
      room.setBaseOf(person, 'sha')
      room.setOverlay(person, 'file.py', `${person} edit`)
      room.setBaseText(person, 'sha', 'file.py', 'base')
    }
    sync(a, b)
    a.clearOverlay('A', 'file.py')
    a.reconcileBaseTexts('A')
    b.clearOverlay('B', 'file.py')
    b.reconcileBaseTexts('B')
    sync(a, b)
    for (const room of [a, b]) {
      expect(room.baseText('A', 'sha', 'file.py')).toBeUndefined()
      expect(room.baseText('B', 'sha', 'file.py')).toBeUndefined()
      expect(room.ownedBaseTexts.size).toBe(0)
    }
  })

  it('narrowing and restart remove only the local participant’s entries', () => {
    const [a, b] = peers()
    for (const [room, person] of [[a, 'A'], [b, 'B']] as const) {
      room.setBaseOf(person, 'sha')
      room.setOverlay(person, 'file.py', `${person} edit`)
      room.setBaseText(person, 'sha', 'file.py', 'base')
    }
    sync(a, b)
    a.clearOverlay('A', 'file.py')
    a.reconcileBaseTexts('A')
    sync(a, b)
    expect(b.baseText('A', 'sha', 'file.py')).toBeUndefined()
    expect(b.baseText('B', 'sha', 'file.py')).toBe('base')

    // Simulate a process stopping after removing an overlay but before its sweep.
    a.setOverlay('A', 'stale.py', 'edit')
    a.setBaseText('A', 'sha', 'stale.py', 'stale base')
    sync(a, b)
    a.clearOverlay('A', 'stale.py')
    sync(a, b)
    const restarted = new RoomDoc()
    Y.applyUpdate(restarted.doc, Y.encodeStateAsUpdate(b.doc))
    restarted.reconcileBaseTexts('A')
    expect(restarted.baseText('A', 'sha', 'file.py')).toBeUndefined()
    expect(restarted.baseText('A', 'sha', 'stale.py')).toBeUndefined()
    expect(restarted.baseText('B', 'sha', 'file.py')).toBe('base')
  })

  it('reads each participant’s own base and falls back to legacy text', () => {
    const room = new RoomDoc()
    room.setBaseText('A', 'sha', 'file.py', 'A base')
    room.setBaseText('B', 'sha', 'file.py', 'B base')
    expect(room.baseText('A', 'sha', 'file.py')).toBe('A base')
    expect(room.baseText('B', 'sha', 'file.py')).toBe('B base')
    const oldOwned = new Y.Map<string>()
    room.doc.getMap<Y.Map<string>>('basetextByPerson').set('Pre-flat', oldOwned)
    oldOwned.set('sha:past.py', 'pre-flat base')
    expect(room.baseText('Pre-flat', 'sha', 'past.py')).toBe('pre-flat base')
    room.setBaseOf('Legacy', 'sha')
    room.setOverlay('Legacy', 'old.py', 'edit')
    room.baseTexts.set('sha:old.py', 'legacy base')
    expect(room.baseText('Legacy', 'sha', 'old.py')).toBe('legacy base')
    room.clearOverlay('Legacy', 'old.py')
    room.reconcileBaseTexts('Legacy')
    expect(room.baseTexts.get('sha:old.py')).toBe('legacy base')
  })

  it('does not delete a legacy entry when concurrent new clients withdraw their overlays', () => {
    const [a, b] = peers()
    a.baseTexts.set('sha:file.py', 'legacy base')
    for (const person of ['A', 'B']) {
      a.setBaseOf(person, 'sha')
      a.setOverlay(person, 'file.py', `${person} edit`)
    }
    sync(a, b)
    a.clearOverlay('A', 'file.py')
    b.clearOverlay('B', 'file.py')
    sync(a, b)
    expect(a.baseTexts.get('sha:file.py')).toBe('legacy base')
    expect(b.baseTexts.get('sha:file.py')).toBe('legacy base')
    expect(a.baseText('Older client', 'sha', 'file.py')).toBe('legacy base')
  })

  it('merges first-use base texts from two sessions with the same tag', () => {
    const [a, b] = peers()
    a.setBaseText('Same', 'sha', 'one.py', 'one')
    b.setBaseText('Same', 'sha', 'two.py', 'two')
    sync(a, b)
    for (const room of [a, b]) {
      expect(room.ownedBaseTexts.get('Same\u0000sha:one.py')).toBe('one')
      expect(room.ownedBaseTexts.get('Same\u0000sha:two.py')).toBe('two')
      expect(room.baseText('Same', 'sha', 'one.py')).toBe('one')
      expect(room.baseText('Same', 'sha', 'two.py')).toBe('two')
    }
  })

  it('evicts a departed participant’s base texts with their overlays', () => {
    const [a, b] = peers()
    a.setOverlay('Gone', 'file.py', 'edit')
    a.setBaseText('Gone', 'sha', 'file.py', 'base')
    sync(a, b)
    b.clearOverlays('Gone')
    sync(a, b)
    for (const room of [a, b]) {
      expect(room.changedPaths('Gone')).toEqual([])
      expect(room.baseText('Gone', 'sha', 'file.py')).toBeUndefined()
      expect(room.ownedBaseTexts.size).toBe(0)
    }
  })

  it('leaves no orphaned base texts through repeated worker retirements', () => {
    const [a, b] = peers()
    for (let i = 0; i < 3; i++) {
      const name = `Lead+worker${i}`
      a.setOverlay(name, 'file.py', `edit ${i}`)
      a.setBaseText(name, 'sha', 'file.py', 'base')
      sync(a, b)
      const record: RetiredWorker = {
        name, tag: `worker${i}`, lead: 'Lead', host: 'codex', task: 'task', summary: '',
        files: ['file.py'], fileCount: 1, startedAt: i, finishedAt: i + 1,
        retiredAt: i + 2, outcome: 'clean',
      }
      b.retireParticipant(name, record)
      sync(a, b)
      for (const room of [a, b]) {
        expect(room.baseText(name, 'sha', 'file.py')).toBeUndefined()
        expect(room.ownedBaseTexts.size).toBe(0)
      }
    }
  })
})
