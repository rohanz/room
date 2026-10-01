import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { EventEmitter } from 'node:events'
import { RoomDoc } from './doc.js'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { COMPACT_MIN_TOMBSTONES, MSG_GENERATION, compactDoc, compactionDue, docGeneration, encodeGenerationFrame, generationVerdict, historyOf, trackGeneration } from './compact.js'

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
    room.manifest.set('ada\u0000f', new Y.Map())
    room.manifest.get('ada\u0000f')!.set('a.py', { fence: 'f', held: 'claim' } as never)
    room.chat('ada').push([{ id: 'h', at: 1, text: 'hi' } as never])
    room.doc.getText('notes').insert(0, 'bold', { bold: true })
    // A root that reached this replica by update and was never read is a plain AbstractType here.
    const remote = new Y.Doc(); remote.getMap('unread').set('k', 1); remote.getArray('unreadList').push([1, 2])
    Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(remote))
    const before = historyOf(room.doc)
    expect(before.deleted).toBeGreaterThan(0)

    const copy = compactDoc(room.doc, 'g1')
    expect(docGeneration(copy)).toBe('g1')
    const { generation: _g, ...meta } = copy.getMap('meta').toJSON()
    expect({ ...roots(copy), meta }).toEqual({ ...roots(room.doc), meta: room.metaMap.toJSON() })
    expect(copy.getMap<Y.Map<Y.Text>>('overlays').get('ada')!.get('a.py')).toBeInstanceOf(Y.Text)
    expect(copy.getText('notes').toDelta()).toEqual([{ insert: 'bold', attributes: { bold: true } }])
    expect(historyOf(copy).deleted).toBe(0)
    expect(historyOf(copy).structs).toBeLessThan(before.structs)
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

describe('the compaction trigger', () => {
  it('fires only past the floor and once tombstones outnumber live structs', () => {
    expect(compactionDue({ structs: COMPACT_MIN_TOMBSTONES * 3, deleted: COMPACT_MIN_TOMBSTONES })).toBe(false)
    expect(compactionDue({ structs: 30_000, deleted: COMPACT_MIN_TOMBSTONES - 1 })).toBe(false)
    expect(compactionDue({ structs: 30_000, deleted: COMPACT_MIN_TOMBSTONES + 1 })).toBe(true)
    expect(compactionDue({ structs: 100, deleted: 60 }, 50)).toBe(true)
  })
})

describe('the generation gate', () => {
  it.each([
    ['fresh', undefined, undefined, 'current'], ['fresh', 'g2', 'g1', 'current'],
    ['0', undefined, undefined, 'current'], ['g2', 'g2', 'g1', 'current'],
    ['g1', 'g2', 'g1', 'straggler'], ['0', 'g1', '0', 'straggler'],
    ['g0', 'g2', 'g1', 'too-old'], ['g1', undefined, undefined, 'too-old'],
    [null, undefined, undefined, 'legacy'], [null, 'g2', 'g1', 'outdated'],
  ] as const)('gen=%s against room %s (previous %s): %s', (param, room, previous, verdict) => {
    expect(generationVerdict(param, room, previous)).toBe(verdict)
  })

  it('a replica sends fresh until the server announces a generation, then that one, across reconnects', () => {
    const fake = () => ({ messageHandlers: [] as Array<(e: encoding.Encoder, d: decoding.Decoder, p: unknown, s: boolean, t: number) => void> })
    const announce = (p: ReturnType<typeof fake>, g: string, current = g) => {
      const d = decoding.createDecoder(encodeGenerationFrame({ g, current }))
      const type = decoding.readVarUint(d)
      p.messageHandlers[type]!(encoding.createEncoder(), d, p, true, type)
    }
    const doc = new Y.Doc(), probe = fake(), params: Record<string, string> = { schema: '2' }
    const stale: string[] = []
    trackGeneration(probe, doc, params, current => stale.push(current))
    expect({ ...params }).toEqual({ schema: '2', gen: 'fresh' })
    announce(probe, 'g7') // before any sync: the frame precedes every byte of document state
    expect(params.gen).toBe('g7')
    announce(probe, 'g7', 'g8') // a straggler connection: served g7, the room is at g8
    expect(params.gen).toBe('g7')
    expect(stale).toEqual(['g8'])
    const roomd = fake(), roomdParams: Record<string, string> = {}
    trackGeneration(roomd, doc, roomdParams) // roomd's provider over the probe's replica
    expect(roomdParams.gen).toBe('g7')
    expect(MSG_GENERATION).toBe(8)
  })
})
