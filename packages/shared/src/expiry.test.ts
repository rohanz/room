import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc, participantRecord, type ParticipantHolder } from './doc.js'
import { ROOM_STALE_MS, participantsView, type ParticipantView } from './views.js'
import { ExpiryTenure, expireParticipant } from './expiry.js'
import type { QuestionMsg } from './types.js'
import { hubAppend } from './testing.js'

/** Tenure tests without claims: no release notices to send. */
const ignore = () => {}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const holder = (sessionId: string, workerId?: string): ParticipantHolder => ({ sessionId, epoch: 1, pid: 1, startTime: 't', executable: 'codex', at: 0, ...(workerId ? { workerId } : {}) })

function withRecord(room: RoomDoc, name: string, h: ParticipantHolder = holder(`${name}-s`)): void {
  room.participants.set(`${name}\0id`, { name, kind: 'agent' })
  room.participants.set(`${name}\0holder`, h)
}
const absent = (name: string): ParticipantView => ({ name, fresh: false, visible: true })
const present = (name: string): ParticipantView => ({ name, fresh: true, visible: true })

/** A monotonic clock a test moves by hand; `at` is the clock's arbitrary origin. */
function clock(at: number) {
  let t = at
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('expiry authority (reporooms S5): observation epochs on the leader\'s own clock', () => {
  it('adds only continuous absence it measured itself and expires at ROOM_STALE_DAYS', () => {
    const room = new RoomDoc()
    withRecord(room, 'ben')
    const c = clock(5)
    const tenure = new ExpiryTenure('ep_a', c.now)
    expect(tenure.observe(room, [absent('ben')], undefined, ignore)).toEqual([])
    expect(room.expiry.get('ben')).toBeUndefined() // the first observation only starts a measurement
    c.advance(3 * DAY)
    tenure.observe(room, [absent('ben')], undefined, ignore)
    expect(room.expiry.get('ben')).toEqual({ observedMs: 3 * DAY, epoch: 'ep_a' })
    c.advance(4 * DAY - 1)
    expect(tenure.observe(room, [absent('ben')], undefined, ignore)).toEqual([])
    c.advance(1)
    expect(tenure.observe(room, [absent('ben')], undefined, ignore)).toEqual(['ben'])
    expect(participantRecord(room, 'ben')).toBeUndefined()
    expect(room.expiry.has('ben')).toBe(false)
  })

  it('a fresh holder clears the measurement', () => {
    const room = new RoomDoc()
    withRecord(room, 'ben')
    const c = clock(0)
    const tenure = new ExpiryTenure('ep_a', c.now)
    tenure.observe(room, [absent('ben')], undefined, ignore)
    c.advance(6 * DAY)
    tenure.observe(room, [absent('ben')], undefined, ignore)
    tenure.observe(room, [present('ben')], undefined, ignore)
    expect(room.expiry.has('ben')).toBe(false)
    c.advance(2 * DAY)
    expect(tenure.observe(room, [absent('ben')], undefined, ignore)).toEqual([])
    c.advance(2 * DAY)
    tenure.observe(room, [absent('ben')], undefined, ignore)
    expect(room.expiry.get('ben')?.observedMs).toBe(2 * DAY)
  })

  it('a leader handover with a skewed clock never expires early; time with no leader counts for nothing', () => {
    const room = new RoomDoc()
    withRecord(room, 'ben')
    const a = clock(1_000)
    const first = new ExpiryTenure('ep_a', a.now)
    first.observe(room, [absent('ben')], undefined, ignore)
    a.advance(6 * DAY)
    first.observe(room, [absent('ben')], undefined, ignore)
    expect(room.expiry.get('ben')).toEqual({ observedMs: 6 * DAY, epoch: 'ep_a' })
    // Leader A leaves. Three days pass with no leader. B's clock reads ten days ahead of A's.
    const b = clock(1_000 + 6 * DAY + 13 * DAY)
    const second = new ExpiryTenure('ep_b', b.now)
    expect(second.observe(room, [absent('ben')], undefined, ignore)).toEqual([])
    expect(room.expiry.get('ben')).toEqual({ observedMs: 6 * DAY, epoch: 'ep_a' })
    b.advance(DAY - 1)
    expect(second.observe(room, [absent('ben')], undefined, ignore)).toEqual([])
    expect(room.expiry.get('ben')).toEqual({ observedMs: 7 * DAY - 1, epoch: 'ep_b' })
    b.advance(1)
    expect(second.observe(room, [absent('ben')], undefined, ignore)).toEqual(['ben'])
  })

  it('never double-counts when another leader wrote meanwhile (partition): it restarts its own measurement', () => {
    const room = new RoomDoc()
    withRecord(room, 'ben')
    const c = clock(0)
    const mine = new ExpiryTenure('ep_mine', c.now)
    mine.observe(room, [absent('ben')], undefined, ignore)
    c.advance(DAY)
    mine.observe(room, [absent('ben')], undefined, ignore)
    room.expiry.set('ben', { observedMs: 5 * DAY, epoch: 'ep_other' })
    c.advance(DAY)
    mine.observe(room, [absent('ben')], undefined, ignore)
    expect(room.expiry.get('ben')).toEqual({ observedMs: 5 * DAY, epoch: 'ep_other' })
    c.advance(DAY)
    mine.observe(room, [absent('ben')], undefined, ignore)
    expect(room.expiry.get('ben')).toEqual({ observedMs: 6 * DAY, epoch: 'ep_mine' })
  })

  it('measures only participants with a holder, and never workers (their projector retires them)', () => {
    const room = new RoomDoc()
    room.participants.set('legacy\0git', { branch: 'main', head: 'h', base: 'h', anchored: true, rev: 1, fence: '' })
    withRecord(room, 'lead+w', holder('w-s', 'w1'))
    withRecord(room, 'lead+x')
    room.workerViews.set('w_x', { id: 'w_x', tag: 'x', name: 'lead+x', lead: 'lead', mode: 'here', host: 'codex', task: 't', branch: 'room/x', status: 'running', run: 1, startedAt: 1, fence: 'lead-s' })
    const c = clock(0)
    const tenure = new ExpiryTenure('ep_a', c.now)
    const view = [absent('legacy'), absent('lead+w'), absent('lead+x')]
    tenure.observe(room, view, undefined, ignore)
    c.advance(30 * DAY)
    expect(tenure.observe(room, view, undefined, ignore)).toEqual([])
    expect([...room.expiry.keys()]).toEqual([])
  })

  it('reads the participants view: a holder without its session in presence is absent', () => {
    const room = new RoomDoc()
    withRecord(room, 'ben', holder('s1'))
    const c = clock(0)
    const tenure = new ExpiryTenure('ep_a', c.now)
    const gone = participantsView(room, { getStates: () => new Map() }, 0)
    tenure.observe(room, gone, undefined, ignore)
    c.advance(ROOM_STALE_MS)
    expect(tenure.observe(room, gone, undefined, ignore)).toEqual(['ben'])
  })
})

describe('expireParticipant', () => {
  it('removes one participant\'s fields, manifest, head, text, claims, scope and owned slots in one transaction', () => {
    const room = new RoomDoc()
    withRecord(room, 'ben')
    withRecord(room, 'ben+x')
    room.participants.set('ben\0git', { branch: 'main', head: 'h', base: 'h', anchored: true, rev: 1, fence: 'ben-s' })
    const manifest = room.doc.getMap<Y.Map<unknown>>('manifest')
    manifest.set('ben\0ben-s', new Y.Map())
    manifest.set('ben+x\0x-s', new Y.Map())
    room.doc.getMap('manifestHead').set('ben', { complete: true })
    room.doc.getMap('manifestHead').set('ben+x', { complete: true })
    room.setOverlay('ben', 'a.txt', 'mine\n')
    room.setOverlay('ben+x', 'a.txt', 'theirs\n')
    room.setBaseOf('ben', 'h')
    room.setScope('ben', { byKind: 'agent', area: 'a', summary: 's', paths: ['a.txt'] })
    room.setScope('ben+x', { byKind: 'agent', area: 'b', summary: 's', paths: ['b.txt'] })
    const claim = room.addClaim({ path: 'a.txt', from: 1, to: 1, by: 'ben', byKind: 'agent', intent: 'edit' })
    const kept = room.addClaim({ path: 'b.txt', from: 1, to: 1, by: 'ben+x', byKind: 'agent', intent: 'edit' })
    room.doc.getMap('conflicts').set('ben\0merge\0cy\0a.txt\0', { status: 'conflict' })
    room.doc.getMap('conflicts').set('cy\0merge\0ben\0a.txt\0', { status: 'conflict' })
    room.expiry.set('ben', { observedMs: ROOM_STALE_MS, epoch: 'ep' })
    const question = hubAppend<QuestionMsg>(room, { name: 'cy', kind: 'agent' }, { type: 'question', to: 'ben', text: 'still there?' })

    let transactions = 0
    room.doc.on('afterTransaction', () => { transactions++ })
    const releases: unknown[] = []
    expireParticipant(room, 'ben', undefined, (from, body) => { releases.push({ from, body }) })

    expect(transactions).toBe(1)
    expect(participantRecord(room, 'ben')).toBeUndefined()
    expect(participantRecord(room, 'ben+x')).toBeDefined()
    expect([...manifest.keys()]).toEqual(['ben+x\0x-s'])
    expect([...room.doc.getMap('manifestHead').keys()]).toEqual(['ben+x'])
    expect([...room.overlays.keys()]).toEqual(['ben+x'])
    expect(room.bases.has('ben')).toBe(false)
    expect(room.scope('ben')).toBeUndefined()
    expect(room.scope('ben+x')).toBeDefined()
    expect(room.claims.has(claim.id)).toBe(false)
    expect(room.claims.has(kept.id)).toBe(true)
    expect([...room.doc.getMap('conflicts').keys()]).toEqual(['cy\0merge\0ben\0a.txt\0'])
    expect(room.expiry.has('ben')).toBe(false)
    expect(room.messages()).toContainEqual(question) // owed mail stays: it is the ledger's
    // The hub appends the notices; the transaction itself writes no bus entry.
    expect(room.messages()).toEqual([question])
    expect(releases).toMatchObject([{ from: { name: 'ben' }, body: { type: 'release', claimId: claim.id } }])
  })
})
