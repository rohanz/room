import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ExpiryTenure, RoomDoc, ROOM_STALE_MS } from '@room/shared'
import { RoomMemory } from '../src/memory.js'

let dir: string
const memories: RoomMemory[] = []
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-memory-expiry-')) })
afterEach(async () => {
  for (const memory of memories.splice(0)) await memory.close([]).catch(() => {})
  fs.rmSync(dir, { recursive: true, force: true })
})
const open = () => { const m = new RoomMemory(dir, 'local/repo', () => {}); memories.push(m); return m }
const absent = [{ name: 'gone', fresh: false, visible: true }]
const holder = { sessionId: 's', pid: 1, startTime: 't', executable: 'x', epoch: 1, at: 0 }

// A participant absent for seven observed days must expire even when no daemon lives that long:
// each daemon measures on top of what the one before it recorded.
it('carries measured absence across a daemon stop and start', async () => {
  const day = 24 * 60 * 60 * 1000
  let expired: string[] = []
  for (let run = 0; run < 5 && !expired.length; run++) {
    const memory = open(), room = new RoomDoc(memory.doc)
    // The hub restores the holder from its private lease storage at every start.
    room.participants.set('gone\u0000holder', holder)
    let now = 0
    const tenure = new ExpiryTenure(`epoch-${run}`, () => now)
    tenure.observe(room, absent, 'hub', () => {})
    for (let step = 0; step < 4 && !expired.length; step++) {
      now += day / 2
      expired = tenure.observe(room, absent, 'hub', () => {})
    }
    await memory.close()
    memories.splice(memories.indexOf(memory), 1)
  }
  expect(ROOM_STALE_MS).toBe(7 * day)
  expect(expired).toEqual(['gone'])
})
