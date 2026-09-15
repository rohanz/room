import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import { RoomDoc } from '@room/shared'
import { startAutoTaggedRoomd } from '../src/session.js'
import { resolveConfig, resolveSessionHost } from '../src/config.js'
import { clearChoice, readChoice, rememberTag, writeChoice } from '../src/choice.js'

vi.mock('@room/roomd', async importOriginal => ({
  ...await importOriginal<typeof import('@room/roomd')>(),
  startRoomd: vi.fn(async options => ({ name: options.name })),
}))

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); vi.unstubAllEnvs() })

/** Same update-exchange hub as the other suites, with real awareness and delayed first sync. */
function hub(names: string[], ownName = 'name', stale = new Set<string>(), work = new Set<string>()) {
  const peers = names.map(name => {
    const doc = new Y.Doc(), awareness = new Awareness(doc)
    awareness.setLocalState({ user: { name }, ...(stale.has(name) ? { lastActive: Date.now() - 20_001 } : {}) })
    if (work.has(name)) new RoomDoc(doc).setOverlay(name, 'work.txt', 'uncommitted')
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
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.git/room-session.json'), JSON.stringify({ host: 'claude' }))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  vi.stubEnv('ROOM_HOST', '')
  return dir
}
async function start(names: string[], tag?: string, stale: string[] = [], work: string[] = [], dir = repo()) {
  const log = vi.fn()
  const config = await resolveConfig({ dir, env: tag ? { ROOM_TAG: tag } : {} })
  const result = await startAutoTaggedRoomd({ dir, room: 'ws://test/room', name: tag ? `name+${tag}` : 'name', label: config.tag, owner: 'name', kind: 'agent', providerFactory: hub(names, 'name', new Set(stale), new Set(work)), log }, config.tag)
  return { ...result, log, dir }
}
describe('automatic session tags', () => {
  it('tags a second join after first sync using the session host', async () => {
    const s = await start(['name'])
    expect(s.me).toMatchObject({ name: 'name+claude', label: 'claude', owner: 'name' })
    expect(s.daemon.name).toBe(s.me.name)
    expect(s.autoTagNote).toBe('joined as name+claude (name is in use by another session)')
    expect(s.log).toHaveBeenCalledExactlyOnceWith(s.autoTagNote)
  })
  it('numbers the third join', async () => {
    expect((await start(['name', 'name+claude'])).me.name).toBe('name+claude-2')
  })
  it('preserves explicit ROOM_TAG even on collision', async () => {
    const s = await start(['name', 'name+custom'], 'custom')
    expect(s.me.name).toBe('name+custom')
    expect(s.autoTagNote).toBeUndefined()
    expect(await readChoice(s.dir)).toBeUndefined()
  })
  it('keeps a lone join plain and ignores its own awareness state', async () => {
    const s = await start([])
    expect(s.me.name).toBe('name')
    expect((await readChoice(s.dir))?.tag).toBe('')
  })
  it('ignores a crashed session whose last activity is older than 20 seconds', async () => {
    expect((await start(['name'], undefined, ['name'])).me.name).toBe('name')
  })
  it('skips a name with a leftover overlay when nobody is present', async () => {
    const s = await start(['name'], undefined, ['name'], ['name'])
    expect(s.me.name).toBe('name+claude')
    expect(s.autoTagNote).toBe('joined as name+claude (name still holds uncommitted work from another clone)')
  })
  it('rejoins under the tag remembered for this clone when the bare name is free', async () => {
    const dir = repo()
    expect((await start(['name'], undefined, [], [], dir)).me.name).toBe('name+claude')
    await writeChoice(dir, 'team')
    expect((await start([], undefined, [], [], dir)).me.name).toBe('name+claude')
  })
  it('replaces a remembered bare tag when another session is present under that name', async () => {
    const dir = repo()
    await rememberTag(dir, '')
    const s = await start(['name'], undefined, [], [], dir)
    expect(s.me).toMatchObject({ name: 'name+claude', label: 'claude', owner: 'name' })
    expect((await readChoice(dir))?.tag).toBe('claude')
    expect(s.autoTagNote).toBe('joined as name+claude (remembered name name is in use by another session)')
  })
  it('lets ROOM_TAG win without replacing the remembered automatic tag', async () => {
    const dir = repo()
    await rememberTag(dir, 'claude')
    expect((await start([], 'custom', [], [], dir)).me.name).toBe('name+custom')
    expect((await readChoice(dir))?.tag).toBe('claude')
  })
  it('forgets the remembered tag with the clone choice', async () => {
    const dir = repo()
    await rememberTag(dir, 'claude')
    expect(await clearChoice(dir)).toBe(true)
    expect(await readChoice(dir)).toBeUndefined()
  })
  it('resolves environment hints and falls back for unknown or missing hosts', () => {
    const dir = repo()
    expect(resolveSessionHost(dir, { ROOM_HOST: 'codex' }, () => 'claude')).toBe('codex')
    expect(resolveSessionHost(dir, {}, () => '/usr/bin/codex')).toBe('codex')
    expect(resolveSessionHost(dir, {}, () => '/usr/bin/claude')).toBe('claude')
    expect(resolveSessionHost(dir, {}, () => 'node')).toBe('claude')
    expect(resolveSessionHost(dir, {}, () => { throw new Error('ps denied') })).toBe('claude')
    writeFileSync(join(dir, '.git/room-session.json'), '{bad json')
    expect(resolveSessionHost(dir, {}, () => 'node')).toBe('agent')
  })
})
