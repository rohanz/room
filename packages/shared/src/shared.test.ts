import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc, claimsOverlap, clampRange, colorFor, displayName, formatMsg, type QuestionMsg } from './index.js'

describe('identity', () => {
  it('colour is deterministic and shared between a person and their agent', () => {
    expect(colorFor('Rohan')).toBe(colorFor('Rohan'))
    expect(colorFor('Rohan')).not.toBe(colorFor('Kieran'))
  })
  it('names agents after their owner', () => {
    expect(displayName({ name: 'Kieran', kind: 'agent' })).toBe("Kieran's agent")
    expect(displayName({ name: 'Kieran', kind: 'human' })).toBe('Kieran')
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

describe('RoomDoc', () => {
  it('round-trips files, claims, bus and meta through two synced docs', () => {
    const a = new RoomDoc(), b = new RoomDoc()
    a.doc.on('update', (u: Uint8Array) => Y.applyUpdate(b.doc, u))
    b.doc.on('update', (u: Uint8Array) => Y.applyUpdate(a.doc, u))

    a.setFile('api/handlers.py', 'def f():\n    pass\n')
    expect(b.text('api/handlers.py')).toBe('def f():\n    pass\n')
    expect(b.lineCount('api/handlers.py')).toBe(2)

    const c = a.addClaim({ path: 'api/handlers.py', from: 1, to: 2, by: 'Rohan', byKind: 'agent', intent: 'refactor' })
    expect(b.openClaims()[0].id).toBe(c.id)
    b.removeClaim(c.id)
    expect(a.openClaims()).toHaveLength(0)

    b.post<QuestionMsg>({ name: 'Kieran', kind: 'agent' }, { type: 'question', to: 'Rohan', text: 'changing payload?' })
    expect(a.lastMessages(1)[0]).toMatchObject({ type: 'question', from: 'Kieran', fromKind: 'agent' })
    expect(formatMsg(a.lastMessages(1)[0])).toBe("Kieran's agent → Rohan's agent asks: changing payload?")

    a.setMeta({ base: 'abc123', branch: 'main' })
    expect(b.meta.base).toBe('abc123')
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
  it('setFile with identical content is a no-op transaction', () => {
    const a = new RoomDoc()
    a.setFile('x', 'hi')
    let updates = 0
    a.doc.on('update', () => updates++)
    a.setFile('x', 'hi')
    expect(updates).toBe(0)
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
