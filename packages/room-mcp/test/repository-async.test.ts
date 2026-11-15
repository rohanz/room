/** Known pre-existing idle claim release interleaving. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RoomDoc } from '@room/shared'
import { PresenceEnd, IDLE_CLAIMS_MS, releaseIdleHeld } from '../src/presence-end.js'
import type { Session } from '../src/session.js'

const gate = vi.hoisted(() => ({ common: undefined as undefined | (() => Promise<string>) }))
vi.mock('@room/roomd', async original => {
  const actual = await original<typeof import('@room/roomd')>()
  return { ...actual, gitCommonDir: (...args: Parameters<typeof actual.gitCommonDir>) => gate.common ? gate.common() : actual.gitCommonDir(...args) }
})
const roots: string[] = []
afterEach(() => { gate.common = undefined; for (const dir of roots.splice(0)) fs.rmSync(dir, { force: true, recursive: true }) })
const root = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-repository-async-')); roots.push(dir); return dir }

// Known pre-existing defect: host activity during releaseIdleHeld's Git/journal await can still lose claims.
it.fails('activity while releaseIdleHeld awaits Git must preserve the active host claims', async () => {
  const common = root(), room = new RoomDoc()
  room.claims.set('active-claim', { id: 'active-claim', path: 'x.ts', from: 1, to: 2, by: 'Ada', byKind: 'agent', intent: 'active work', at: 1 })
  const session = { dir: common, room, roomName: 'local/review', me: { name: 'Ada', kind: 'agent' },
    lease: { sessionId: 'host', fence: () => '1' }, post: vi.fn(async () => ({ ok: true })) } as unknown as Session
  let at = 0, resolveGit!: (value: string) => void
  const started = vi.fn(() => new Promise<string>(resolve => { resolveGit = resolve }))
  gate.common = started
  const presence = new PresenceEnd({ hostKind: 'shared-app-server', episodeId: async () => 'durable-1', tickMs: 0,
    mono: () => at, hostAlive: () => true, holds: () => room.claims.size > 0, leadsWorkers: () => true, waiting: () => false,
    hostEnded: () => {}, leave: async () => {}, releaseHeld: (idle, epoch) => releaseIdleHeld(session, epoch, idle, () => at) })
  try {
    at = IDLE_CLAIMS_MS
    const pending = presence.tick()
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce())
    presence.activity()
    resolveGit(common)
    await pending
    expect(presence.idleMs()).toBe(0)
    expect(room.claims.has('active-claim')).toBe(true)
  } finally { presence.stop(); room.doc.destroy() }
})
