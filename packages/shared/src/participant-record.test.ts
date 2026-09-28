import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc, participantRecord, type ParticipantGit, type ParticipantHolder } from './doc.js'
import { acceptedGit, liveHolder, participantsView } from './views.js'

const holder = (sessionId: string): ParticipantHolder => ({ sessionId, machine: 'machine', pid: 12, startTime: 'darwin:boot:34', executable: 'codex' })
const git = (fence: string): ParticipantGit => ({ branch: 'main', head: 'h', base: 'b', anchored: true, rev: 1, fence })
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
    expect(liveHolder(view, 'ben')).toBe('winner')
    expect(acceptedGit(participantRecord(room, 'ben'), view)).toBe('updating')
    room.participants.set('ben\0git', git('winner'))
    expect(acceptedGit(participantRecord(room, 'ben'), view)).toEqual(git('winner'))
    expect(liveHolder(participantsView(room, awareness('loser'), 100), 'ben')).toBeUndefined()
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

  it('survives concurrent insertion of the same name; the loser stops publishing on the merged holder', () => {
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
    let loserWrites = 0
    const tick = (room: RoomDoc, session: string) => {
      if (liveHolder(participantsView(room, awareness('a', 'b'), 100), 'ben') !== session) return
      room.participants.set('ben\0git', git(session))
      if (session === loser) loserWrites++
    }
    tick(a, 'a'); tick(b, 'b')
    expect(loserWrites).toBe(0)
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc))
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc))
    for (const room of [a, b]) {
      const view = participantsView(room, awareness(winner), 100)
      expect(acceptedGit(participantRecord(room, 'ben'), view)).toEqual(git(winner))
    }
  })
})
