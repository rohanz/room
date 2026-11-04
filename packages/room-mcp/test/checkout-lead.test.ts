import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckoutLead, leadsCheckout } from '../src/checkout-lead.js'
import { ConflictSet } from '../src/conflict-set.js'
import { joinSession, leaveSession, type Session } from '../src/session.js'
import { createTools } from '../src/tools.js'
import { testPolicyStore } from './policy-fixture.js'

describe('CheckoutLead', () => {
  const setup = (publisher: boolean) => {
    const store = testPolicyStore()
    store.setPublisher(publisher, publisher ? undefined : 'rohanz')
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
    const lines: string[] = []
    const lead = new CheckoutLead(store, {
      graceMs: 60_000, log: line => lines.push(line),
      after: ((fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; timers.push(t); return t }) as unknown as typeof setTimeout,
      cancel: ((t: { cleared: boolean }) => { t.cleared = true }) as unknown as typeof clearTimeout,
    })
    const graph = { name: 'symbol graph', start: vi.fn(), stop: vi.fn() }
    const conflicts = { name: 'conflict checks', start: vi.fn(), stop: vi.fn() }
    const detachGraph = lead.attach(graph)
    const detachConflicts = lead.attach(conflicts)
    return { store, timers, lead, lines, graph, conflicts, detachGraph, detachConflicts }
  }

  it('one predicate: the publisher lease, and a session without a policy is alone', () => {
    expect(leadsCheckout(undefined)).toBe(true)
    expect(leadsCheckout(testPolicyStore().policy)).toBe(true)
    const store = testPolicyStore(); store.setPublisher(false, 'rohanz')
    expect(leadsCheckout(store.policy)).toBe(false)
  })

  it('starts attached work at once for the publisher', () => {
    const t = setup(true)
    expect(t.graph.start).toHaveBeenCalledOnce()
    expect(t.conflicts.start).toHaveBeenCalledOnce()
    expect(t.lines).toEqual([])
  })

  it('a non-publisher starts nothing until it takes over, then starts everything', () => {
    const t = setup(false)
    expect(t.graph.start).not.toHaveBeenCalled()
    expect(t.conflicts.start).not.toHaveBeenCalled()
    expect(t.lines).toEqual(['rohanz leads this checkout: its session runs the symbol graph; it starts here if this session takes over'])
    t.store.setPublisher(true)
    expect(t.graph.start).toHaveBeenCalledOnce()
    expect(t.conflicts.start).toHaveBeenCalledOnce()
    expect(t.lines.at(-1)).toBe('leading this checkout: started symbol graph, conflict checks')
  })

  it('stops only after the grace period, and a regained role in between keeps the work running', () => {
    const t = setup(true)
    t.store.setPublisher(false, 'rohanz')
    expect(t.timers).toHaveLength(1)
    expect(t.timers[0]!.ms).toBe(60_000)
    t.store.setPublisher(true)
    expect(t.timers[0]!.cleared).toBe(true)
    expect(t.graph.stop).not.toHaveBeenCalled()
    t.store.setPublisher(false, 'rohanz')
    t.timers[1]!.fn()
    expect(t.graph.stop).toHaveBeenCalledOnce()
    expect(t.conflicts.stop).toHaveBeenCalledOnce()
    expect(t.lines).toEqual(['rohanz leads this checkout: stopped symbol graph, conflict checks'])
    t.store.setPublisher(true)
    expect(t.graph.start).toHaveBeenCalledTimes(2)
  })

  it('detach stops running work; dispose stops the rest and cancels a pending stop', () => {
    const t = setup(true)
    t.detachConflicts()
    expect(t.conflicts.stop).toHaveBeenCalledOnce()
    t.store.setPublisher(false, 'rohanz')
    t.lead.dispose()
    expect(t.timers[0]!.cleared).toBe(true)
    expect(t.graph.stop).toHaveBeenCalledOnce()
    t.store.setPublisher(true)
    expect(t.graph.start).toHaveBeenCalledOnce()
    t.detachGraph()
    expect(t.graph.stop).toHaveBeenCalledOnce()
  })
})

describe('a second session in the same checkout (duplicate lead)', () => {
  let dir: string
  const sessions: Session[] = []
  const shutdowns: (() => Promise<void>)[] = []
  const prevRoomEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ROOM_')))
  const clearRoomEnv = () => { for (const k of Object.keys(process.env)) if (k.startsWith('ROOM_')) delete process.env[k] }
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString().trim()

  beforeAll(() => {
    clearRoomEnv()
    dir = mkdtempSync(join(tmpdir(), 'room-checkout-lead-'))
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'Ada')
    writeFileSync(join(dir, 'app.py'), 'def f():\n    return 1\n')
    git('add', '.'); git('commit', '-qm', 'init')
  })
  afterEach(async () => {
    for (const stop of shutdowns.splice(0).reverse()) await stop().catch(() => {})
    for (const s of sessions.splice(0).reverse()) await leaveSession(s).catch(() => {})
    vi.restoreAllMocks()
  })
  afterAll(() => { clearRoomEnv(); Object.assign(process.env, prevRoomEnv); rmSync(dir, { recursive: true, force: true }) })

  /** A joined session with its primary attachment (hooks bridge, conflict checker), as the MCP server runs it. */
  async function lead(sessionId: string) {
    const s = await joinSession({ dir, sessionId, log: () => {} })
    sessions.push(s)
    const tools = createTools({ cwd: dir, getSession: () => s, setSession: () => {} })
    tools.attachHooks(s)
    shutdowns.push(() => tools.shutdown())
    return { s, tools }
  }

  it('runs no file watcher or graph index, keeps its own-claim conflict checker, still answers tools, and starts the rest once the first leaves', async () => {
    const conflictStarts: Session[] = []
    const start = ConflictSet.prototype.start
    vi.spyOn(ConflictSet.prototype, 'start').mockImplementation(function (this: ConflictSet) {
      conflictStarts.push((this as unknown as { team: Session }).team)
      return start.call(this)
    })
    const first = await lead('lead-1')
    const second = await lead('lead-2')
    expect(second.s.me.name).not.toBe(first.s.me.name)
    expect(first.s.daemon.inputs.policy.publisher).toBe(true)
    expect(first.s.graph).toBeDefined()
    // Both sessions run a ConflictSet: the duplicate's limits itself to its own claims (ownNonPublisher).
    expect(conflictStarts).toEqual([first.s, second.s])

    // The duplicate: no checkout watcher (roomd follows the publisher lease), no graph.
    expect(second.s.daemon.inputs.policy.publisher).toBe(false)
    expect(second.s.daemon.takeWatcher()).toBeUndefined()
    expect(second.s.graph).toBeUndefined()
    expect(await second.tools.call('room_impact', { path: 'app.py' })).toContain(`${first.s.me.name} leads this checkout`)
    expect(await second.tools.call('room_state', {})).not.toMatch(/^error/)

    // The first leaves: the duplicate takes the publisher lease on its next tick and starts the graph; no new ConflictSet.
    await shutdowns.shift()!()
    sessions.splice(sessions.indexOf(first.s), 1)
    await vi.waitFor(() => expect(second.s.daemon.inputs.policy.publisher).toBe(true), { timeout: 15_000 })
    expect(second.s.graph).toBeDefined()
    expect(conflictStarts).toEqual([first.s, second.s])
    await vi.waitFor(() => expect(second.s.graph!.isReady).toBe(true), { timeout: 15_000 })
    // roomd's checkout watcher is running again for the new publisher.
    await vi.waitFor(() => expect(second.s.room.manifestHead.get(second.s.me.name)?.coverage).toEqual({ kind: 'all' }), { timeout: 15_000 })
  }, 60_000)
})
