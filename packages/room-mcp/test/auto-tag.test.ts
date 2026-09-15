import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import { startAutoTaggedRoomd } from '../src/session.js'
import { resolveConfig, resolveSessionHost } from '../src/config.js'

vi.mock('@room/roomd', async importOriginal => ({
  ...await importOriginal<typeof import('@room/roomd')>(),
  startRoomd: vi.fn(async options => ({ name: options.name })),
}))

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); vi.unstubAllEnvs() })

/** Same update-exchange hub as the other suites, with real awareness and delayed first sync. */
function hub(names: string[], ownName = 'name') {
  const peers = names.map(name => {
    const doc = new Y.Doc(), awareness = new Awareness(doc)
    awareness.setLocalState({ user: { name } })
    cleanup.push(() => { awareness.destroy(); doc.destroy() })
    return { doc, awareness }
  })
  return (_server: string, _room: string, doc: Y.Doc): WebsocketProvider => {
    const events = new EventEmitter(), awareness = new Awareness(doc)
    awareness.setLocalState({ user: { name: ownName } })
    const provider = Object.assign(events, { synced: false, awareness, destroy() { events.removeAllListeners() } })
    setTimeout(() => {
      for (const peer of peers) {
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer.doc))
        applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer.awareness, [peer.awareness.clientID]), null)
      }
      provider.synced = true
      events.emit('sync', true)
    }, 5)
    return provider as unknown as WebsocketProvider
  }
}
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'auto-tag-'))
  mkdirSync(join(dir, '.git'))
  writeFileSync(join(dir, '.git/room-session.json'), JSON.stringify({ host: 'claude' }))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  vi.stubEnv('ROOM_HOST', '')
  return dir
}
async function start(names: string[], tag?: string) {
  const dir = repo(), log = vi.fn()
  const config = await resolveConfig({ dir, env: tag ? { ROOM_TAG: tag } : {} })
  const result = await startAutoTaggedRoomd({ dir, room: 'ws://test/room', name: tag ? `name+${tag}` : 'name', label: config.tag, owner: 'name', kind: 'agent', providerFactory: hub(names), log }, config.tag)
  return { ...result, log }
}
describe('automatic session tags', () => {
  it('tags a second join after first sync using the session host', async () => {
    const s = await start(['name'])
    expect(s.me).toMatchObject({ name: 'name+claude', label: 'claude', owner: 'name' })
    expect(s.daemon.name).toBe(s.me.name)
    expect(s.autoTagNote).toBe('joined as name+claude (name is already here from another session)')
    expect(s.log).toHaveBeenCalledExactlyOnceWith(s.autoTagNote)
  })
  it('numbers the third join', async () => {
    expect((await start(['name', 'name+claude'])).me.name).toBe('name+claude-2')
  })
  it('preserves explicit ROOM_TAG even on collision', async () => {
    const s = await start(['name', 'name+custom'], 'custom')
    expect(s.me.name).toBe('name+custom')
    expect(s.autoTagNote).toBeUndefined()
  })
  it('keeps a lone join plain and ignores its own awareness state', async () => {
    expect((await start([])).me.name).toBe('name')
  })
  it('resolves environment hints and falls back for unknown or missing hosts', () => {
    const dir = repo()
    expect(resolveSessionHost(dir, { ROOM_HOST: 'codex' })).toBe('codex')
    writeFileSync(join(dir, '.git/room-session.json'), '{bad json')
    expect(resolveSessionHost(dir, {})).toBe('agent')
  })
})
