import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, holderFence, participantRecord, type Identity } from '@room/shared'
import { createPrs } from '../src/tools/prs.js'
import { openPrs, type PrInfo } from '../src/prs.js'
import type { HandlerState } from '../src/tools/context.js'
import type { Session } from '../src/session.js'
import { testPolicyStore } from './policy-fixture.js'
import { hubSeam } from './fixtures/hub.js'
import { visiblePeer } from './fixtures/visible.js'

const PR7: PrInfo = { number: 7, title: 'Add login', author: 'kieran', head: 'feat/login', files: ['src/auth.py'], updatedAt: '2026-09-15T10:00:00Z', url: 'https://github.com/o/r/pull/7' }

function session(): Session {
  const room = new RoomDoc(new Y.Doc())
  const me: Identity = { name: 'alice', kind: 'agent', owner: 'alice' }
  const awareness = new Awareness(room.doc)
  const sessionId = visiblePeer(room, me.name, me.kind)
  room.participants.set(`${me.name}\0git`, { branch: 'main', head: 'a'.repeat(40), base: 'a'.repeat(40), anchored: true, rev: 1, fence: holderFence(participantRecord(room, me.name)?.holder)! })
  awareness.setLocalState({ user: { ...me, color: '#000' }, sessionId, status: 'idle', lastActive: Date.now() })
  return { room, awareness, me, dir: '/nonexistent', roomUrl: 'ws://127.0.0.1:9/x', roomName: 'github.com/o/r', browserUrl: 'http://x',
    ...hubSeam(room), policyStore: testPolicyStore(), provider: { synced: true, awareness } as unknown as Session['provider'] } as unknown as Session
}

type Fetch = (s: Session, opts?: { head?: boolean; branch?: string; signal?: AbortSignal }) => Promise<PrInfo[]>
function prs(fetch: Fetch, intervalMs = 0) {
  const logs: string[] = []
  const deps = {
    ctx: { prs: { fetch, intervalMs } },
    presences: (s: Session) => [{ user: s.me, lastActive: Date.now() }],
    log: (line: string) => logs.push(line),
    now: () => Date.now(),
  } as unknown as Pick<HandlerState, 'ctx' | 'presences' | 'log' | 'now'>
  return { ...createPrs(deps), logs }
}

function gate() {
  let open!: () => void
  const opened = new Promise<void>(resolve => { open = resolve })
  return { open, opened }
}

describe('PR refresh ownership', () => {
  it('keeps one refresh in flight per session and runs one follow-up for requests made meanwhile', async () => {
    const g = gate()
    let calls = 0
    const p = prs(async () => { calls++; await g.opened; return [PR7] })
    const s = session()
    const first = p.refreshPrs(s)
    const second = p.refreshPrs(s)
    const third = p.refreshPrs(s)
    await new Promise(r => setTimeout(r, 10))
    expect(calls).toBe(2) // one pass: the target and head queries for one branch
    g.open()
    await Promise.all([first, second, third])
    expect(calls).toBe(4) // exactly one follow-up pass for the two requests that arrived meanwhile
    expect(openPrs(s.room).map(pr => pr.number)).toEqual([7])
  })

  it('a refresh that outlives stopPrSync is aborted and never publishes', async () => {
    const g = gate()
    const signals: (AbortSignal | undefined)[] = []
    const p = prs(async (_s, opts) => { signals.push(opts?.signal); await g.opened; return [PR7] })
    const s = session()
    p.startPrSync(s)
    await new Promise(r => setTimeout(r, 10))
    expect(signals.length).toBe(2)
    p.stopPrSync()
    expect(signals.every(signal => signal?.aborted)).toBe(true)
    g.open()
    await new Promise(r => setTimeout(r, 10))
    expect(openPrs(s.room)).toEqual([])
    expect(p.logs).toEqual([])
  })

  it('a replaced sync session does not publish the old session\'s pass', async () => {
    const g = gate()
    const p = prs(async () => { await g.opened; return [PR7] })
    const old = session(), next = session()
    p.startPrSync(old)
    await new Promise(r => setTimeout(r, 10))
    p.startPrSync(next)
    g.open()
    await p.refreshPrs(next)
    expect(openPrs(old.room)).toEqual([])
    expect(openPrs(next.room).map(pr => pr.number)).toEqual([7])
    p.stopPrSync()
  })

  it('a refresh after stop starts a new pass', async () => {
    const p = prs(async () => [PR7])
    const s = session()
    p.startPrSync(s)
    p.stopPrSync()
    await p.refreshPrs(s)
    expect(openPrs(s.room).map(pr => pr.number)).toEqual([7])
  })
})
