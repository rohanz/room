import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc } from './doc.js'
import { FRESH_GENERATION, compactDoc, docGeneration, generationGate, generationParams, historyOf, replicaGeneration } from './compact.js'
const structCount = (doc: Y.Doc) => historyOf(doc).structs

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

it('compacting a compacted document leaves no tombstone of the old generation', () => {
  const once = compactDoc(new RoomDoc().doc, 'g1')
  once.getMap('meta').set('hubSeq', 1); once.getMap('meta').set('hubSeq', 2)
  const twice = compactDoc(once, 'g2')
  expect(docGeneration(twice)).toBe('g2')
  expect(historyOf(twice).deleted).toBe(0)
})

describe('historyOf', () => {
  it('counts every struct and the deleted ones among them', () => {
    const doc = new Y.Doc()
    expect(historyOf(doc)).toEqual({ structs: 0, deleted: 0 })
    const map = doc.getMap('m'), list = doc.getArray('l')
    for (let i = 0; i < 10; i++) doc.transact(() => { map.set('k', i); list.push([i]) })
    const before = historyOf(doc)
    expect(before.deleted).toBeGreaterThanOrEqual(9)
    expect(historyOf(compactDoc(doc, 'g'))).toMatchObject({ deleted: 0 })
    expect(historyOf(compactDoc(doc, 'g')).structs).toBeLessThan(before.structs)
  })
})

describe('the generation a replica states', () => {
  it('is fresh until the replica holds server data, whatever it wrote itself', () => {
    const doc = new Y.Doc()
    expect(replicaGeneration(doc)).toBe(FRESH_GENERATION)
    doc.getMap('participants').set('ada', { name: 'ada' })
    doc.getArray('l').push([1])
    expect(replicaGeneration(doc)).toBe(FRESH_GENERATION)
  })

  it('pins an uncompacted room as 0 and a compacted one as its generation', () => {
    const server = new Y.Doc(); server.getMap('meta').set('schemaVersion', 2)
    const a = new Y.Doc()
    Y.applyUpdate(a, Y.encodeStateAsUpdate(server))
    expect(replicaGeneration(a)).toBe('0')
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(compactDoc(server, 'g1')))
    expect(replicaGeneration(b)).toBe('g1')
  })

  it('is pinned by any server update, even one that cannot integrate yet (no full sync)', () => {
    const server = new Y.Doc(); server.getMap('meta').set('generation', 'g1'); server.getArray('bus').push([1])
    const vector = Y.encodeStateVector(server)
    server.getArray('bus').push([2])
    const replica = new Y.Doc()
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(server, vector)) // the broadcast, before sync step 2
    expect(replica.getArray('bus').length).toBe(0)
    expect(replicaGeneration(replica)).toBe('0') // not fresh: a stale or needless rejoin, never a merge
    const deletion = new Y.Doc(); const items = server.getArray('bus'); const sv = Y.encodeStateVector(server)
    items.delete(0, 1)
    Y.applyUpdate(deletion, Y.encodeStateAsUpdate(server, sv)) // a deletion alone
    expect(replicaGeneration(deletion)).not.toBe(FRESH_GENERATION)
  })

  it('reaches every reconnect through the provider params, as an enumerable getter', () => {
    const doc = new Y.Doc()
    const params = generationParams(doc, { schema: '2' })
    expect(new URLSearchParams(Object.entries(params)).toString()).toBe('schema=2&gen=fresh')
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(compactDoc(new Y.Doc(), 'g2')))
    expect(Object.keys(params)).toEqual(['schema', 'gen'])
    expect(params.gen).toBe('g2')
    params.ticket = 't'
    expect({ ...params }).toEqual({ schema: '2', gen: 'g2', ticket: 't' })
  })
})

describe('generationGate', () => {
  it.each([
    ['fresh', undefined, 'accept'], ['fresh', 'g1', 'accept'],
    ['0', undefined, 'accept'], ['g1', 'g1', 'accept'],
    ['0', 'g1', 'stale'], ['g1', 'g2', 'stale'], ['g1', undefined, 'stale'],
    [null, undefined, 'accept'], [null, 'g1', 'update'],
  ] as const)('a replica stating %s in a room at %s: %s', (stated, current, verdict) => {
    expect(generationGate(stated, current)).toBe(verdict)
  })
})
