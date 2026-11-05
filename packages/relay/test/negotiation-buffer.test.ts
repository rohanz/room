import { expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as sync from 'y-protocols/sync'
import { CURRENT_COMPAT, decodeFrame, encodeFrame } from '@room/hub-core'
import WebSocket from 'ws'
import { AuthorityLock, localProofHeader, SecureSession, startRelay } from '../src/index.js'

it('bounds fragmented encrypted bootstrap input before a complete websocket message arrives', async () => {
  const key = 'bootstrap-key', room = 'local/buffer', log: string[] = []
  const relay = await startRelay(0, { key, log: line => log.push(line) })
  const resource = `/${encodeURIComponent(room)}?schema=2&negotiate=1`
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}${resource}`, { headers: { authorization: localProofHeader(key, 'GET', resource, relay.port) } })
  const secure = new SecureSession(key, room, 'client')
  ws.on('error', () => {})
  try {
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const hello = new Promise<Buffer>(resolve => ws.once('message', frame => resolve(Buffer.from(frame as Buffer))))
    ws.send(secure.clientHello())
    secure.acceptRelayHello(await hello)
    const closed = new Promise<number>(resolve => ws.once('close', code => resolve(code)))
    // No final fragment: application-level message handlers cannot see these bytes yet.
    ws.send(Buffer.alloc(6000), { fin: false })
    ws.send(Buffer.alloc(3000), { fin: false })
    expect(await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve('not bounded'), 1000))])).toBeTypeOf('number')
    expect(log.join('\n')).toContain('Max payload size exceeded')
  } finally { ws.terminate(); await relay.close() }
})

it('restores the document payload limit after a negotiated encrypted ACK', async () => {
  const commonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-bootstrap-restore-'))
  const key = 'bootstrap-key', room = 'local/restore'
  const relay = await startRelay(0, { key, commonDir, hub: { lock: AuthorityLock.take(commonDir)! } })
  const resource = `/${encodeURIComponent(room)}?schema=2&gen=fresh&negotiate=1`
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}${resource}`, { headers: { authorization: localProofHeader(key, 'GET', resource, relay.port) } })
  const secure = new SecureSession(key, room, 'client'), received: Buffer[] = []
  let secured = false
  ws.on('error', () => {})
  ws.on('message', raw => {
    if (!secured) { secure.acceptRelayHello(raw as Buffer); secured = true }
    else received.push(secure.decrypt(raw as Buffer))
  })
  const doc = new Y.Doc()
  try {
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    ws.send(secure.clientHello())
    await vi.waitFor(() => expect(secured).toBe(true))
    ws.send(secure.encrypt(encodeFrame({ v: 1, id: 'h', op: 'compat-hello', sessionId: 'restore', offer: CURRENT_COMPAT })))
    await vi.waitFor(() => expect(received).toHaveLength(1))
    const selected = decodeFrame(received.shift()!) as { selectionId: string }
    ws.send(secure.encrypt(encodeFrame({ v: 1, id: 'a', op: 'compat-ack', selectionId: selected.selectionId })))
    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(2))
    expect(decodeFrame(received.shift()!)).toEqual({ v: 1, re: 'a', ok: true })
    received.length = 0
    ws.send(secure.encrypt(encodeFrame({ v: 1, id: 'r', op: 'release', name: 'ada', epoch: 1 })))
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0))
    const operation = decodeFrame(received.shift()!) as { reason?: string }
    expect(operation).toMatchObject({ re: 'r', ok: false })
    expect(operation.reason).not.toBe('hello-first')
    const text = 'x'.repeat(16 * 1024)
    doc.getText('large').insert(0, text)
    const frame = encoding.createEncoder()
    encoding.writeVarUint(frame, 0)
    sync.writeUpdate(frame, Y.encodeStateAsUpdate(doc))
    ws.send(secure.encrypt(encoding.toUint8Array(frame)))
    await vi.waitFor(() => expect(relay.hubRoom(room)?.doc.doc.getText('large').toString()).toBe(text))
    expect(ws.readyState).toBe(WebSocket.OPEN)
  } finally { doc.destroy(); ws.terminate(); await relay.close(); fs.rmSync(commonDir, { recursive: true, force: true }) }
})
