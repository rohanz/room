import fs from 'node:fs'
import path from 'node:path'
import { commonGitDirFromDotGit } from '@room/roomd'
import { roomKey } from '@room/shared'
import { nameLeaseFile } from '../../src/names.js'
import type { Session } from '../../src/session.js'

/** Model the publisher's existing join-time local name lease, not a new proof handshake. */
export function stampLocalPublisher(session: Session): void {
  const name = session.me.name, holder = session.room.participants.get(`${name}\0holder`) as Record<string, unknown> | undefined
  if (!holder) return
  const processHolder = { ...holder, pid: holder.pid ?? process.pid, startTime: holder.startTime ?? 'fixture', executable: holder.executable ?? 'node' }
  session.room.participants.set(`${name}\0holder`, processHolder)
  const common = fs.realpathSync(commonGitDirFromDotGit(session.dir))
  const key = roomKey(session.local ? 'local' : new URL(session.roomUrl).origin, session.roomName)
  const file = nameLeaseFile(common, key, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ roomKey: key, name, worktree: fs.realpathSync(session.dir),
    holder: { ...processHolder, nonce: 'fixture-name-lease' }, at: Date.now() }))
}
