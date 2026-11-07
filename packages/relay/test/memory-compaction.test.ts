import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { docGeneration, generationGate } from '@room/shared'
import { finalSave, memoryFile, RoomMemory } from '../src/memory.js'

const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

it.each([undefined, 'previous-compaction'])('crash restart keeps generation %s and accepts survivor resync', generation => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-crash-'))
  dirs.push(dir)
  const first = new RoomMemory(dir, 'local/test')
  if (generation) first.doc.getMap('meta').set('generation', generation)
  expect(first.save()).toBeUndefined()
  const survivor = new Y.Doc()
  Y.applyUpdate(survivor, Y.encodeStateAsUpdate(first.doc))
  first.doc.getArray('bus').push([{ id: 'unsaved', text: 'acknowledged in memory' }])
  Y.applyUpdate(survivor, Y.encodeStateAsUpdate(first.doc))
  first.detach(); first.doc.destroy() // abrupt exit: no final save
  const next = new RoomMemory(dir, 'local/test')
  try {
    expect(docGeneration(next.doc)).toBe(generation)
    expect(next.doc.getArray('bus').length).toBe(0)
    expect(generationGate(docGeneration(survivor) ?? '0', docGeneration(next.doc))).toBe('accept')
    Y.applyUpdate(next.doc, Y.encodeStateAsUpdate(survivor))
    expect(next.doc.getArray('bus').toArray()).toEqual([{ id: 'unsaved', text: 'acknowledged in memory' }])
    expect(next.save()).toBeUndefined()
    const loaded = new RoomMemory(dir, 'local/test')
    expect(docGeneration(loaded.doc)).toBe(generation)
    loaded.detach(); loaded.doc.destroy()
  } finally { next.detach(); next.doc.destroy(); survivor.destroy() }
})

it('only the planned final save stamps a new generation, without changing the live replica', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-compact-'))
  dirs.push(dir)
  const memory = new RoomMemory(dir, 'local/test')
  try {
    expect(memory.save('planned')).toBeUndefined()
    expect(docGeneration(memory.doc)).toBeUndefined()
    const next = new RoomMemory(dir, 'local/test')
    expect(docGeneration(next.doc)).toBe('planned')
    expect(next.save()).toBeUndefined()
    next.detach(); next.doc.destroy()
  } finally { memory.detach(); memory.doc.destroy() }
})

it.each(['rename', 'fsync'])('planned final save finishes after %s failure without retrying old generations', async failure => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-failure-')); dirs.push(dir)
  const logs: string[] = []
  const a = new RoomMemory(dir, 'a', line => logs.push(line)), b = new RoomMemory(dir, 'b', line => logs.push(line))
  a.save(); b.save()
  a.doc.getArray('bus').push([{ id: 'a', text: 'acknowledged' }])
  b.doc.getArray('bus').push([{ id: 'b', text: 'acknowledged' }])
  const survivor = new Y.Doc(); Y.applyUpdate(survivor, Y.encodeStateAsUpdate(b.doc))
  const rename = fs.renameSync.bind(fs), sync = fs.fsyncSync.bind(fs)
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (failure === 'rename' && String(to) === memoryFile(dir, 'b')) throw new Error('EIO B rename')
    return rename(from, to)
  })
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    if (failure === 'fsync' && fs.fstatSync(fd).isDirectory()) throw new Error('EIO directory fsync')
    return sync(fd)
  })
  try {
    await expect(finalSave(() => [a, b], [], 'planned')).resolves.toBeUndefined()
    expect(logs.filter(line => line.includes('exiting without reopening'))).toHaveLength(failure === 'rename' ? 1 : 2)
    a.detach(); b.detach(); vi.restoreAllMocks()
    const nextA = new RoomMemory(dir, 'a'), nextB = new RoomMemory(dir, 'b')
    try {
      expect(docGeneration(nextA.doc)).toBe('planned')
      expect(nextA.doc.getArray('bus').toArray()).toEqual([{ id: 'a', text: 'acknowledged' }])
      expect(docGeneration(nextB.doc)).toBe(failure === 'rename' ? undefined : 'planned')
      if (failure === 'rename') Y.applyUpdate(nextB.doc, Y.encodeStateAsUpdate(survivor))
      expect(nextB.doc.getArray('bus').toArray()).toEqual([{ id: 'b', text: 'acknowledged' }])
    } finally { nextA.detach(); nextB.detach(); nextA.doc.destroy(); nextB.doc.destroy() }
  } finally { a.detach(); b.detach(); a.doc.destroy(); b.doc.destroy(); survivor.destroy() }
})

it('refuses a planned snapshot that sheds broadcasts without changing disk or live generation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-shedding-')); dirs.push(dir)
  const memory = new RoomMemory(dir, 'large', () => {})
  try {
    memory.save()
    const before = fs.readFileSync(memoryFile(dir, 'large'))
    const broadcasts = [{ id: 'large', text: 'x'.repeat(6 * 1024 * 1024) }]
    memory.doc.getArray('bus').push(broadcasts)
    expect(memory.canCompact()).toBe(false)
    expect(memory.save('planned')).toBe('snapshot would shed content')
    expect(fs.readFileSync(memoryFile(dir, 'large'))).toEqual(before)
    expect(docGeneration(memory.doc)).toBeUndefined()
    expect(memory.doc.getArray('bus').toArray()).toEqual(broadcasts)
  } finally { memory.detach(); memory.doc.destroy() }
})
