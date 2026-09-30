import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { localRoomName } from '@room/roomd/local'
import { manifestKey, participantRecord } from '@room/shared'
import { startAutoTaggedRoomd } from '../src/session.js'
import { resolveConfig, resolveSessionHost } from '../src/config.js'
import { clearChoice, readChoice, rememberTag, writeChoice, worktreePath } from '../src/choice.js'
import { hubRoom, type HubRoom } from './fixtures/hub-provider.js'

const cleanup: (() => unknown)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs() })

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'auto-tag-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'init'], { cwd: dir })
  writeFileSync(join(dir, '.git/room-session.json'), JSON.stringify({ host: 'claude' }))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  vi.stubEnv('ROOM_HOST', 'claude')
  vi.stubEnv('ROOM_WORKER_HOST', '')
  vi.stubEnv('ROOM_WORKER_ID', '')
  return dir
}
let sessions = 0
/** Join `room` (one hub for every join in a test) from `dir`; names are decided by the local and hub leases. */
async function start(room: HubRoom, dir = repo(), tag?: string, sessionId = `s${++sessions}`, principal?: { id: string; login: string; readOnly: false }) {
  const log = vi.fn()
  const config = await resolveConfig({ dir, env: tag ? { ROOM_TAG: tag } : {} })
  const result = await startAutoTaggedRoomd({ dir, room: 'ws://test/room', localKey: 'key', name: tag ? `name+${tag}` : 'name', label: config.tag, owner: 'name', kind: 'agent',
    requested: 'full', sessionId, providerFactory: (_s, _r, doc: Y.Doc) => room.provider(doc, principal), log }, config.tag)
  cleanup.push(() => result.daemon.stop())
  return { ...result, log, dir }
}
describe('automatic session tags (registry §15: local lease, then hub lease)', () => {
  it('a second OIDC principal with the same login automatically tries a tagged name', async () => {
    const room = hubRoom()
    const first = { id: 'oidc:first', login: 'name', readOnly: false as const }
    const second = { id: 'oidc:second', login: 'name', readOnly: false as const }
    await start(room, repo(), undefined, 'first', first)
    const secondDir = repo()
    vi.stubEnv('ROOM_HOST', 'codex')
    const joined = await start(room, secondDir, undefined, 'second', second)
    expect(joined.me.name).toBe('name+codex')
    expect(joined.autoTagNote).toContain('name belongs to another account with the same display name')
  })
  it('an explicit tag remains refused for another OIDC principal', async () => {
    const room = hubRoom()
    await room.hold('name+custom', 'first', { id: 'oidc:first', login: 'name', readOnly: false })
    await expect(start(room, repo(), 'custom', 'second', { id: 'oidc:second', login: 'name', readOnly: false }))
      .rejects.toThrow('name+custom belongs to another principal')
  })
  it('production join passes hub pushed acceptance back to the daemon', async () => {
    const room = hubRoom(), s = await start(room)
    const fromSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: s.dir, encoding: 'utf8' }).trim()
    writeFileSync(join(s.dir, 'next.txt'), 'next\n')
    execFileSync('git', ['add', '.'], { cwd: s.dir })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'next'], { cwd: s.dir })
    const toSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: s.dir, encoding: 'utf8' }).trim()
    const git = participantRecord(s.daemon.roomDoc, s.me.name)!.git!
    s.daemon.roomDoc.participants.set(`${s.me.name}\0git`, { ...git, pushedPending: { fromSha, toSha, branch: 'main', upstream: 'origin/main' } })
    await (s.daemon as unknown as { postPushedPending(): Promise<void> }).postPushedPending()
    await vi.waitFor(() => expect(participantRecord(s.daemon.roomDoc, s.me.name)?.git?.pushedPending).toBeUndefined())
    expect(room.doc.messages().filter(m => m.type === 'pushed')).toHaveLength(1)
  })
  it('tags a join whose name another session holds, using the session host', async () => {
    const room = hubRoom()
    await room.hold('name')
    const s = await start(room)
    expect(s.me).toMatchObject({ name: 'name+claude', label: 'claude', owner: 'name' })
    expect(s.daemon.name).toBe(s.me.name)
    expect(s.autoTagNote).toBe('joined as name+claude (name is in use by another session)')
    expect(s.log.mock.calls.filter(([line]) => line === s.autoTagNote)).toHaveLength(1)
    expect(s.lease.fence()).toBe(String(s.lease.epoch))
  })
  it('keeps separate remembered names for a main checkout and its worktree in one local room', async () => {
    const room = hubRoom()
    const dir = repo(), worktree = join(dir, 'worktree')
    execFileSync('git', ['worktree', 'add', '-qb', 'worker', worktree], { cwd: dir })
    expect(await localRoomName(worktree)).toBe(await localRoomName(dir))
    const main = await start(room, dir)
    vi.stubEnv('ROOM_HOST', 'codex')
    const worker = await start(room, worktree)
    expect([main.me.name, worker.me.name]).toEqual(['name', 'name+codex'])
    expect((await readChoice(dir))?.tags).toEqual({ [await worktreePath(dir)]: '', [await worktreePath(worktree)]: 'codex' })
    // A restart released the prior process's names; each checkout gets its own back.
    await main.daemon.stop()
    await worker.daemon.stop()
    expect((await start(room, dir)).me.name).toBe(main.me.name)
    expect((await start(room, worktree)).me.name).toBe(worker.me.name)
  })
  it('numbers the third join', async () => {
    const room = hubRoom()
    await room.hold('name'); await room.hold('name+claude')
    expect((await start(room)).me.name).toBe('name+claude-2')
  })
  it('gives distinct names to simultaneous linked-worktree joins', async () => {
    const room = hubRoom()
    const dir = repo()
    const dirs = [dir]
    for (let i = 1; i < 6; i++) {
      const worktree = join(dir, `worktree-${i}`)
      execFileSync('git', ['worktree', 'add', '-qb', `worker-${i}`, worktree], { cwd: dir })
      dirs.push(worktree)
    }
    const joined = await Promise.all(dirs.map(worktree => start(room, worktree)))
    expect(new Set(joined.map(s => s.me.name)).size).toBe(6)
    expect(Object.keys((await readChoice(dir))?.tags ?? {})).toHaveLength(6)
  })
  it('keeps a name unique across separate clones: the hub grants it once', async () => {
    const room = hubRoom()
    const [first, second] = [await start(room, repo()), await start(room, repo())]
    expect([first.me.name, second.me.name]).toEqual(['name', 'name+claude'])
    expect((await readChoice(second.dir))?.tags?.[await worktreePath(second.dir)]).toBe('claude')
  })
  it('refuses an explicit ROOM_TAG another session holds, and takes a free one without a note or a remembered choice', async () => {
    const room = hubRoom()
    await room.hold('name+custom')
    await expect(start(room, repo(), 'custom')).rejects.toThrow('name+custom is held by another session')
    const s = await start(room, repo(), 'other')
    expect(s.me.name).toBe('name+other')
    expect(s.autoTagNote).toBeUndefined()
    expect(await readChoice(s.dir)).toBeUndefined()
  })
  it('keeps a lone join plain', async () => {
    const s = await start(hubRoom())
    expect(s.me.name).toBe('name')
    expect((await readChoice(s.dir))?.tags?.[await worktreePath(s.dir)]).toBe('')
  })
  it('takes a name whose last holder released it', async () => {
    const room = hubRoom()
    await room.release('name', await room.hold('name'))
    expect((await start(room)).me.name).toBe('name')
  })
  it('passes over a name that holds another clone\'s uncommitted work while nobody holds it', async () => {
    const room = hubRoom()
    const entries = new Y.Map()
    entries.set('work.txt', { change: 'M', state: 'shared', at: Date.now(), fence: '1' })
    room.doc.manifest.set(manifestKey('name', '1'), entries)
    room.doc.manifestHead.set('name', { base: 'HEAD', fence: '1', coverage: { kind: 'all' }, level: 'full', excluded: [], rev: 1, semRev: 1, scannedAt: Date.now(), complete: true })
    const s = await start(room)
    expect(s.me.name).toBe('name+claude')
    expect(s.autoTagNote).toBe('joined as name+claude (name still holds uncommitted work from another clone)')
  })
  it('rejoins under a tag remembered after another session held the bare name', async () => {
    const room = hubRoom()
    const dir = repo()
    await room.hold('name')
    const first = await start(room, dir)
    expect(first.me.name).toBe('name+claude')
    await first.daemon.stop()
    await writeChoice(dir, 'team')
    expect((await start(room, dir)).me.name).toBe('name+claude')
  })
  it('does not remember a temporary tag while this worktree\'s previous process still holds the bare name lease', async () => {
    const room = hubRoom()
    const dir = repo()
    const old = await start(room, dir)
    const replacement = await start(room, dir)
    expect(replacement.me.name).toBe('name+claude')
    expect((await readChoice(dir))?.tags?.[await worktreePath(dir)]).toBe('')
    await replacement.daemon.stop()
    await old.daemon.stop()
    expect((await start(room, dir)).me.name).toBe('name')
  })
  it('replaces a remembered bare tag when another session holds that name', async () => {
    const room = hubRoom()
    const dir = repo()
    await rememberTag(dir, '')
    await room.hold('name')
    const s = await start(room, dir)
    expect(s.me).toMatchObject({ name: 'name+claude', label: 'claude', owner: 'name' })
    expect((await readChoice(dir))?.tags?.[await worktreePath(dir)]).toBe('claude')
    expect(s.autoTagNote).toBe('joined as name+claude (remembered name name is in use by another session)')
  })
  it('lets ROOM_TAG win without replacing the remembered automatic tag', async () => {
    const dir = repo()
    await rememberTag(dir, 'claude')
    expect((await start(hubRoom(), dir, 'custom')).me.name).toBe('name+custom')
    expect((await readChoice(dir))?.tags?.[await worktreePath(dir)]).toBe('claude')
  })
  it('forgets the remembered tag with the clone choice', async () => {
    const dir = repo()
    await rememberTag(dir, 'claude')
    expect(await clearChoice(dir)).toBe(true)
    expect(await readChoice(dir)).toBeUndefined()
  })
  it('resolves environment hints and falls back for unknown or missing hosts', () => {
    expect(resolveSessionHost({ ROOM_HOST: 'codex' }, () => 'claude')).toBe('codex')
    expect(resolveSessionHost({}, () => '/usr/bin/codex')).toBe('codex')
    expect(resolveSessionHost({}, () => '/usr/bin/claude')).toBe('claude')
    expect(resolveSessionHost({ CLAUDE_CODE_SESSION_ID: 'abc' }, () => 'node')).toBe('claude')
    // No per-worktree session file decides the host any more: it is the bound session's (registry §17).
    expect(resolveSessionHost({}, () => 'node')).toBe('agent')
    expect(resolveSessionHost({}, () => { throw new Error('ps denied') })).toBe('agent')
  })
})
