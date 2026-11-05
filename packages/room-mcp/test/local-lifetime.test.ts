import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Awareness } from 'y-protocols/awareness'
import { policyFromLevel, startRoomd } from '@room/roomd'
import type { WebsocketProvider } from 'y-websocket'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc } from '@room/shared'
import { detachCheckout, leaveSession, watchLocalDaemon, type Session } from '../src/session.js'
import { createHandlerState } from '../src/tools/state.js'
import { handlers as joinHandlers } from '../src/tools/join.js'
import { PresenceEnd } from '../src/presence-end.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); vi.useRealTimers() })

function fixture() {
  const doc = new Y.Doc()
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const provider = {
    serverUrl: 'ws://127.0.0.1:1', wsconnected: false, synced: false,
    on: (event: string, fn: (...args: any[]) => void) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(fn) },
    off: (event: string, fn: (...args: any[]) => void) => listeners.get(event)?.delete(fn),
    connect: vi.fn(), disconnect: vi.fn(),
  }
  const local = { url: provider.serverUrl, key: 'stable-clone-key', stop: vi.fn(), port: 1, pid: 123, idleMs: 300_000, runtime: 'daemon' }
  const s = { room: new RoomDoc(doc), provider, local, roomName: 'local/x', roomUrl: `${provider.serverUrl}/local%2Fx`, browserUrl: '', me: { name: 'Ada' }, daemon: { stop: vi.fn(async () => {}) } } as unknown as Session
  return { s, doc, provider, local, close: () => { for (const fn of listeners.get('connection-close') ?? []) fn({ code: 1006 }) } }
}

describe('local client replica lifetime', () => {
  it.each([1, 2])('rebinds the actual session provider to port %s without replacing its unsaved replica', async port => {
    const f = fixture()
    f.doc.getMap('mail').set('unsaved', 'only surviving replica')
    const destroy = vi.spyOn(f.doc, 'destroy')
    const next = { ...f.local, port, url: `ws://127.0.0.1:${port}` }
    const ensure = vi.fn(async () => next as NonNullable<Session['local']>)
    cleanups.push(watchLocalDaemon(f.s, ensure, { retryMs: 5 }))
    f.close()
    await vi.waitFor(() => expect(f.provider.connect).toHaveBeenCalled())
    expect(f.s.room.doc).toBe(f.doc)
    expect(f.s.provider).toBe(f.provider)
    expect(f.provider.serverUrl).toBe(next.url)
    expect(f.s.roomUrl).toBe(`${next.url}/local%2Fx`)
    expect(f.doc.getMap('mail').get('unsaved')).toBe('only surviving replica')
    expect(destroy).not.toHaveBeenCalled()
  })

  it('refreshes daemon identity after an automatic same-port reconnect without disconnecting the live provider', async () => {
    const f = fixture()
    const next = { ...f.local, pid: 456 }
    const ensure = vi.fn(async () => next as NonNullable<Session['local']>)
    cleanups.push(watchLocalDaemon(f.s, ensure, { retryMs: 5 }))
    f.close()
    f.provider.wsconnected = true
    await vi.waitFor(() => expect(f.s.local).toBe(next))
    expect(f.provider.disconnect).not.toHaveBeenCalled()
    expect(f.doc.isDestroyed).toBe(false)
  })

  it('retains the document after failed recovery and ignores an ensure result that arrives after cancellation', async () => {
    const f = fixture()
    const destroy = vi.spyOn(f.doc, 'destroy')
    let finish!: (local: NonNullable<Session['local']>) => void
    const ensure = vi.fn().mockRejectedValueOnce(new Error('launch denied')).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const stop = watchLocalDaemon(f.s, ensure, { retryMs: 5 })
    cleanups.push(stop)
    f.close()
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(2))
    stop()
    finish({ ...f.local, url: 'ws://127.0.0.1:3', port: 3 } as NonNullable<Session['local']>)
    await Promise.resolve(); await Promise.resolve()
    expect(f.provider.connect).not.toHaveBeenCalled()
    expect(destroy).not.toHaveBeenCalled()
  })

  it.each([false, true])('retirement preserves by default; explicit leave disposes even after detachment=%s', async detached => {
    const f = fixture()
    const destroy = vi.spyOn(f.doc, 'destroy')
    if (detached) detachCheckout(f.s)
    await leaveSession(f.s)
    expect(destroy).not.toHaveBeenCalled()
    await leaveSession(f.s, { preserveReplica: false })
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(f.local.stop).toHaveBeenCalled() // monitoring only; no owner stop API
  })

  it('idle expiry drops transport, caches the detached checkout and retains the sole replica', async () => {
    const f = fixture()
    f.s.localReplica = { doc: f.doc }
    f.doc.getMap('mail').set('unsaved', 'only surviving replica')
    const watcher = { dispose: vi.fn(async () => {}) }
    const takeWatcher = vi.fn(() => watcher)
    f.s.daemon.takeWatcher = takeWatcher as NonNullable<Session['daemon']['takeWatcher']>
    let session: Session | null = f.s
    const state = createHandlerState({ getSession: () => session, setSession: s => { session = s }, cwd: '/unused', log: () => {} })
    let now = 0
    const presence = new PresenceEnd({
      hostKind: 'shared-app-server', episodeId: 'test', tickMs: 0, mono: () => now, idleLeaseMs: 10,
      hostAlive: () => true, holds: () => false, leadsWorkers: () => false, waiting: () => false,
      hostEnded: vi.fn(), releaseHeld: async () => {},
      leave: async () => { for (const s of state.rooms.all().reverse()) await state.drop(s, 'idle lease') },
    })
    now = 10
    await presence.tick()
    expect(presence.hasLeft).toBe(true)
    expect(session).toBeNull()
    expect(f.s.daemon.stop).toHaveBeenCalledTimes(1)
    expect(f.doc.isDestroyed).toBe(false)
    expect(f.doc.getMap('mail').get('unsaved')).toBe('only surviving replica')
    expect(detachCheckout(f.s)).toMatchObject({ replica: f.s.localReplica, watcher })
    expect(takeWatcher).toHaveBeenCalledTimes(1)
    await leaveSession(f.s, { preserveReplica: false })
    expect(watcher.dispose).toHaveBeenCalledTimes(1)
    expect(f.doc.isDestroyed).toBe(true)
  })

  it('the explicit room_leave handler disposes a previously detached replica', async () => {
    const f = fixture()
    f.s.localReplica = { doc: f.doc }
    detachCheckout(f.s)
    let session: Session | null = f.s
    const state = createHandlerState({ getSession: () => session, setSession: s => { session = s }, cwd: '/unused', log: () => {} })
    state.runningWorkers = () => []
    state.closeWorkersRoom = async () => {}
    state.cleanupMine = () => 0
    expect(await joinHandlers(state).room_leave({})).toContain('left local/x')
    expect(session).toBeNull()
    expect(f.s.localReplica.disposed).toBe(true)
    expect(f.doc.isDestroyed).toBe(true)
  })
  it('exhausts bounded background retries, retains its replica, and retries when explicitly requested', async () => {
    const f = fixture()
    const ensure = vi.fn().mockRejectedValue(new Error('daemon unavailable'))
    const stop = watchLocalDaemon(f.s, ensure, { retryMs: 5, maxAttempts: 2 })
    cleanups.push(stop)
    f.close()
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(2))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(ensure).toHaveBeenCalledTimes(2)
    expect(f.doc.isDestroyed).toBe(false)
    await f.s.recoverLocal!()
    expect(ensure).toHaveBeenCalledTimes(3)
    stop()
  })

  it('roomd failed initialization disposes its provider while preserving the caller-owned replica', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'room-client-start-failure-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const doc = new Y.Doc()
    doc.getMap('mail').set('surviving', 'retained across startup failure')
    const awareness = new Awareness(doc)
    const destroy = vi.fn()
    const provider = { awareness, on() {}, off() {}, destroy, synced: true } as unknown as WebsocketProvider
    await expect(startRoomd({ dir, room: 'ws://memory/local', name: 'Ada', replica: doc, policy: policyFromLevel('intent'),
      providerFactory: (_server, _room, actual) => { expect(actual).toBe(doc); return provider }, log: () => {},
    })).rejects.toThrow('not a git repository')
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(doc.isDestroyed).toBe(false)
    expect(doc.getMap('mail').get('surviving')).toBe('retained across startup failure')
    doc.destroy()
  })

})
