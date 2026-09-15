/**
 * Local rooms from the clone's side: which room a worktree belongs to and where the relay's
 * discovery file lives. The relay itself (y-websocket relay, key, browser view, health) is
 * @room/relay; `ensureLocalRelay` here is the thin call into it.
 */
import path from 'node:path'
import { ensureLocalRelay as relayEnsure, type LocalRelay } from '@room/relay'
import { git } from './git.js'

export type { LocalRelay, LocalRelayInfo } from '@room/relay'

/** The git dir shared by every worktree of a clone; the relay file lives there. */
export async function gitCommonDir(dir: string): Promise<string> {
  const out = (await git(dir, ['rev-parse', '--git-common-dir'])).trim()
  return path.resolve(dir, out)
}

/** The main worktree's checkout (the directory holding the common .git). */
export async function mainWorktree(dir: string): Promise<string> {
  const common = await gitCommonDir(dir)
  return path.basename(common) === '.git' ? path.dirname(common) : path.resolve(dir)
}

/** Local room name: local/<repo basename>/<branch of the main worktree>, so every worktree of a clone shares one room. */
export async function localRoomName(dir: string, localBranch?: string): Promise<string> {
  const main = await mainWorktree(dir)
  let branch = localBranch
  if (!branch) {
    try { branch = (await git(main, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() } catch { branch = 'main' }
    if (!branch || branch === 'HEAD') branch = 'detached'
  }
  return `local/${path.basename(main)}/${branch}`
}

/** Find the clone's local relay or become it (see @room/relay). */
export function ensureLocalRelay(commonDir: string, room: string, opts: Parameters<typeof relayEnsure>[2] = {}): Promise<LocalRelay> {
  return relayEnsure(commonDir, room, opts)
}
