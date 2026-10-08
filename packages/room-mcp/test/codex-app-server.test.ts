import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { codexControlSocket, postCodexToolOutput } from '../src/codex-app-server.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

async function daemon(status: string, error?: string, silent = false, turnError?: string, turnStatus = 'inProgress') {
  const dir = mkdtempSync(join(tmpdir(), 'room-rpc-'))
  const socketPath = join(dir, 'control.sock')
  const server = http.createServer()
  const ws = new WebSocketServer({ server })
  ws.on('error', () => {}) // the HTTP server's listen error rejects below
  const calls: any[] = []
  let closed = false
  cleanup.push(async () => {
    for (const client of ws.clients) client.terminate()
    ws.close()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  })
  ws.on('connection', client => {
    client.on('close', () => { closed = true })
    client.on('message', data => {
      const request = JSON.parse(String(data)); calls.push(request)
      if (silent || request.id === undefined) return
      const result = request.method === 'initialize' ? {} : request.method === 'thread/read'
        ? { thread: { status: { type: status } } } : { turn: { id: 'active-turn', status: turnStatus } }
      client.send(JSON.stringify(turnError && request.method === 'turn/start'
        ? { id: request.id, error: { code: -32600, message: turnError } } : error && request.method === 'thread/read'
        ? { id: request.id, error: { code: -32600, message: error } } : { id: request.id, result }))
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  return { socketPath, calls, closed: () => closed }
}

it('initializes and joins the active turn with tool authority', async () => {
  const d = await daemon('active')
  expect(await postCodexToolOutput({ socketPath: d.socketPath, threadId: 'thread', text: 'pointer', clientVersion: '0.17.11' })).toEqual({ kind: 'joined', turnId: 'active-turn' })
  expect(d.calls.map(c => c.method)).toEqual(['initialize', 'initialized', 'thread/read', 'turn/start'])
  expect(d.calls[0].params.clientInfo).toEqual({ name: 'room', version: '0.17.11' })
  expect(d.calls[1]).toEqual({ method: 'initialized', params: {} })
  expect(d.calls[2].params).toEqual({ threadId: 'thread', includeTurns: false })
  expect(d.calls[3].params).toEqual({ threadId: 'thread', input: [], toolOutput: { name: 'room_notify', namespace: 'room', output: 'pointer' } })
})

it.each(['idle', 'notLoaded', 'systemError'])('does not start a turn for %s', async status => {
  const d = await daemon(status)
  expect(await postCodexToolOutput({ socketPath: d.socketPath, threadId: 'thread', text: 'pointer' })).toEqual({ kind: 'idle' })
  expect(d.calls.some(c => c.method === 'turn/start')).toBe(false)
})

it('returns the JSON-RPC error for unknown threads', async () => {
  const d = await daemon('active', 'thread not found')
  expect(await postCodexToolOutput({ socketPath: d.socketPath, threadId: 'unknown', text: 'pointer' })).toEqual({ kind: 'unavailable', reason: 'thread not found' })
})

it('reports missing sockets without throwing', async () => {
  expect(codexControlSocket({ CODEX_HOME: '/missing-room-codex-home' })).toBeUndefined()
  expect(await postCodexToolOutput({ socketPath: '/missing-room-codex.sock', threadId: 'thread', text: 'pointer' })).toMatchObject({ kind: 'unavailable' })
})

it('times out and closes a silent connection', async () => {
  const d = await daemon('active', undefined, true)
  expect(await postCodexToolOutput({ socketPath: d.socketPath, threadId: 'thread', text: 'pointer', timeoutMs: 40 })).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('timed out') })
  await vi.waitFor(() => expect(d.closed()).toBe(true))
})



it('returns unavailable when active turn/start fails', async () => {
  const d = await daemon('active', undefined, false, 'turn rejected')
  expect(await postCodexToolOutput({ socketPath: d.socketPath, threadId: 'thread', text: 'pointer' })).toEqual({ kind: 'unavailable', reason: 'turn rejected' })
  expect(d.calls.map(c => c.method)).toContain('turn/start')
})

it('returns unavailable for a turn that is not inProgress', async () => {
  const d = await daemon('active', undefined, false, undefined, 'completed')
  expect(await postCodexToolOutput({ socketPath: d.socketPath, threadId: 'thread', text: 'pointer' })).toEqual({ kind: 'unavailable', reason: 'Codex app-server returned an invalid turn' })
})

describe('in-memory daemon protocol', () => {
  function fake(status = 'active', error?: string, silent = false, turnError?: string, turnStatus = 'inProgress') {
    const calls: any[] = []
    let closed = false
    class Socket extends EventEmitter {
      constructor(_url: string) { super(); queueMicrotask(() => this.emit('open')) }
      terminate() { closed = true }
      send(data: string) {
        const request = JSON.parse(data); calls.push(request)
        if (silent || !request.id) return
        queueMicrotask(() => this.emit('message', JSON.stringify(turnError && request.method === 'turn/start'
          ? { id: request.id, error: { message: turnError } } : error && request.method === 'thread/read'
          ? { id: request.id, error: { message: error } }
          : { id: request.id, result: request.method === 'initialize' ? {} : request.method === 'thread/read'
            ? { thread: { status: { type: status } } } : { turn: { id: 'turn', status: turnStatus } } })))
      }
    }
    return { calls, closed: () => closed, WebSocket: Socket as unknown as typeof WebSocket }
  }
  it.each([undefined, '0.17.11'])('joins active output with client version %s and closes', async clientVersion => {
    const d = fake()
    expect(await postCodexToolOutput({ socketPath: '/fake', threadId: 'thread', text: 'pointer', WebSocket: d.WebSocket, clientVersion })).toEqual({ kind: 'joined', turnId: 'turn' })
    expect(d.calls.map(c => c.method)).toEqual(['initialize', 'initialized', 'thread/read', 'turn/start'])
    expect(d.calls[0].params.clientInfo.version).toBe(clientVersion ?? '0.0.0')
    expect(d.calls[3].params).toEqual({ threadId: 'thread', input: [], toolOutput: { name: 'room_notify', namespace: 'room', output: 'pointer' } })
    expect(d.closed()).toBe(true)
  })
  it.each(['idle', 'notLoaded', 'systemError'])('closes without starting %s', async status => {
    const d = fake(status)
    expect(await postCodexToolOutput({ socketPath: '/fake', threadId: 'thread', text: 'pointer', WebSocket: d.WebSocket })).toEqual({ kind: 'idle' })
    expect(d.calls.map(c => c.method)).not.toContain('turn/start')
    expect(d.closed()).toBe(true)
  })
  it('preserves RPC errors and closes', async () => {
    const d = fake('active', 'thread not found')
    expect(await postCodexToolOutput({ socketPath: '/fake', threadId: 'thread', text: 'pointer', WebSocket: d.WebSocket })).toEqual({ kind: 'unavailable', reason: 'thread not found' })
    expect(d.closed()).toBe(true)
  })
  it('closes on handshake timeout', async () => {
    const d = fake('active', undefined, true)
    expect(await postCodexToolOutput({ socketPath: '/fake', threadId: 'thread', text: 'pointer', WebSocket: d.WebSocket, timeoutMs: 10 })).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('timed out') })
    expect(d.closed()).toBe(true)
  })
  it('returns unavailable when active turn/start fails and closes', async () => {
    const d = fake('active', undefined, false, 'turn rejected')
    expect(await postCodexToolOutput({ socketPath: '/fake', threadId: 'thread', text: 'pointer', WebSocket: d.WebSocket })).toEqual({ kind: 'unavailable', reason: 'turn rejected' })
    expect(d.calls.map(c => c.method)).toContain('turn/start')
    expect(d.closed()).toBe(true)
  })
  it('returns unavailable for a turn that is not inProgress and closes', async () => {
    const d = fake('active', undefined, false, undefined, 'completed')
    expect(await postCodexToolOutput({ socketPath: '/fake', threadId: 'thread', text: 'pointer', WebSocket: d.WebSocket })).toEqual({ kind: 'unavailable', reason: 'Codex app-server returned an invalid turn' })
    expect(d.closed()).toBe(true)
  })
  it('handles constructor failure', async () => {
    class Socket { constructor() { throw new Error('connect failed') } }
    expect(await postCodexToolOutput({ socketPath: '/fake', threadId: 'thread', text: 'pointer', WebSocket: Socket as unknown as typeof WebSocket })).toEqual({ kind: 'unavailable', reason: 'connect failed' })
  })
})
