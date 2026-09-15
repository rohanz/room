import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd } from '@room/roomd'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()))

describe('roomd presence shutdown', () => {
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
    const daemon = await startRoomd({ room: 'ws://memory/test', dir, name: 'Rohan', kind: 'agent', providerFactory, log: () => {} })
    expect(Array.from(remote.getStates().values()).some(state => state.user?.name === 'Rohan')).toBe(true)
    await daemon.stop()
    expect(Array.from(remote.getStates().values()).some(state => state.user?.name === 'Rohan')).toBe(false)
  })
})
