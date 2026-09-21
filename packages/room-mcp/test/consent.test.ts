import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import type { ShareLevel } from '@room/roomd'
import { createTools } from '../src/tools.js'
import { requestedShare, serverShareMax, findRoomFile, type Session } from '../src/session.js'
import { sharingDescription } from '../src/config.js'
import { readChoice, writeChoice } from '../src/choice.js'

let dir: string
const cleanup: (() => void | Promise<void>)[] = []
beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('ROOM_')) vi.stubEnv(key, undefined)
  dir = mkdtempSync(join(tmpdir(), 'room-consent-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
})
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) })

function setup(company = false) {
  let session: Session | null = null
  const joiner = vi.fn(async (opts: { share?: string; server?: string; room?: string }) => {
    const doc = new Y.Doc(), room = new RoomDoc(doc), awareness = new Awareness(doc)
    cleanup.push(() => { awareness.destroy(); doc.destroy() })
    const name = opts.room ?? 'git/example/repo/main'
    const daemon = { share: opts.share ?? 'full', touch() {}, async stop() {}, async setShare(level: string) { daemon.share = level }, skipped: () => ({ share: [], size: [], budget: [], ignore: [] }) }
    const s = { dir, room, awareness, roomName: name, roomUrl: `${opts.server}/${encodeURIComponent(name)}`, browserUrl: 'http://example/view', me: { name: 'Ada', kind: 'agent' }, provider: { synced: true, awareness }, daemon, shareMax: 'full', shareRequested: daemon.share, ...(opts.server === 'local' ? { local: { url: 'ws://local' } } : {}) } as Session
    if (company) {
      const other = new Y.Doc(), aw = new Awareness(other)
      aw.setLocalState({ user: { name: 'Bob', kind: 'agent' }, lastActive: Date.now() })
      applyAwarenessUpdate(awareness, encodeAwarenessUpdate(aw, [other.clientID]), 'test')
      cleanup.push(() => { aw.destroy(); other.destroy() })
    }
    return s
  })
  const tools = createTools({ cwd: dir, getSession: () => session, setSession: s => { session = s }, join: joiner, leave: async () => {} })
  cleanup.push(() => tools.shutdown())
  return { tools, joiner, session: () => session! }
}

it.each(['full', 'declared', 'intent'] as ShareLevel[])('discloses %s on the first solo team join once', async share => {
  const t = setup()
  const out = await t.tools.call('room_join', { where: 'ws://team', room: 'git/example/repo/main', share })
  expect(out).toContain('alone here')
  expect(out).toContain(`note for your human: this clone now shares ${sharingDescription(share)}`)
  expect(out).toContain('room_share level=intent')
  expect(out.indexOf('note for your human')).toBeLessThan(out.indexOf('alone here'))
  expect(await t.tools.call('room_join', {})).not.toContain('note for your human')
  await t.tools.call('room_leave', {})
  expect(await t.tools.call('room_join', { room: 'git/example/repo/main', share })).not.toContain('note for your human')
})
it('discloses when company is present and never for local joins', async () => {
  const t = setup(true)
  expect(await t.tools.call('room_join', { where: 'ws://team', room: 'repo/main' })).toContain('note for your human')
  await t.tools.call('room_leave', {})
  expect(await t.tools.call('room_join', { where: 'local' })).not.toContain('note for your human')
})
it.each(['ROOM_SERVER', 'ROOM_URL'])('reports explicit %s and invalid environment sharing while alone', async key => {
  vi.stubEnv(key, key === 'ROOM_URL' ? 'ws://team/repo%2Fmain' : 'ws://team')
  vi.stubEnv('ROOM_SHARE', 'decalred')
  const t = setup()
  const out = await t.tools.call('room_join', key === 'ROOM_SERVER' ? { room: 'repo/main' } : {})
  expect(out).toContain(`chosen by ${key}`)
  expect(out).toContain("ROOM_SHARE='decalred' is not a level; sharing plans only")
  expect(out).toContain('note for your human: this clone now shares only your plans, no file text')
  expect(t.joiner).toHaveBeenCalledWith(expect.objectContaining({ server: 'ws://team', share: 'intent', room: 'repo/main' }))
  expect((await readChoice(dir))?.where).toBe('local')
})
it('narrows invalid explicit sharing on both new and existing joins', async () => {
  const t = setup()
  const args = { where: 'ws://team', room: 'repo/main' }
  expect(await t.tools.call('room_join', { ...args, share: 'decalred' })).toContain("share='decalred' is not a level; sharing plans only")
  await t.tools.call('room_share', { level: 'full' })
  expect(await t.tools.call('room_join', { ...args, share: 'bad' })).toContain("level='bad' is not a level; sharing plans only")
  expect(t.session().daemon.share).toBe('intent')
  await t.tools.call('room_share', { level: 'full' })
  await t.tools.call('room_join', { share: '' })
  expect(t.session().daemon.share).toBe('intent')
})
it('discloses a remembered team destination and lets explicit local override ROOM_URL', async () => {
  await writeChoice(dir, 'ws://remembered')
  const t = setup()
  expect(await t.tools.call('room_join', { room: 'repo/main' })).toContain('choice remembered for this clone')
  await t.tools.call('room_leave', {})
  vi.stubEnv('ROOM_URL', 'ws://unexpected/repo')
  expect(await t.tools.call('room_join', { where: 'local' })).not.toContain('note for your human')
  expect(t.joiner).toHaveBeenLastCalledWith(expect.objectContaining({ server: 'local' }))
})
it.each(['decalred', '', 'ful'])('direct sharing resolution fails closed for %j', raw => {
  expect(requestedShare(raw)).toBe('intent')
})
it('uses full only for missing share values and clamps malformed server ceilings privately', async () => {
  expect(requestedShare()).toBe('full')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ shareMax: 'decalred' }))))
  expect(await serverShareMax('ws://malformed-ceiling')).toBe('intent')
})

it('delivers automatic-join disclosure on the first tool reply only', async () => {
  const t = setup()
  const session = await t.joiner({ server: 'ws://team', room: 'repo/main', share: 'intent' })
  const tools = createTools({ cwd: dir, getSession: () => session, setSession: () => {} })
  cleanup.push(() => tools.shutdown())
  expect(await tools.call('room_state', {})).toContain('note for your human: this clone now shares only your plans, no file text')
  expect(await tools.call('room_state', {})).not.toContain('note for your human')
})

it('finds private worktree metadata from a nested directory and migrates legacy metadata', () => {
  const nested = join(dir, 'nested')
  mkdirSync(nested)
  const metadata = { room: 'ws://team/repo', name: 'Ada', dir }
  writeFileSync(join(dir, '.room.json'), JSON.stringify(metadata))
  expect(findRoomFile(nested)).toMatchObject(metadata)
  expect(existsSync(join(dir, '.room.json'))).toBe(false)
  expect(existsSync(join(dir, '.git', 'room.json'))).toBe(true)
  expect(findRoomFile(nested)).toMatchObject(metadata)
})
