import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd } from '@room/roomd'
import { policyFromLevel } from '@room/roomd/policy'
import { finishSignalShutdown } from '../src/index.js'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()))

describe('roomd presence shutdown', () => {
  it('completes SIGTERM leave and logs stopped before exiting', async () => {
    const events: string[] = []
    await finishSignalShutdown('SIGTERM', async () => { events.push('lease ended'); events.push('presence cleared') },
      line => events.push(line), () => events.push('exit'))
    expect(events).toEqual(['stopping: SIGTERM', 'lease ended', 'presence cleared', 'stopped: SIGTERM', 'exit'])
  })
  it('bounds stalled cleanup and reports its pending stage without claiming completion', async () => {
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.useFakeTimers()
    const stopping = finishSignalShutdown('SIGTERM', async progress => {
      progress('worker slow: writing durable stop intent; host not yet signalled')
      await gate
    }, line => events.push(line), () => events.push('exit'))
    try {
      await vi.advanceTimersByTimeAsync(3999)
      expect(events).toEqual(['stopping: SIGTERM'])
      await vi.advanceTimersByTimeAsync(1)
      await stopping
      expect(events).toEqual(['stopping: SIGTERM',
        'shutdown timed out after 4000ms: SIGTERM; pending: worker slow: writing durable stop intent; host not yet signalled; stop records retained for recovery', 'exit'])
    } finally { release(); await stopping; vi.useRealTimers() }
  })
  it.each(['SIGINT', 'SIGTERM'])('a second %s forces exit while cleanup is pending', async signal => {
    const events: string[] = [], force = new AbortController()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.useFakeTimers()
    const stopping = finishSignalShutdown('SIGTERM', async progress => {
      progress('closing runtime binding')
      await gate
    }, line => events.push(line), () => events.push('exit'), force.signal)
    try {
      await vi.advanceTimersByTimeAsync(0)
      force.abort(signal)
      await stopping
      expect(events).toEqual(['stopping: SIGTERM',
        `shutdown forced by ${signal}: SIGTERM; pending: closing runtime binding; stop records retained for recovery`, 'exit'])
      expect(vi.getTimerCount()).toBe(0)
    } finally { release(); await stopping; vi.useRealTimers() }
  })
  it('reports a cleanup error before exiting', async () => {
    const events: string[] = []
    await finishSignalShutdown('SIGTERM', async () => { throw new Error('cleanup failed') },
      line => events.push(line), () => events.push('exit'))
    expect(events).toEqual(['stopping: SIGTERM', 'shutdown error: cleanup failed; pending: session cleanup', 'exit'])
  })
  it('publishes a null awareness state before disconnecting', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-presence-stop-'))
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
    fs.writeFileSync(path.join(dir, 'app.txt'), 'base\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    const remoteDoc = new Y.Doc(), remote = new Awareness(remoteDoc)
    cleanup.push(() => { remote.destroy(); remoteDoc.destroy() })
    const providerFactory = (_server: string, _room: string, doc: Y.Doc): WebsocketProvider => {
      const events = new EventEmitter(), awareness = new Awareness(doc)
      awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const clients = [...added, ...updated, ...removed]
        applyAwarenessUpdate(remote, encodeAwarenessUpdate(awareness, clients), 'test')
      })
      return Object.assign(events, {
        synced: true,
        awareness,
        ws: { bufferedAmount: 0 },
        destroy() { awareness.destroy(); events.removeAllListeners() },
      }) as unknown as WebsocketProvider
    }
    const daemon = await startRoomd({ room: 'ws://memory/test', dir, name: 'Rohan', kind: 'agent', providerFactory, policy: policyFromLevel('full'), log: () => {} })
    expect(Array.from(remote.getStates().values()).some(state => state.user?.name === 'Rohan')).toBe(true)
    await daemon.stop()
    expect(Array.from(remote.getStates().values()).some(state => state.user?.name === 'Rohan')).toBe(false)
  })
})
