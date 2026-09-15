import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  RoomDoc,
  claimsOverlap,
  clampRange,
  colorFor,
  defaultPriority,
  displayName,
  formatMsg,
  type QuestionMsg,
} from './index.js'

describe('identity', () => {
  it('colour is deterministic and shared between a person and their agent', () => {
    expect(colorFor('Rohan')).toBe(colorFor('Rohan'))
    expect(colorFor('Rohan')).not.toBe(colorFor('Kieran'))
  })

  it('names agents after their owner', () => {
    expect(displayName({ name: 'Kieran', kind: 'agent' })).toBe("Kieran's agent")
    expect(displayName({ name: 'Kieran', kind: 'human' })).toBe('Kieran')
  })

  it('assigns distinct join-order colours, retains them, and repairs concurrent collisions', () => {
    const room = new RoomDoc()
    expect(['Ann', 'Bob', 'Cy'].map(name => room.assignColor(name))).toEqual([0, 1, 2])
    expect(room.assignColor('Bob')).toBe(1)

    const aDoc = new Y.Doc(), bDoc = new Y.Doc()
    const a = new RoomDoc(aDoc), b = new RoomDoc(bDoc)
    a.colors.set('Ann', 0); b.colors.set('Bob', 0)
    const updateA = Y.encodeStateAsUpdate(aDoc), updateB = Y.encodeStateAsUpdate(bDoc)
    Y.applyUpdate(aDoc, updateB); Y.applyUpdate(bDoc, updateA)
    expect([...a.colors.entries()].sort()).toEqual([['Ann', 0], ['Bob', 1]])
    expect([...b.colors.entries()].sort()).toEqual([['Ann', 0], ['Bob', 1]])
    expect(colorFor('Ann', a)).not.toBe(colorFor('Bob', a))
  })
})

describe('claims', () => {
  it('overlap is inclusive and path-scoped', () => {
    const a = { path: 'a.py', from: 13, to: 15 }
    expect(claimsOverlap(a, { path: 'a.py', from: 15, to: 20 })).toBe(true)
    expect(claimsOverlap(a, { path: 'a.py', from: 16, to: 20 })).toBe(false)
    expect(claimsOverlap(a, { path: 'b.py', from: 13, to: 15 })).toBe(false)
  })

  it('clamps to file length', () => {
    expect(clampRange(0, 999, 10)).toEqual({ from: 1, to: 10 })
    expect(clampRange(5, 3, 10)).toEqual({ from: 5, to: 5 })
  })
})

describe('RoomDoc overlays', () => {
  it('round-trips sparse overlays, deletions, scopes, bus and meta', () => {
    const a = new RoomDoc(), b = new RoomDoc()
    a.doc.on('update', (u: Uint8Array) => Y.applyUpdate(b.doc, u))
    b.doc.on('update', (u: Uint8Array) => Y.applyUpdate(a.doc, u))

    a.setOverlay('Rohan', 'api/handlers.py', 'def f():\n    pass\n')
    b.setOverlay('Kieran', 'tests/test_handlers.py', 'def test_f():\n    pass\n')
    a.markDeleted('Rohan', 'old.py')
    expect(b.text('api/handlers.py', 'Rohan')).toBe('def f():\n    pass\n')
    expect(a.text('tests/test_handlers.py', 'Kieran')).toBe('def test_f():\n    pass\n')
    expect(b.changedPaths('Rohan')).toEqual(['api/handlers.py', 'old.py'])
    expect(a.whoChanged('api/handlers.py')).toEqual(['Rohan'])

    a.setScope('Rohan', { byKind: 'agent', area: 'api', summary: 'refactor handlers', paths: ['api/handlers.py'] })
    expect(b.scope('Rohan')).toMatchObject({ by: 'Rohan', byKind: 'agent', summary: 'refactor handlers' })
    b.clearScope('Rohan')
    expect(a.scope('Rohan')).toBeUndefined()
    b.setScope({ by: 'Kieran', byKind: 'human', area: 'tests', summary: 'write tests', paths: ['tests/'] })
    expect(a.scope('Kieran')).toMatchObject({ summary: 'write tests', at: expect.any(Number) })

    b.post<QuestionMsg>({ name: 'Kieran', kind: 'agent' }, { type: 'question', to: 'Rohan', text: 'changing payload?' })
    expect(a.lastMessages(1)[0]).toMatchObject({ type: 'question', priority: 'notify', from: 'Kieran' })
    expect(formatMsg(a.lastMessages(1)[0])).toBe("[notify] Kieran's agent → Rohan's agent asks: changing payload?")

    a.setMeta({ base: 'abc123', branch: 'main' })
    expect(b.meta.base).toBe('abc123')
  })

  it('applies a minimal text diff so anchored claim ranges follow inserted lines', () => {
    const room = new RoomDoc()
    room.setOverlay('Rohan', 'app.py', 'line 1\nline 2\nline 3\n')
    const ytext = room.overlayText('Rohan', 'app.py')
    const claim = room.addClaim({
      path: 'app.py', from: 2, to: 3, by: 'Rohan', byKind: 'agent', intent: 'edit tail',
    })

    room.setOverlay('Rohan', 'app.py', 'new heading\nline 1\nline 2\nline 3\n')

    expect(room.overlayText('Rohan', 'app.py')).toBe(ytext)
    expect(room.claimRange(claim)).toEqual({ from: 3, to: 4 })
    expect(room.openClaims()[0]).toMatchObject({ from: 3, to: 4 })
  })

  it('clears only the selected person overlay and tracks deletion markers separately', () => {
    const room = new RoomDoc()
    room.setOverlay('Rohan', 'app.py', 'mine\n')
    room.setOverlay('Kieran', 'app.py', 'theirs\n')
    room.markDeleted('Rohan', 'gone.py')

    room.clearOverlay('Rohan', 'app.py')
    expect(room.text('app.py', 'Rohan')).toBeUndefined()
    expect(room.text('app.py', 'Kieran')).toBe('theirs\n')
    expect(room.whoChanged('app.py')).toEqual(['Kieran'])
    expect(room.changedPaths('Rohan')).toEqual(['gone.py'])

    room.unmarkDeleted('Rohan', 'gone.py')
    expect(room.changedPaths('Rohan')).toEqual([])
  })

  it('merges chat messages created concurrently before the docs sync', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const a = new RoomDoc(docA)
    const b = new RoomDoc(docB)

    a.say('Rohan', { role: 'human', text: '/stop' })
    b.say('Rohan', { role: 'agent', text: 'working' })
    const updateA = Y.encodeStateAsUpdate(docA)
    const updateB = Y.encodeStateAsUpdate(docB)
    Y.applyUpdate(docA, updateB)
    Y.applyUpdate(docB, updateA)

    expect(a.chat('Rohan').toArray().map(i => i.text).sort()).toEqual(['/stop', 'working'])
    expect(b.chat('Rohan').toArray().map(i => i.text).sort()).toEqual(['/stop', 'working'])
  })

  it('setOverlay with identical content emits no update', () => {
    const room = new RoomDoc()
    room.setOverlay('Rohan', 'x', 'hi')
    let updates = 0
    room.doc.on('update', () => updates++)
    room.setOverlay('Rohan', 'x', 'hi')
    expect(updates).toBe(0)
  })
})

describe('message priorities', () => {
  it('uses the spec defaults', () => {
    expect(defaultPriority({ type: 'conflict' })).toBe('interrupt')
    expect(defaultPriority({ type: 'changed', symbols: ['parseOrder'] })).toBe('notify')
    expect(defaultPriority({ type: 'changed', paths: ['app.py'], summary: 'formatting' })).toBe('fyi')
    expect(defaultPriority({ type: 'question' })).toBe('notify')
    expect(defaultPriority({ type: 'answer' })).toBe('notify')
    expect(defaultPriority({ type: 'scope' })).toBe('notify')
    expect(defaultPriority({ type: 'release' })).toBe('fyi')
    expect(defaultPriority({ type: 'note' })).toBe('fyi')
    expect(defaultPriority({ type: 'claim' })).toBe('fyi')
  })
})

describe('chats', () => {
  it('keeps one chat per person and syncs it', () => {
    const a = new RoomDoc(), b = new RoomDoc()
    a.doc.on('update', (u: Uint8Array) => Y.applyUpdate(b.doc, u))
    b.doc.on('update', (u: Uint8Array) => Y.applyUpdate(a.doc, u))
    a.say('Rohan', { role: 'human', text: 'refactor validation' })
    b.say('Rohan', { role: 'agent', text: 'on it' })
    expect(a.chat('Rohan').toArray().map(i => i.role)).toEqual(['human', 'agent'])
    expect(b.chat('Kieran').length).toBe(0)
  })
})
