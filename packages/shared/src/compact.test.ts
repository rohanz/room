import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc } from './doc.js'
import { compactDoc, docGeneration, structCount } from './compact.js'

const roots = (doc: Y.Doc) => Object.fromEntries([...doc.share.keys()].sort().map(name => {
  const type = doc.share.get(name)!
  return [name, type instanceof Y.Text ? type.toString() : type.toJSON()]
}))

describe('compactDoc', () => {
  it('copies every root by value, nested types included, and leaves no deleted structs', () => {
    const room = new RoomDoc()
    room.setOverlay('ada', 'a.py', 'one\ntwo\nthree\n')
    room.setOverlay('ada', 'a.py', 'one\nTWO\nthree\nfour\n')
    for (let i = 0; i < 50; i++) room.archive.set(`m${i}`, ['note', 'ada', i, []])
    for (let i = 0; i < 40; i++) room.archive.delete(`m${i}`)
    room.bus.push([{ id: 'x', type: 'note', from: 'ada', at: 1, seq: 7 } as never])
    room.manifest.set('ada\u0000f', new Y.Map() as never)
    room.manifest.get('ada\u0000f')!.set('a.py', { fence: 'f', held: 'claim' } as never)
    room.chat('ada').push([{ id: 'h', at: 1, text: 'hi' } as never])
    room.doc.getText('notes').insert(0, 'bold', { bold: true })
    // A root that reached this replica by update and was never read is a plain AbstractType here.
    const remote = new Y.Doc(); remote.getMap('unread').set('k', 1); remote.getArray('unreadList').push([1, 2])
    Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(remote))
    const deleted = (doc: Y.Doc) => { let n = 0; for (const list of (doc.store as unknown as { clients: Map<number, Array<{ deleted: boolean }>> }).clients.values()) for (const st of list) if (st.deleted) n++; return n }
    expect(deleted(room.doc)).toBeGreaterThan(0)
    const before = structCount(room.doc)

    const copy = compactDoc(room.doc, 'g1')
    expect(docGeneration(copy)).toBe('g1')
    const { generation: _g, ...meta } = copy.getMap('meta').toJSON()
    expect({ ...roots(copy), meta }).toEqual({ ...roots(room.doc), meta: room.metaMap.toJSON() })
    expect(copy.getMap<Y.Map<Y.Text>>('overlays').get('ada')!.get('a.py')).toBeInstanceOf(Y.Text)
    expect(copy.getText('notes').toDelta()).toEqual([{ insert: 'bold', attributes: { bold: true } }])
    expect(deleted(copy)).toBe(0)
    expect(structCount(copy)).toBeLessThan(before)
  })

  it('re-creates a claim anchor at the same lines of the copied text', () => {
    const room = new RoomDoc()
    room.setOverlay('ada', 'a.py', 'a\nb\nc\nd\ne\n')
    const claim = room.addClaim({ path: 'a.py', from: 2, to: 3, by: 'ada', byKind: 'agent' } as never)
    room.setOverlay('ada', 'a.py', 'zero\na\nb\nc\nd\ne\n') // the anchor tracks the text: lines 3-4 now
    expect(room.claimRange(claim)).toEqual({ from: 3, to: 4 })
    const copy = new RoomDoc(compactDoc(room.doc, 'g'))
    expect(copy.claimRange(copy.claims.get(claim.id)!)).toEqual({ from: 3, to: 4 })
    copy.setOverlay('ada', 'a.py', 'x\ny\nzero\na\nb\nc\nd\ne\n')
    expect(copy.claimRange(copy.claims.get(claim.id)!)).toEqual({ from: 5, to: 6 })
  })

  it('drops an anchor that no longer resolves, keeping the stored lines', () => {
    const room = new RoomDoc()
    room.setOverlay('ada', 'a.py', 'a\nb\n')
    const claim = room.addClaim({ path: 'a.py', from: 1, to: 2, by: 'ada', byKind: 'agent' } as never)
    room.clearOverlay('ada', 'a.py')
    const copied = compactDoc(room.doc, 'g').getMap<{ anchor?: unknown; from: number; to: number }>('claims').get(claim.id)!
    expect(copied.anchor).toBeUndefined()
    expect([copied.from, copied.to]).toEqual([1, 2])
  })

  it('refuses XML types, leaving the decision to the caller', () => {
    const doc = new Y.Doc(); doc.getXmlFragment('x').insert(0, [new Y.XmlText('t')])
    expect(() => compactDoc(doc, 'g')).toThrow(/XML/)
  })
})
