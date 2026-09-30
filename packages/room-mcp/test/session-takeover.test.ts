import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authorizedWebSocket } from '@room/roomd'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { joinSession, leaveSession, type Session } from '../src/session.js'

let dir: string
const cleanups: (() => Promise<void> | void)[] = []
const prevRoomEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ROOM_')))
const clearRoomEnv = () => { for (const k of Object.keys(process.env)) if (k.startsWith('ROOM_')) delete process.env[k] }

beforeAll(() => {
  clearRoomEnv()
  dir = mkdtempSync(join(tmpdir(), 'room-takeover-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'Ada')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
})
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) { try { await c() } catch { /* ignore */ } } })
afterAll(() => { clearRoomEnv(); Object.assign(process.env, prevRoomEnv) })

describe('local relay takeover (hub.md §5, R-H2)', () => {
  it("the survivor's relay starts from the survivor's own replica, before any client syncs into it", async () => {
    const a = await joinSession({ dir, log: () => {} })
    cleanups.push(() => leaveSession(a))
    const b = await joinSession({ dir, tag: 'codex', log: () => {} })
    cleanups.push(() => leaveSession(b))
    expect(a.local?.owned).toBe(true)
    expect(b.local?.owned).toBe(false)
    // b stops syncing, so this value lives only in b's replica: never in the owner relay's doc or its memory file.
    b.provider.disconnect()
    b.room.doc.getMap('probe').set('k', 'only-in-b')
    await leaveSession(a)
    await vi.waitFor(() => expect(b.local?.owned).toBe(true), { timeout: 15_000, interval: 100 })
    // A fresh client of the successor relay sees the value; b's provider is still disconnected.
    const fresh = new Y.Doc()
    const provider = new WebsocketProvider(b.local!.url, b.roomUrl.slice(b.local!.url.length + 1), fresh, { WebSocketPolyfill: authorizedWebSocket({ key: b.local!.key }) as never, params: { schema: '2' } })
    cleanups.push(() => { provider.destroy(); fresh.destroy() })
    await vi.waitFor(() => expect(provider.synced).toBe(true), { timeout: 10_000, interval: 50 })
    expect(b.provider.wsconnected).toBe(false)
    expect(fresh.getMap('probe').get('k')).toBe('only-in-b')
  }, 45_000)
})
