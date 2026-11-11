import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type WebSocket from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { relayConnectionHandler, SecureSession } from '../src/index.js'
import { saveMemory } from '../src/memory.js'
import * as Y from 'yjs'

const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function common() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-retire-relay-')); dirs.push(dir); return dir }
function completed(dir: string, room: string) {
  const ledger = path.join(dir, 'room', 'relay', `migrated-${createHash('sha256').update(room).digest('hex').slice(0, 16)}.json`)
  fs.mkdirSync(path.dirname(ledger), { recursive: true }); fs.writeFileSync(ledger, '{"complete":true}\n')
  return ledger
}
class Socket extends EventEmitter {
  readonly OPEN = 1
  readyState = 1
  bufferedAmount = 0
  _receiver = { _maxPayload: 100 * 1024 * 1024 }
  frames: Buffer[] = []
  closure?: { code: number; reason: string }
  send(frame: Uint8Array, cb?: (error?: Error) => void) { this.frames.push(Buffer.from(frame)); cb?.() }
  close(code = 1000, reason = '') { this.closure ??= { code, reason }; this.readyState = 3; this.emit('close') }
  terminate() { this.close() }
}

function loadThroughRelay(dir: string, room: string) {
  const docs = new Map(), conn = new Socket()
  relayConnectionHandler(docs, { key: '', commonDir: dir })(conn as unknown as WebSocket,
    { url: '/' + encodeURIComponent(room) + '?schema=2' } as http.IncomingMessage)
  const secure = new SecureSession('', room, 'client')
  conn.emit('message', secure.clientHello(), true)
  secure.acceptRelayHello(conn.frames.shift()!)
  conn.emit('message', secure.encrypt(Uint8Array.of(0, 0, 0)), true)
  try {
    expect(conn.closure).toBeUndefined()
    expect(docs.size).toBe(1)
    expect([...docs.values()][0].doc.getMap('meta').get('schemaVersion')).toBe(2)
  } finally {
    conn.close()
    for (const d of docs.values()) { d.memory?.detach(); d.awareness.destroy(); d.doc.destroy() }
  }
}

it('accepts completed 0.17 memory when an unrelated process has reused the PID-only legacy discovery', () => {
  const dir = common(), room = 'local/repo', ledger = completed(dir, room)
  const doc = new Y.Doc(); doc.getMap('meta').set('schemaVersion', 2)
  expect(saveMemory(dir, room, doc)).toBe(true); doc.destroy()
  const discovery = path.join(dir, 'room-local.json'), before = JSON.stringify({ pid: process.pid }) + '\n'
  fs.writeFileSync(discovery, before)
  // Old discovery did not record a birth identity. The old owner has exited; this PID is now another app.
  const read = vi.spyOn(fs, 'readFileSync')
  loadThroughRelay(dir, room)
  expect(read.mock.calls.some(([file]) => file === discovery || file === ledger)).toBe(false)
  read.mockRestore()
  expect(fs.readFileSync(discovery, 'utf8')).toBe(before)
  expect(fs.readFileSync(ledger, 'utf8')).toBe('{"complete":true}\n')
})

// Removed reviewer remedy cases: old local files are ignored under the revised rule, so no local-data refusal remains.

it('keeps completed journals, old snapshots and temporary files byte-identical', () => {
  const dir = common(), room = 'local/repo', ledger = completed(dir, room)
  const old = path.join(dir, 'room-local', `${encodeURIComponent(room + '/main')}.ydoc`)
  fs.mkdirSync(path.dirname(old)); fs.writeFileSync(old, 'old source')
  const temporary = path.join(path.dirname(ledger), 'snapshot.123.tmp'); fs.writeFileSync(temporary, 'interrupted write')
  const before = [ledger, old, temporary].map(file => fs.readFileSync(file, 'utf8'))
  const read = vi.spyOn(fs, 'readFileSync')
  loadThroughRelay(dir, room)
  expect(read.mock.calls.some(([file]) => file === old)).toBe(false)
  read.mockRestore()
  expect([ledger, old, temporary].map(file => fs.readFileSync(file, 'utf8'))).toEqual(before)
})
