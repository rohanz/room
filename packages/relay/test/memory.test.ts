import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { loadMemory, memoryFile, RoomMemory, saveMemory, MAX_MEMORY_BYTES } from '../src/memory.js'

let dir: string
const docs: Y.Doc[] = []
const memories: RoomMemory[] = []
const log = vi.fn()
const room = 'local/repo/branch with % space'
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-memory-')); log.mockClear() })
afterEach(() => {
  vi.restoreAllMocks()
  for (const memory of memories.splice(0)) memory.close()
  for (const doc of docs.splice(0)) doc.destroy()
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
})
const open = () => { const m = new RoomMemory(dir, room, log); memories.push(m); docs.push(m.doc); return m }
const load = () => { const d = loadMemory(dir, room, log); docs.push(d); return d }

it('saves on close and a new relay memory instance restores only memory with private modes', () => {
  const first = open()
  for (const type of ['bus', 'retiredWorkers']) first.doc.getArray(type).push([{ id: type }])
  for (const type of ['workers', 'scopes', 'colors', 'meta', 'ledger']) first.doc.getMap(type).set('key', { value: type })
  for (const type of ['overlays', 'deleted', 'basetext', 'graphs', 'claims']) first.doc.getMap(type).set('stale', 'text')
  first.close()
  const second = open()
  expect(second.doc.getArray('bus').toArray()).toEqual([{ id: 'bus' }])
  expect(second.doc.getArray('retiredWorkers').toArray()).toEqual([{ id: 'retiredWorkers' }])
  for (const type of ['workers', 'scopes', 'colors', 'meta', 'ledger']) expect(second.doc.getMap(type).get('key')).toEqual({ value: type })
  for (const type of ['overlays', 'deleted', 'basetext', 'graphs', 'claims']) expect(second.doc.share.has(type)).toBe(false)
  expect(fs.statSync(memoryFile(dir, room)).mode & 0o777).toBe(0o600)
  expect(fs.statSync(path.join(dir, 'room-local')).mode & 0o777).toBe(0o700)
})
it('debounces for 2s and saves at least every 10s under constant changes', () => {
  vi.useFakeTimers()
  const memory = open(), bus = memory.doc.getArray('bus')
  bus.push([0]); vi.advanceTimersByTime(1999)
  expect(fs.existsSync(memoryFile(dir, room))).toBe(false)
  vi.advanceTimersByTime(1)
  expect(load().getArray('bus').length).toBe(1)
  for (let i = 1; i <= 10; i++) { bus.push([i]); vi.advanceTimersByTime(1000) }
  expect(load().getArray('bus').length).toBe(11)
})
it('quarantines corrupt files and starts empty, logging once', () => {
  fs.mkdirSync(path.dirname(memoryFile(dir, room)))
  fs.writeFileSync(memoryFile(dir, room), new Uint8Array([255, 255, 255]))
  expect(load().share.size).toBe(0)
  expect(fs.readdirSync(path.join(dir, 'room-local'))).toEqual([expect.stringMatching(/\.ydoc\.corrupt-\d+$/)])
  expect(load().share.size).toBe(0)
  expect(log).toHaveBeenCalledTimes(1)
})
it('treats unreadable snapshots like corruption', () => {
  const memory = open(); memory.flush()
  vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })
  expect(load().share.size).toBe(0)
  expect(log).toHaveBeenCalledTimes(1)
  expect(fs.existsSync(memoryFile(dir, room))).toBe(false)
})
it.each(['write', 'rename'])('preserves the old file and removes temporary files when %s fails', phase => {
  const memory = open(); memory.doc.getArray('bus').push(['old']); memory.flush()
  const original = fs.readFileSync(memoryFile(dir, room))
  memory.doc.getArray('bus').push(['new'])
  if (phase === 'rename') vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('rename failed') })
  else {
    const write = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((file, data, options) => {
      write(file, new Uint8Array([1]), options); throw new Error('partial write failed')
    })
  }
  expect(saveMemory(dir, room, memory.doc, log)).toBe(false)
  expect(fs.readFileSync(memoryFile(dir, room))).toEqual(original)
  expect(fs.readdirSync(path.join(dir, 'room-local'))).toEqual([path.basename(memoryFile(dir, room))])
})
it('skips snapshots larger than 5MB and keeps the last good file', () => {
  const memory = open(); memory.flush()
  const original = fs.readFileSync(memoryFile(dir, room))
  memory.doc.getMap('meta').set('large', 'x'.repeat(MAX_MEMORY_BYTES))
  expect(saveMemory(dir, room, memory.doc, log)).toBe(false)
  expect(fs.readFileSync(memoryFile(dir, room))).toEqual(original)
  expect(log).toHaveBeenCalledWith(expect.stringContaining('exceeds 5 MB'))
})
it('forget removes only this room and prevents pending or shutdown saves from recreating it', () => {
  vi.useFakeTimers()
  const memory = open(); memory.doc.getArray('bus').push(['kept']); memory.flush()
  saveMemory(dir, 'other', memory.doc, log)
  memory.doc.getArray('bus').push(['pending']); memory.forget()
  expect(memory.doc.getArray('bus').length).toBe(0)
  memory.doc.getArray('bus').push(['late client']); vi.advanceTimersByTime(15000); memory.close()
  expect(fs.existsSync(memoryFile(dir, room))).toBe(false)
  expect(fs.existsSync(memoryFile(dir, 'other'))).toBe(true)
})
it('does not duplicate history when an existing client reconnects after a relay takeover', () => {
  const client = new Y.Doc(); docs.push(client)
  client.getArray('bus').push([{ id: 'event-1' }])
  client.getArray('retiredWorkers').push([{ name: 'worker', lead: 'lead', startedAt: 1 }])
  saveMemory(dir, room, client, log)
  const relay = open()
  Y.applyUpdate(relay.doc, Y.encodeStateAsUpdate(client))
  Y.applyUpdate(client, Y.encodeStateAsUpdate(relay.doc))
  expect(client.getArray('bus').toArray()).toEqual([{ id: 'event-1' }])
  expect(relay.doc.getArray('retiredWorkers').length).toBe(1)
})
