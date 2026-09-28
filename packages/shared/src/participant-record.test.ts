import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc, participantRecord, type ParticipantGit, type ParticipantHolder } from './doc.js'
import { acceptedGit, liveHolder, participantsView } from './views.js'

const epochs: Record<string, number> = {}
/** Each session's hub lease; its fence is the epoch (hub §4.1). */
const holder = (sessionId: string): ParticipantHolder => ({ sessionId, epoch: epochs[sessionId] ??= 1000 + Object.keys(epochs).length, pid: 12, startTime: 'darwin:boot:34', executable: 'codex', at: 1 })
const fence = (sessionId: string) => String(holder(sessionId).epoch)
const git = (session: string): ParticipantGit => ({ branch: 'main', head: 'h', base: 'b', anchored: true, rev: 1, fence: fence(session) })
const awareness = (...sessions: string[]) => ({ getStates: () => new Map(sessions.map((sessionId, i) => [i, { user: { name: 'ben', kind: 'agent' }, sessionId }])) })

describe('flat participant records', () => {
  it('stores whole fields in a flat Y.Map and exposes schema version additively', () => {
    const room = new RoomDoc()
    room.participants.set('ben\0id', { name: 'ben', kind: 'agent' })
    room.participants.set('ben\0holder', holder('s1'))
    room.participants.set('ben\0git', git('s1'))
    room.setMeta({ schemaVersion: 2 })
    expect([...room.participants.keys()].sort()).toEqual(['ben\0git', 'ben\0holder', 'ben\0id'])
    expect(participantRecord(room, 'ben')).toEqual({ id: { name: 'ben', kind: 'agent' }, holder: holder('s1'), git: git('s1') })
    expect(room.meta.schemaVersion).toBe(2)
    expect(participantRecord(room, 'nobody')).toBeUndefined()
  })

  it('fences own git on the live holder and excludes non-holder presence', () => {
    const room = new RoomDoc()
    room.participants.set('ben\0id', { name: 'ben', kind: 'agent' })
    room.participants.set('ben\0holder', holder('winner'))
    room.participants.set('ben\0git', git('loser'))
    const view = participantsView(room, awareness('loser', 'winner'), 100)
    expect(view).toMatchObject([{ name: 'ben', fresh: true, visible: true, holder: holder('winner') }])
    expect(liveHolder(view, 'ben')).toBe(fence('winner'))
    expect(acceptedGit(participantRecord(room, 'ben'), view)).toBe('updating')
    room.participants.set('ben\0git', git('winner'))
    expect(acceptedGit(participantRecord(room, 'ben'), view)).toEqual(git('winner'))
    expect(liveHolder(participantsView(room, awareness('loser'), 100), 'ben')).toBeUndefined()
  })

  it('fences on the hub epoch: a re-grant to the same session rejects the old epoch\'s writes', () => {
    const room = new RoomDoc()
    room.participants.set('ben\0holder', { ...holder('s1'), epoch: 7 })
    room.participants.set('ben\0git', { ...git('s1'), fence: '7' })
    const view = participantsView(room, awareness('s1'), 100)
    expect(acceptedGit(participantRecord(room, 'ben'), view)).toMatchObject({ fence: '7' })
    room.participants.set('ben\0holder', { ...holder('s1'), epoch: 9 })
    expect(acceptedGit(participantRecord(room, 'ben'), participantsView(room, awareness('s1'), 100))).toBe('updating')
  })

  it('keeps an ended holder\'s facts readable offline, but a projection needs a live, un-ended lead', () => {
    const room = new RoomDoc()
    room.participants.set('ben\0holder', { ...holder('s1'), ended: 'released' })
    room.participants.set('ben\0git', git('s1'))
    const view = participantsView(room, awareness('s1'), 100)
    expect(acceptedGit(participantRecord(room, 'ben'), view)).toEqual(git('s1'))
    expect(liveHolder(view, 'ben')).toBeUndefined()
  })

  it('fences projected git against the lead live holder', () => {
    const room = new RoomDoc()
    room.participants.set('lead\0id', { name: 'lead', kind: 'agent' })
    room.participants.set('lead\0holder', holder('lead-session'))
    room.participants.set('worker\0id', { name: 'worker', kind: 'agent' })
    room.participants.set('worker\0holder', { ...holder('worker-session'), workerId: 'w1' })
    room.participants.set('worker\0proj', { projectedFrom: 'w1', projectedBy: 'lead' })
    room.participants.set('worker\0git', git('lead-session'))
    const live = participantsView(room, { getStates: () => new Map([[1, { user: { name: 'lead', kind: 'agent' }, sessionId: 'lead-session' }]]) }, 100)
    expect(acceptedGit(participantRecord(room, 'worker'), live)).toEqual(git('lead-session'))
    expect(acceptedGit(participantRecord(room, 'worker'), participantsView(room, { getStates: () => new Map() }, 100))).toBe('updating')
  })

  it('uses observed absence for visibility, never another machine wall-clock expiry', () => {
    const room = new RoomDoc()
    room.participants.set('ben\0id', { name: 'ben', kind: 'agent' })
    room.participants.set('ben\0holder', holder('s1'))
    const stale = { getStates: () => new Map([[1, { user: { name: 'ben', kind: 'agent' }, sessionId: 's1' }]]), meta: new Map([[1, { lastUpdated: 1 }]]) }
    expect(participantsView(room, stale, 40_000)[0]).toMatchObject({ fresh: false, visible: true })
    room.expiry.set('ben', { observedMs: 7 * 24 * 60 * 60 * 1000, epoch: 'leader-2' })
    expect(participantsView(room, stale, 40_000)[0]).toMatchObject({ fresh: false, visible: false })
    expect(participantsView(room, awareness('s1'), 40_000)[0]).toMatchObject({ fresh: true, visible: true })
  })

  it('keeps concurrent flat records attached and fences a losing session\'s later write', () => {
    const a = new RoomDoc(new Y.Doc())
    const b = new RoomDoc(new Y.Doc())
    for (const [room, session] of [[a, 'a'], [b, 'b']] as const) {
      room.participants.set('ben\0id', { name: 'ben', kind: 'agent' })
      room.participants.set('ben\0holder', holder(session))
      room.participants.set('ben\0git', git(session))
    }
    const ua = Y.encodeStateAsUpdate(a.doc)
    const ub = Y.encodeStateAsUpdate(b.doc)
    Y.applyUpdate(a.doc, ub)
    Y.applyUpdate(b.doc, ua)
    expect(a.participants.toJSON()).toEqual(b.participants.toJSON())
    const winner = participantRecord(a, 'ben')!.holder!.sessionId
    const loser = winner === 'a' ? 'b' : 'a'
    const sync = () => {
      const fromA = Y.encodeStateAsUpdate(a.doc)
      const fromB = Y.encodeStateAsUpdate(b.doc)
      Y.applyUpdate(a.doc, fromB)
      Y.applyUpdate(b.doc, fromA)
    }
    const winnerRoom = winner === 'a' ? a : b
    const loserRoom = loser === 'a' ? a : b
    winnerRoom.participants.set('ben\0git', git(winner))
    sync()
    for (const room of [a, b]) {
      const view = participantsView(room, awareness(winner), 100)
      expect(acceptedGit(participantRecord(room, 'ben'), view)).toEqual(git(winner))
    }

    // This simulates the read fence; production stop-and-rename arrives with the wave-4 name lease.
    loserRoom.participants.set('ben\0git', git(loser))
    sync()
    for (const room of [a, b]) {
      expect(participantRecord(room, 'ben')?.git?.fence).toBe(fence(loser))
      expect(acceptedGit(participantRecord(room, 'ben'), participantsView(room, awareness(winner), 100))).toBe('updating')
    }
  })
})
