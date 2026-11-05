import { requireWorkerInventory } from '../src/worker-store.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomDoc } from '@room/shared'
import { WorkerRegistry } from '../src/worker-registry.js'
import type { WorkerSnapshot, WorkerStore } from '../src/worker-store.js'
import { joinedPresenceWorkers, PresenceEnd, releaseIdleHeld, IDLE_CLAIMS_MS, IDLE_LEASE_MS } from '../src/presence-end.js'
import { withToolSignal, toolCallAborted } from '../src/registry.js'
import type { Session } from '../src/session.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const empty: WorkerSnapshot = { available: true, revision: 'empty', workers: [], reservations: {}, blockers: [] }
const unavailable: WorkerSnapshot = { available: false, reason: 'unavailable', detail: 'service restarting' }
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const sessions = [{ dir: '/never-open-this-directory', roomName: 'local/test', me: { name: 'lead' } }] as Session[]

describe('async lifecycle boundaries', () => {
  it.todo('slice 2: rejects an unrelated stop call while another call in the same MCP holds discard, while nested discard-to-stop reuses the outer ticket and cannot release it')

  it('keeps unavailable facts distinct from an empty snapshot and holds presence until a delayed decision resolves', async () => {
    const facts = deferred<WorkerSnapshot>(), entered = deferred<void>()
    const command = vi.fn<WorkerStore['command']>().mockRejectedValue(new Error('not authorized'))
    const registry = WorkerRegistry.fromStore({ snapshot: () => { entered.resolve(); return facts.promise }, command })
    const hasWorkers = joinedPresenceWorkers(sessions, async () => (requireWorkerInventory(await registry.list())).length > 0)
    await entered.promise
    let resolved = false
    void hasWorkers.then(() => { resolved = true })
    await Promise.resolve()
    expect(resolved).toBe(false)
    facts.resolve(unavailable)
    expect(await hasWorkers).toBe(true)
    await expect(registry.list()).rejects.toThrow('snapshot unavailable')
    expect(command).not.toHaveBeenCalled()
    const emptyRegistry = WorkerRegistry.fromStore({ snapshot: async () => empty, command })
    expect(await joinedPresenceWorkers(sessions, async () => (requireWorkerInventory(await emptyRegistry.list())).length > 0)).toBe(false)
  })

  it('does not expire an idle lead on an asynchronous unavailable snapshot', async () => {
    const facts = deferred<boolean>(), leave = vi.fn()
    let now = 0
    const presence = new PresenceEnd({ hostKind: 'shared-app-server', episodeId: 'async-boundary', tickMs: 0, mono: () => now,
      holds: () => false, waiting: () => false, hostAlive: () => undefined,
      leadsWorkers: () => facts.promise, hostEnded: () => {}, releaseHeld: async () => {}, leave,
    })
    try {
      now = 2 * IDLE_LEASE_MS
      const tick = presence.tick()
      await Promise.resolve()
      expect(leave).not.toHaveBeenCalled()
      facts.resolve(true) // joinedPresenceWorkers conservatively returns true for unavailable service.
      await tick
      expect(leave).not.toHaveBeenCalled()
      expect(presence.hasLeft).toBe(false)
    } finally { presence.stop() }
  })

  it('retains distinct concurrent tool-call contexts across delayed snapshot awaits', async () => {
    const first = deferred<WorkerSnapshot>(), second = deferred<WorkerSnapshot>()
    let count = 0
    const registry = WorkerRegistry.fromStore({ snapshot: () => (++count === 1 ? first.promise : second.promise),
      command: vi.fn<WorkerStore['command']>().mockRejectedValue(new Error('not authorized')) })
    const cancelled = new AbortController(), sibling = new AbortController()
    const observed: boolean[][] = []
    const invoke = (signal: AbortSignal) => withToolSignal(signal, async () => {
      const before = toolCallAborted()
      const snapshot = await registry.snapshot()
      const after = toolCallAborted()
      observed.push([before, after])
      return snapshot
    })
    const a = invoke(cancelled.signal), b = invoke(sibling.signal)
    cancelled.abort()
    // Resolve in the opposite order: a module/global current-context slot would leak cancellation.
    second.resolve(empty)
    expect(await b).toEqual(empty)
    first.resolve(unavailable)
    expect(await a).toEqual(unavailable)
    expect(observed).toEqual([[false, false], [false, true]])
    expect(toolCallAborted()).toBe(false)
  })

  it.each([false, true])('pure idle release does not initialize lifecycle storage (pendingOnly=%s)', async pendingOnly => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-idle-no-lifecycle-')); roots.push(dir)
    execFileSync('git', ['init', '-q', dir])
    const doc = new RoomDoc()
    doc.participants.set('lead\0holder', { sessionId: 'idle-session', epoch: 1 })
    const claim = doc.addClaim({ by: 'lead', byKind: 'agent', path: 'x', from: 1, to: 1, intent: 'work' })
    const open = vi.spyOn(WorkerRegistry, 'open')
    const post = vi.fn().mockResolvedValue({ ok: true })
    const session = { dir, room: doc, roomName: 'local/test', me: { name: 'lead', kind: 'agent' },
      lease: { sessionId: 'idle-session', fence: () => '1' }, post } as unknown as Session
    try {
      expect(await releaseIdleHeld(session, 'epoch', IDLE_CLAIMS_MS, () => IDLE_CLAIMS_MS, pendingOnly)).toBe(!pendingOnly)
      expect(doc.claims.has(claim.id)).toBe(pendingOnly)
      expect(post).toHaveBeenCalledTimes(pendingOnly ? 0 : 1)
      expect(open).not.toHaveBeenCalled()
      expect(fs.existsSync(path.join(dir, '.git', 'room', 'registry'))).toBe(false)
      if (!pendingOnly) expect(fs.readdirSync(path.join(dir, '.git', 'room', 'sessions', 'idle-session', 'idle-claims'))).toHaveLength(1)
    } finally { doc.doc.destroy() }
  })
})
