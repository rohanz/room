import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { ROOM_DOC_MAX_BYTES } from '@room/shared'
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
  first.doc.getMap('seen:lead%2Bworker').set('bus', 123)
  first.doc.getMap('seen:lead%2Bworker').set('unreferenced', 123)
  for (const type of ['bus', 'retiredWorkers']) first.doc.getArray(type).push([{ id: type }])
  for (const type of ['workers', 'scopes', 'colors', 'meta', 'ledger']) first.doc.getMap(type).set('key', { value: type })
  for (const type of ['overlays', 'deleted', 'basetext', 'graphs', 'claims']) first.doc.getMap(type).set('stale', 'text')
  first.close()
  const second = open()
  expect(second.doc.getMap('seen:lead%2Bworker').toJSON()).toEqual({ bus: 123 })
  expect(second.doc.getArray('bus').toArray()).toEqual([{ id: 'bus' }])
  expect(second.doc.getArray('retiredWorkers').toArray()).toEqual([{ id: 'retiredWorkers' }])
  for (const type of ['workers', 'scopes', 'colors', 'meta', 'ledger']) expect(second.doc.getMap(type).get('key')).toEqual({ value: type })
  for (const type of ['overlays', 'deleted', 'basetext', 'graphs']) expect(second.doc.share.has(type)).toBe(false)
  expect(second.doc.getMap('claims').get('stale')).toBe('text')
  expect(fs.statSync(memoryFile(dir, room)).mode & 0o777).toBe(0o600)
  expect(fs.statSync(path.dirname(memoryFile(dir, room))).mode & 0o777).toBe(0o700)
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
  fs.mkdirSync(path.dirname(memoryFile(dir, room)), { recursive: true })
  fs.writeFileSync(memoryFile(dir, room), new Uint8Array([255, 255, 255]))
  expect(load().share.size).toBe(0)
  expect(fs.readdirSync(path.dirname(memoryFile(dir, room)))).toEqual([expect.stringMatching(/\.ydoc\.corrupt-\d+$/)])
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
  expect(fs.readdirSync(path.dirname(memoryFile(dir, room)))).toEqual([path.basename(memoryFile(dir, room))])
})
it('saves the smallest snapshot when protected data alone exceeds 5MB, keeping mail owed since, and warns once a minute', () => {
  const memory = open()
  memory.doc.getMap('meta').set('large', 'x'.repeat(MAX_MEMORY_BYTES))
  memory.doc.getArray('bus').push([{ id: 'b0', text: 'broadcast' }])
  expect(saveMemory(dir, room, memory.doc, log)).toBe(true)
  memory.doc.getMap('mail').set('q1', { id: 'q1', type: 'question', to: 'pat', text: 'owed since the last save' })
  expect(saveMemory(dir, room, memory.doc, log)).toBe(true)
  expect(fs.statSync(memoryFile(dir, room)).size).toBeGreaterThan(MAX_MEMORY_BYTES)
  const restored = load()
  expect(restored.getMap('mail').toJSON()).toEqual({ q1: { id: 'q1', type: 'question', to: 'pat', text: 'owed since the last save' } })
  expect((restored.getMap('meta').get('large') as string).length).toBe(MAX_MEMORY_BYTES)
  expect(restored.getArray('bus').length).toBe(0)
  const warnings = log.mock.calls.filter(([line]) => /saved anyway/.test(line))
  expect(warnings).toEqual([[expect.stringMatching(/^local room memory: .*: snapshot is 5\.0 MB after dropping everything droppable \(largest roots: meta 5\.0 MB\b.*\); saved anyway; target 5 MB$/)]])
})
it('skips snapshots over the 64MB ceiling and keeps the last good file', () => {
  const memory = open(); memory.flush()
  const original = fs.readFileSync(memoryFile(dir, room))
  memory.doc.getMap('meta').set('large', 'x'.repeat(ROOM_DOC_MAX_BYTES))
  expect(saveMemory(dir, room, memory.doc, log)).toBe(false)
  expect(fs.readFileSync(memoryFile(dir, room))).toEqual(original)
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/skipping .*: snapshot is 64\.0 MB, over the 64 MB ceiling; keeping the last good file$/))
})
it('quarantines files over the 64MB ceiling on load', () => {
  const memory = open(); memory.flush()
  fs.truncateSync(memoryFile(dir, room), ROOM_DOC_MAX_BYTES + 1)
  expect(load().share.size).toBe(0)
  expect(fs.readdirSync(path.dirname(memoryFile(dir, room)))).toEqual([expect.stringMatching(/\.ydoc\.corrupt-\d+$/)])
  expect(log).toHaveBeenCalledWith(expect.stringContaining('exceeds 64 MB'))
})
it('still saves when sibling roots push the snapshot past 5MB, shedding archive and broadcasts but not mail', () => {
  const memory = open()
  memory.doc.getMap('workers').set('large', 'w'.repeat(2 * 1024 * 1024))
  for (let i = 0; i < 150; i++) memory.doc.getMap('mail').set(`q${i}`, { id: `q${i}`, to: 'pat', text: 'm'.repeat(10 * 1024) })
  for (let i = 0; i < 300; i++) memory.doc.getArray('bus').push([{ id: `b${i}`, text: 'b'.repeat(10 * 1024) }])
  for (let i = 0; i < 1000; i++) memory.doc.getMap('archive').set(`a${i}`, ['note', 'quinn', i, []])
  expect(saveMemory(dir, room, memory.doc, log)).toBe(true)
  const restored = load()
  expect(restored.getMap('mail').size).toBe(150)
  expect(restored.getMap('archive').size).toBe(0)
  expect(restored.getArray('bus').length).toBeLessThan(300)
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/^local room memory: .*: snapshot over 5242880 bytes: dropped 1000 archive entries/))
})
it('forget removes only this room and prevents pending or shutdown saves from recreating it', () => {
  vi.useFakeTimers()
  const memory = open(); memory.doc.getArray('bus').push(['kept']); memory.flush()
  saveMemory(dir, 'other', memory.doc, log)
  memory.doc.getMap('seen:lead%2Bworker').set('message', 123)
  memory.doc.getMap('completedPublications').set('worker', 'retained publication')
  memory.doc.getArray('bus').push(['pending']); memory.forget()
  expect(memory.doc.getArray('bus').length).toBe(0)
  expect(memory.doc.getMap('seen:lead%2Bworker').size).toBe(0)
  expect(memory.doc.getMap('completedPublications').size).toBe(0)
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
