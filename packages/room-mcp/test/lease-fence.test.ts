import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, type ParticipantHolder, type PushedMsg, type QuestionMsg } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { Ledger } from '../src/ledger.js'
import { createRelevance } from '../src/relevance.js'
import type { Session } from '../src/session.js'
import { WakeReconciler } from '../src/wake-reconciler.js'
import { visiblePeer } from './fixtures/visible.js'

// Ledger test 13. The hub-lease half (a lease that lapses on the client's clock) arrives with wave 4's
// epoch fences; the holder record half is here.

let repo: string
let behind: string
let c1: string, c2: string
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'room-fence-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't')
  writeFileSync(join(repo, 'app.py'), 'x = 1\n'); git('add', '.'); git('commit', '-qm', 'one'); c1 = git('rev-parse', 'HEAD')
  writeFileSync(join(repo, 'app.py'), 'x = 2\n'); git('commit', '-qam', 'two'); c2 = git('rev-parse', 'HEAD')
  behind = join(repo, '.room', 'behind')
  git('worktree', 'add', '-q', '--detach', behind, c1)
})
afterAll(() => rmSync(repo, { recursive: true, force: true }))

const holder = (sessionId: string): ParticipantHolder => ({ sessionId, epoch: sessionId === 'B' ? 2 : 1, pid: 1, startTime: 't', executable: 'codex', at: 1 })
const hold = (room: RoomDoc, name: string, sessionId: string) => { visiblePeer(room, name); room.participants.set(`${name}\u0000holder`, holder(sessionId)) }
const session = (room: RoomDoc, name: string, dir = repo): Session =>
  ({ room, awareness: new Awareness(room.doc), me: { name, kind: 'agent' }, roomName: 'r', dir } as unknown as Session)

describe('fencing (ledger test 13)', () => {
  it('A superseded by B: A stops selecting, committing and waking', async () => {
    const room = new RoomDoc()
    hold(room, 'Rohan', 'A')
    const s = session(room, 'Rohan')
    const ledger = new Ledger({ sessionId: () => 'A', route: () => ({}) })
    const send = vi.fn(async () => 'queue' as const)
    const wakes = new WakeReconciler({ ledger, bound: () => ({ id: 'A', host: 'codex' }), sessionDir: () => undefined, send })
    ledger.bind(s); wakes.attach(s)
    try {
      const first = hubAppend<QuestionMsg>(room, { name: 'Kieran', kind: 'agent' }, { type: 'question', to: 'Rohan', text: 'first?' })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
      const batch = ledger.open('reply')
      expect(ledger.select(s, batch).map(m => m.id)).toEqual([first.id])
      hold(room, 'Rohan', 'B')
      expect(ledger.select(s, ledger.open('reply'))).toEqual([])
      ledger.commit(batch)
      expect(room.seen('Rohan').has(first.id)).toBe(false)
      hubAppend<QuestionMsg>(room, { name: 'Kieran', kind: 'agent' }, { type: 'question', to: 'Rohan', text: 'second?' })
      await new Promise(r => setTimeout(r, 50))
      expect(send).toHaveBeenCalledTimes(1)
      expect(ledger.candidates(s)).toEqual([])
    } finally { wakes.stop(); s.awareness.destroy() }
  })

  it('a pushed {fromSha, toSha} with no `to` is offered to routed neighbours by HEAD, and nothing is written for it', () => {
    const room = new RoomDoc()
    visiblePeer(room, 'ben')
    const ledger = new Ledger({ sessionId: () => 'S', route: () => ({}), relevant: createRelevance() })
    const current = session(room, 'cy'), stale = session(room, 'dee', behind), author = session(room, 'ben')
    for (const s of [current, stale, author]) ledger.bind(s)
    const pushed = hubAppend<PushedMsg>(room, { name: 'ben', kind: 'agent' }, { type: 'pushed', branch: 'main', upstream: 'origin/main', fromSha: c1, toSha: c2, commits: 1, paths: ['app.py'], summary: 'two' })
    expect(pushed.to).toBeUndefined()
    const before = Y.encodeStateVector(room.doc)
    expect(ledger.candidates(current)).toEqual([])
    expect(ledger.candidates(stale).map(m => m.id)).toEqual([pushed.id])
    expect(ledger.candidates(author)).toEqual([])
    expect(Y.encodeStateVector(room.doc)).toEqual(before)
    for (const name of ['cy', 'dee', 'ben']) expect(room.seen(name).size).toBe(0)
    for (const s of [current, stale, author]) s.awareness.destroy()
  })
})
