/**
 * Which room a clone joins, chosen by instruction and remembered per clone.
 *
 * Precedence: explicit `where` argument > ROOM_SERVER/ROOM_URL env > the choice remembered in the clone
 * (`<git common dir>/room-choice.json`) > local. Joining the team room from a clone that never
 * has is always an explicit instruction (argument or env), never inferred: that is the moment
 * uncommitted work becomes visible to the repo's room members.
 *
 * 0.17 writes carry `schema: 2`. A local choice without it was written by 0.16 (or an rc before rc7), whose
 * remembered local room may be a per-branch room; the first local join moves it to the repository room.
 */
import fs from 'node:fs'
import path from 'node:path'
import { git } from '@room/roomd/git'
import { gitCommonDir } from '@room/roomd'
import { mainWorktree } from '@room/roomd/local'
import { LOCAL, normaliseWhere } from './config.js'
import { acquireOwnedFile } from './owned-file.js'
import { withGuard, writeAtomic } from './leases.js'
import { legacyLocalBranchRoom } from './room-name.js'

const CHOICE_FILE = 'room-choice.json'
/** Marks a choice written by Room 0.17 or later: its room is never a 0.16 per-branch room. */
const SCHEMA = 2

export interface RoomChoice { where: string; at: number; by?: string; /** Explicit local room selected by room_join; absent in older choices. */ room?: string; /** Auto-selected labels keyed by canonical worktree root; empty means the bare login. */ tags?: Record<string, string>; share?: unknown; warned?: unknown; warnedLevels?: unknown; schema?: number }

/** "team"/"hosted" → this person's team server; "local" or empty → local; anything else is a server URL. */
export { normaliseWhere }

export async function choiceFile(dir: string): Promise<string> {
  return path.join(await gitCommonDir(dir), CHOICE_FILE)
}

/** Canonical top-level directory, even when called from a subdirectory or symlink. */
export async function worktreePath(dir: string): Promise<string> {
  return fs.realpathSync((await git(dir, ['rev-parse', '--show-toplevel'])).trim())
}

export async function readChoice(dir: string): Promise<RoomChoice | undefined> {
  try {
    const file = await choiceFile(dir)
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as RoomChoice & { tag?: string }
    if (!c || typeof c.where !== 'string') return undefined
    const { tag, ...choice } = c
    if (typeof tag === 'string') {
      const main = fs.realpathSync(path.dirname(path.dirname(file)))
      choice.tags = { [main]: tag, ...choice.tags }
    }
    return choice
  } catch { return undefined }
}

export async function writeChoice(dir: string, where: string, by?: string, room?: string): Promise<RoomChoice> {
  where = where.replace(/\?.*$/, '') // never remember a token; it comes from ROOM_SERVER/ROOM_TOKEN at join time
  const file = await choiceFile(dir)
  return withGuard(`${file}.lock`, () => {
    let prev: RoomChoice & { tag?: string } | undefined
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')) as RoomChoice & { tag?: string } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (fs.existsSync(file) && (!prev || typeof prev !== 'object' || typeof prev.where !== 'string')) throw new Error(`cannot rewrite unreadable Room choice ${file}`)
    const tags = typeof prev?.tag === 'string' ? { [fs.realpathSync(path.dirname(path.dirname(file)))]: prev.tag, ...prev.tags } : prev?.tags
    const c: RoomChoice = { where, at: Date.now(), ...(by ? { by } : {}), ...(where === LOCAL && room ? { room } : {}), ...(tags ? { tags } : {}),
      ...(prev && 'share' in prev ? { share: prev.share } : {}), ...(prev && 'warned' in prev ? { warned: prev.warned } : {}),
      ...(prev && 'warnedLevels' in prev ? { warnedLevels: prev.warnedLevels } : {}), schema: SCHEMA }
    writeAtomic(file, c)
    return c
  })
}

/**
 * Move a remembered 0.16 per-branch local room (`local/<main worktree basename>/<branch>`) to the repository room,
 * keeping every other field. Returns the one-time notice only to the caller that rewrote the file.
 */
export async function migrateLegacyLocalChoice(dir: string): Promise<string | undefined> {
  const file = await choiceFile(dir)
  const base = path.basename(await mainWorktree(dir))
  return withGuard(`${file}.lock`, () => {
    let prev: Record<string, unknown>
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> } catch { return undefined }
    if (!prev || typeof prev !== 'object' || normaliseWhere(prev.where as string) !== LOCAL || prev.schema !== undefined || typeof prev.room !== 'string') return undefined
    const from = prev.room.trim(), to = legacyLocalBranchRoom(from, base)
    if (!to) return undefined
    const { room: _room, ...rest } = prev
    writeAtomic(file, { ...rest, schema: SCHEMA })
    return `your remembered 0.16 branch room ${from} is now the repository room ${to}; Room 0.17 has one room per repository, shared by every branch`
  })
}

/** Remember an automatically assigned identity without changing this clone's room choice. */
export async function rememberTag(dir: string, tag: string): Promise<RoomChoice> {
  const file = await choiceFile(dir)
  const lock = `${file}.lock`
  const deadline = Date.now() + 5000
  let release: (() => void) | undefined
  while (!release) {
    release = acquireOwnedFile(lock, { pid: process.pid })
    if (release) break
    if (Date.now() >= deadline) throw new Error('timed out waiting to remember Room name')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  try {
    const prev = await readChoice(dir)
    if (!prev && fs.existsSync(file)) throw new Error(`cannot rewrite unreadable Room choice ${file}`)
    const key = await worktreePath(dir)
    const c: RoomChoice = { ...(prev ?? { where: LOCAL, at: Date.now() }), tags: { ...prev?.tags, [key]: tag } }
    const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    try { fs.writeFileSync(temp, JSON.stringify(c) + '\n', { mode: 0o600 }); fs.renameSync(temp, file) }
    finally { fs.rmSync(temp, { force: true }) }
    return c
  } finally {
    release()
  }
}

/** Forget the destination and tags. The separate sharing baseline survives room_leave. */
export async function clearChoice(dir: string): Promise<boolean> {
  try { fs.rmSync(await choiceFile(dir)); return true } catch { return false }
}

/** One word for humans: "local" or "team", else the URL. */
export function describeWhere(server: string): string {
  if (server === LOCAL) return 'local (this machine)'
  return `team (${server})`
}
