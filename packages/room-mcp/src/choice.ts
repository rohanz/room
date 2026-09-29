/**
 * Which room a clone joins, chosen by instruction and remembered per clone.
 *
 * Precedence: explicit `where` argument > ROOM_SERVER/ROOM_URL env > the choice remembered in the clone
 * (`<git common dir>/room-choice.json`) > local. Joining the team room from a clone that never
 * has is always an explicit instruction (argument or env), never inferred: that is the moment
 * uncommitted work becomes visible to the repo's room members.
 */
import fs from 'node:fs'
import path from 'node:path'
import { git } from '@room/roomd/git'
import { gitCommonDir } from '@room/roomd'
import { DEFAULT_SERVER, LOCAL, normaliseWhere } from './config.js'
import { acquireOwnedFile } from './owned-file.js'
import { withGuard, writeAtomic } from './leases.js'

const CHOICE_FILE = 'room-choice.json'

export interface RoomChoice { where: string; at: number; by?: string; /** Explicit local room selected by room_join; absent in older choices. */ room?: string; /** Auto-selected labels keyed by canonical worktree root; empty means the bare login. */ tags?: Record<string, string> }

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
    const { tag, share: _share, warned: _warned, warnedLevels: _warnedLevels, ...choice } = c as RoomChoice & { tag?: string; share?: unknown; warned?: unknown; warnedLevels?: unknown }
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
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')) as RoomChoice & { tag?: string } } catch { /* new choice */ }
    const tags = typeof prev?.tag === 'string' ? { [fs.realpathSync(path.dirname(path.dirname(file)))]: prev.tag, ...prev.tags } : prev?.tags
    const c: RoomChoice = { where, at: Date.now(), ...(by ? { by } : {}), ...(where === LOCAL && room ? { room } : {}), ...(tags ? { tags } : {}) }
    writeAtomic(file, c)
    return c
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

/** Migration removes old sharing authority after PolicyStore has persisted its replacement. */
export async function removeSharingChoice(dir: string): Promise<void> {
  const file = await choiceFile(dir)
  withGuard(`${file}.lock`, () => {
    let raw: Record<string, unknown>
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    delete raw.share
    delete raw.warned
    delete raw.warnedLevels
    writeAtomic(file, raw)
  })
}

export async function clearChoice(dir: string): Promise<boolean> {
  try { fs.rmSync(await choiceFile(dir)); return true } catch { return false }
}

/** One word for humans: "local" or "team", else the URL. */
export function describeWhere(server: string): string {
  if (server === LOCAL) return 'local (this machine)'
  if (server === DEFAULT_SERVER) return `team (${DEFAULT_SERVER})`
  return `team (${server})`
}
