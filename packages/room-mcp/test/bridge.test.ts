import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import type { Identity, ClaimMsg } from '@room/shared'
import { Bridge } from '../src/bridge.js'
import type { Session } from '../src/session.js'

let dir: string, base: string
const lead: Identity = { name: 'rohanz', kind: 'agent', owner: 'rohanz' }
const worker: Identity = { name: 'rohanz+money', kind: 'agent', owner: 'rohanz', label: 'money' }
const kieran: Identity = { name: 'kieran', kind: 'agent', owner: 'kieran' }

function pair() {
  const a = new Y.Doc(), b = new Y.Doc()
  a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
  b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u))
  return { a: new RoomDoc(a), b: new RoomDoc(b) }
}
function fakeSession(room: RoomDoc, me: Identity, roomName: string, local: boolean): Session {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
  return {
    room, awareness, me, dir, roomUrl: `ws://x/${encodeURIComponent(roomName)}`, roomName, browserUrl: 'http://x',
    provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: me.name, roomDoc: room, provider: null as never, branch: 'main', base } as never,
    shareMax: 'full', shareRequested: 'full',
    ...(local ? { local: { url: 'ws://127.0.0.1:1', port: 1, owned: true, async stop() {} } } : {}),
  } as Session
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-bridge-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'rohanz')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
  base = git('rev-parse', 'HEAD').trim()
})

function setup() {
  const team = pair(), local = pair()
  team.a.setMeta({ repo: 'x', branch: 'main', base }); local.a.setMeta({ repo: 'x', branch: 'main', base })
  const teamLead = fakeSession(team.a, lead, 'github.com/rohanz/x/main', false)
  const localLead = fakeSession(local.a, lead, 'local/x/main', true)
  local.a.setWorker({ tag: 'money', name: worker.name, host: 'claude', task: 'switch prices to cents', dir, branch: 'room/money', pid: 1, startedAt: 1, status: 'running', lead: lead.name })
  const bridge = new Bridge(teamLead, localLead, { debounceMs: 0 })
  bridge.start()
  return { team, local, teamLead, localLead, bridge }
}

describe('Bridge: a lead in a team room with a local workers room', () => {
  it("the lead's team scope is the union of its workers' declared and changed paths", () => {
    const t = setup()
    expect(t.team.a.scope('rohanz')).toBeUndefined()
    t.local.b.setScope({ by: worker.name, byKind: 'agent', area: 'orders', summary: 'cents', paths: ['api/models.py', 'api/handlers.py'] })
    const sc = t.team.b.scope('rohanz')!
    expect(sc.paths).toEqual(['api/handlers.py', 'api/models.py'])
    expect(sc.area).toBe('orders')
    expect(sc.summary).toContain('lead of 1 worker: money')
    t.local.b.setOverlay(worker.name, 'tests/test_money.py', 'x\n')
    expect(t.team.b.scope('rohanz')!.paths).toContain('tests/test_money.py')
    // the team room hears the scope as a message from the lead, never from the worker
    const scopeMsgs = t.team.b.messages().filter(m => m.type === 'scope')
    expect(scopeMsgs.length).toBeGreaterThan(0)
    expect(scopeMsgs.every(m => m.from === 'rohanz')).toBe(true)
    expect(t.team.b.messages().some(m => m.from === worker.name)).toBe(false)
  })

  it("workers' claims are mirrored into the team room under the lead's name and removed with the original", () => {
    const t = setup()
    t.local.b.setOverlay(worker.name, 'app.py', 'x = 2\n')
    const c = t.local.b.addClaim({ path: 'app.py', from: 1, to: 1, by: worker.name, byKind: 'agent', intent: 'bump x' })
    const mirrored = t.team.b.openClaims()
    expect(mirrored).toHaveLength(1)
    expect(mirrored[0]).toMatchObject({ by: 'rohanz', path: 'app.py', from: 1, to: 1, intent: '[money] bump x' })
    t.local.b.removeClaim(c.id)
    expect(t.team.b.openClaims()).toEqual([])
  })

  it('a team message touching a worker path becomes an interrupt to that worker in the local room', () => {
    const t = setup()
    t.local.b.setScope({ by: worker.name, byKind: 'agent', area: 'orders', summary: 'cents', paths: ['api/'] })
    // Kieran, in the team room, claims a file under the worker's scope
    t.team.b.post<ClaimMsg>(kieran, { type: 'claim', claimId: 'c_k', path: 'api/handlers.py', from_line: 1, to_line: 5, intent: 'renaming validate' })
    const relayed = t.local.b.messages().filter(m => m.type === 'note' && m.to === worker.name)
    expect(relayed).toHaveLength(1)
    expect(relayed[0].priority).toBe('interrupt')
    expect((relayed[0] as { text: string }).text).toContain('[team room]')
    expect((relayed[0] as { text: string }).text).toContain('renaming validate')
    // unrelated team traffic is not relayed
    t.team.b.post<ClaimMsg>(kieran, { type: 'claim', claimId: 'c_k2', path: 'web/index.ts', from_line: 1, to_line: 5, intent: 'css' })
    expect(t.local.b.messages().filter(m => m.type === 'note' && m.to === worker.name)).toHaveLength(1)
    // the lead's own team messages are never relayed to its workers
    t.team.a.post<ClaimMsg>(lead, { type: 'claim', claimId: 'c_me', path: 'api/x.py', from_line: 1, to_line: 1, intent: 'mine' })
    expect(t.local.b.messages().filter(m => m.type === 'note' && m.to === worker.name)).toHaveLength(1)
  })

  it('stop() removes the mirrored claims and stops relaying', () => {
    const t = setup()
    t.local.b.addClaim({ path: 'app.py', from: 1, to: 1, by: worker.name, byKind: 'agent', intent: 'bump x' })
    expect(t.team.b.openClaims()).toHaveLength(1)
    t.bridge.stop()
    expect(t.team.b.openClaims()).toEqual([])
    t.local.b.setScope({ by: worker.name, byKind: 'agent', area: 'orders', summary: 'late', paths: ['late.py'] })
    expect(t.team.b.scope('rohanz')?.paths ?? []).not.toContain('late.py')
  })
})
