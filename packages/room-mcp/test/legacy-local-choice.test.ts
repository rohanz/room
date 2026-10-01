// rc7: a Room 0.16 remembered per-branch local choice (`local/<main worktree basename>/<branch>`) moves to the
// 0.17 repository room once, with one notice. Custom local names, team choices and 0.17-written choices stay.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { choiceFile, migrateLegacyLocalChoice, writeChoice } from '../src/choice.js'
import { resolveConfig } from '../src/config.js'
import { legacyLocalBranchRoom } from '../src/room-name.js'
import { joinSession, leaveSession, type Session } from '../src/session.js'
import { createTools } from '../src/tools.js'

const prevRoomEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ROOM_')))
const clearRoomEnv = () => { for (const k of Object.keys(process.env)) if (k.startsWith('ROOM_')) delete process.env[k] }
const dirs: string[] = []
const sessions: Session[] = []

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'room-legacy-choice-')); dirs.push(d)
  const git = (...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'pipe' })
  git('init', '-q', '-b', 'redesign'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'Ada')
  writeFileSync(join(d, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
  return d
}
const remember = async (dir: string, choice: Record<string, unknown>) => writeFileSync(await choiceFile(dir), JSON.stringify(choice) + '\n')
const remembered = async (dir: string) => JSON.parse(readFileSync(await choiceFile(dir), 'utf8')) as Record<string, unknown>

beforeEach(clearRoomEnv)
afterEach(async () => { for (const s of sessions.splice(0)) { try { await leaveSession(s) } catch { /* ignore */ } } })
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); clearRoomEnv(); Object.assign(process.env, prevRoomEnv) })

describe('the 0.16 local room naming rule', () => {
  it('recognises local/<main worktree basename>/<branch>, including branches with slashes', () => {
    expect(legacyLocalBranchRoom('local/room-redesign/redesign-wave0', 'room-redesign')).toBe('local/room-redesign')
    expect(legacyLocalBranchRoom('local/shop/feature/login', 'shop')).toBe('local/shop')
    expect(legacyLocalBranchRoom('local/shop/detached', 'shop')).toBe('local/shop')
  })
  it('leaves custom names alone: another prefix, the repository room itself, or no branch part', () => {
    expect(legacyLocalBranchRoom('local/experiments', 'shop')).toBeUndefined()
    expect(legacyLocalBranchRoom('local/other/main', 'shop')).toBeUndefined()
    expect(legacyLocalBranchRoom('local/shop', 'shop')).toBeUndefined()
    expect(legacyLocalBranchRoom('local/shop/', 'shop')).toBeUndefined()
    expect(legacyLocalBranchRoom('local/shopping/main', 'shop')).toBeUndefined()
  })
})

describe('remembered 0.16 per-branch local choice', () => {
  it('resolves to the repository room and rewrites the choice once, keeping every other field', async () => {
    const dir = repo(), base = basename(dir), from = `local/${base}/redesign-wave0`
    await remember(dir, { where: 'local', at: 1, by: 'rohanz', room: from, tags: { [dir]: '' }, share: { level: 'declared' }, warned: true })
    expect(await resolveConfig({ dir, env: {} })).toMatchObject({ where: 'local', whereRule: 'remembered', room: undefined, legacyLocalRoom: { from, to: `local/${base}` } })
    const note = await migrateLegacyLocalChoice(dir)
    expect(note).toBe(`your remembered 0.16 branch room ${from} is now the repository room local/${base}; Room 0.17 has one room per repository, shared by every branch`)
    expect(await remembered(dir)).toEqual({ where: 'local', at: 1, by: 'rohanz', tags: { [dir]: '' }, share: { level: 'declared' }, warned: true, schema: 2 })
    expect(await migrateLegacyLocalChoice(dir)).toBeUndefined()
    expect((await resolveConfig({ dir, env: {} })).legacyLocalRoom).toBeUndefined()
  })

  it('an argument or ROOM_ROOM still names the room; only a join to the repository room migrates', async () => {
    const dir = repo()
    await remember(dir, { where: 'local', at: 1, room: `local/${basename(dir)}/main` })
    expect((await resolveConfig({ dir, env: { ROOM_ROOM: 'local/lead' } })).room).toBe('local/lead')
    expect((await resolveConfig({ dir, env: {}, args: { room: 'local/mine' } })).room).toBe('local/mine')
    expect((await resolveConfig({ dir, env: { ROOM_SERVER: 'wss://team.example' } })).legacyLocalRoom).toBeUndefined()
  })

  it('leaves a custom local name untouched', async () => {
    const dir = repo()
    const choice = { where: 'local', at: 1, by: 'rohanz', room: 'local/experiments' }
    await remember(dir, choice)
    const config = await resolveConfig({ dir, env: {} })
    expect(config.room).toBe('local/experiments')
    expect(config.legacyLocalRoom).toBeUndefined()
    expect(await migrateLegacyLocalChoice(dir)).toBeUndefined()
    expect(await remembered(dir)).toEqual(choice)
  })

  it('leaves a team choice untouched', async () => {
    const dir = repo()
    const choice = { where: 'wss://team.example', at: 1, by: 'rohanz', room: `local/${basename(dir)}/main` }
    await remember(dir, choice)
    expect((await resolveConfig({ dir, env: {} })).legacyLocalRoom).toBeUndefined()
    expect(await migrateLegacyLocalChoice(dir)).toBeUndefined()
    expect(await remembered(dir)).toEqual(choice)
  })

  it('never rewrites a local room chosen explicitly under 0.17, whatever its shape', async () => {
    const dir = repo(), room = `local/${basename(dir)}/scratch`
    await writeChoice(dir, 'local', 'rohanz', room)
    const config = await resolveConfig({ dir, env: {} })
    expect(config.room).toBe(room)
    expect(config.legacyLocalRoom).toBeUndefined()
    expect(await migrateLegacyLocalChoice(dir)).toBeUndefined()
    expect((await remembered(dir)).room).toBe(room)
  })

  it('a join moves to the repository room and says so exactly once across two joins (socket integration)', async () => {
    const dir = repo(), base = basename(dir), from = `local/${base}/redesign-wave0`
    await remember(dir, { where: 'local', at: 1, by: 'Ada', room: from })
    const lines: string[] = []
    const join = async () => {
      let s: Session | null = null
      const tools = createTools({ getSession: () => s, setSession: x => { s = x }, cwd: dir,
        join: async opts => { const joined = await joinSession({ ...opts, log: line => lines.push(line) }); sessions.push(joined); return joined } })
      const reply = await tools.call('room_join', {})
      await tools.call('room_leave', {})
      return reply
    }
    const first = await join()
    expect(first).toContain(`joined local/${base} as Ada`)
    expect(first.split(`your remembered 0.16 branch room ${from} is now the repository room local/${base}`)).toHaveLength(2)
    expect(lines.filter(line => line.includes('remembered 0.16 branch room'))).toHaveLength(1)
    const second = await join()
    expect(second).toContain(`joined local/${base} as Ada`)
    expect(second).not.toContain('0.16 branch room')
    expect(lines.filter(line => line.includes('remembered 0.16 branch room'))).toHaveLength(1)
    expect((await remembered(dir)).room).toBeUndefined()
  }, 60_000)
})
