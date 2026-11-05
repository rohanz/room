/**
 * Local rooms from the clone's side: which room a worktree belongs to and where the relay's
 * discovery file lives. The relay itself (y-websocket relay, key, browser view, health) is
 * @room/relay, owned by its standalone daemon.
 */
import path from 'node:path'
import { gitCommonDir } from './git-dirs.js'

export type { LocalRelay, LocalRelayInfo } from '@room/relay'

/** The main worktree's checkout (the directory holding the common .git). */
export async function mainWorktree(dir: string): Promise<string> {
  const common = await gitCommonDir(dir)
  return path.basename(common) === '.git' ? path.dirname(common) : path.resolve(dir)
}

/** Every worktree of a clone shares its branchless local repository room. */
export async function localRoomName(dir: string): Promise<string> {
  const main = await mainWorktree(dir)
  return `local/${path.basename(main)}`
}
