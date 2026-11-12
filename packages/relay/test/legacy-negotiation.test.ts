import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type http from 'node:http'
import type { WebSocket } from 'ws'
import { decodeFrame, legacyAdvertisement, legacyHello, selectContract, CURRENT_COMPAT } from '@room/hub-core'
import { readRelayInfo, relayConnectionHandler, relayFile, SecureSession } from '../src/index.js'

// Captured from pinned 0.17.32 SecureSession, with fixed nonces; no current protocol constants generate the fixture.
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/0.17.32-first-frames.json', import.meta.url), 'utf8'))
const bytes = (name: string) => Buffer.from(fixture[name], 'hex')
const cleanup: Array<() => void> = []
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) close() })

describe('pinned 0.17.32 local relay first-frame replay', () => {
  it('a negotiating client selects the exact legacy adapter from released discovery and accepts its encrypted first frame', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-legacy-replay-'))
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    fs.mkdirSync(path.dirname(relayFile(dir)))
    fs.writeFileSync(relayFile(dir), JSON.stringify(fixture.discovery))
    expect(readRelayInfo(dir)).toEqual(fixture.discovery)
    const legacy = legacyAdvertisement(fixture.health)!
    expect(selectContract(CURRENT_COMPAT, legacy, { activeSchema: 2 })).toMatchObject({ ok: true, selection: { hub: 1, schema: 2 } })
    expect(legacyHello('legacy-h', 'fixture', 'legacy-session')).toEqual(fixture.hello)
    const secure = new SecureSession(fixture.key, fixture.room, 'client')
    expect(secure.clientHello(Buffer.alloc(16, 1))).toEqual(bytes('clientHello'))
    secure.acceptRelayHello(bytes('relayHello'))
    expect(secure.decrypt(bytes('relaySync'))).toEqual(Buffer.from([0, 0, 0]))
  })

  it('a negotiating relay accepts the released encrypted sync and exact legacy hub hello with no negotiation ACK', () => {
    const frames: Buffer[] = [], closed = vi.fn()
    const socket = new EventEmitter() as EventEmitter & Record<string, unknown>
    Object.assign(socket, { OPEN: 1, CLOSED: 3, readyState: 1, bufferedAmount: 0, close: closed, send: (frame: Uint8Array, callback?: () => void) => { frames.push(Buffer.from(frame)); callback?.() } })
    const docs = new Map() as Parameters<typeof relayConnectionHandler>[0]
    cleanup.push(() => { socket.emit('close'); for (const d of docs.values()) { d.awareness.destroy(); d.doc.destroy() } })
    vi.spyOn(crypto, 'randomBytes').mockImplementation((() => bytes('relayNonce')) as typeof crypto.randomBytes)
    relayConnectionHandler(docs, { key: fixture.key })(socket as unknown as WebSocket, { url: `/${encodeURIComponent(fixture.room)}?schema=2&gen=fresh` } as http.IncomingMessage)
    socket.emit('message', bytes('clientHello'), true)
    expect(frames.shift()).toEqual(bytes('relayHello'))
    socket.emit('message', bytes('clientSync'), true)
    expect(docs.size).toBe(1)
    socket.emit('message', bytes('clientHubHello'), true)
    const client = new SecureSession(fixture.key, fixture.room, 'client')
    client.clientHello(Buffer.alloc(16, 1)); client.acceptRelayHello(bytes('relayHello'))
    const plain = frames.map(frame => client.decrypt(frame))
    expect(plain[0][0]).toBe(0) // Legacy automatic sync precedes hub hello, exactly as released.
    expect(decodeFrame(plain.at(-1)!)).toMatchObject({ v: 1, re: 'legacy-h', ok: false, reason: 'not-authority' })
    expect(closed).not.toHaveBeenCalled()
  })
})
