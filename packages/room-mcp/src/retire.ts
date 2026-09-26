import fs from 'node:fs'
import path from 'node:path'
import { worktreeGitDirSync } from '@room/roomd'
import type { RetiredWorker, Worker } from '@room/shared'
import type { Session } from './session.js'

/** All retirement paths withdraw the worker's private retained publisher first. */
export function retireCollected(s: Session, w: Worker, record: RetiredWorker): void {
  if (fs.existsSync(path.join(w.dir, '.git'))) fs.rmSync(path.join(worktreeGitDirSync(w.dir), 'room-retained-declared.json'), { force: true })
  s.room.retireParticipant(w.name, record)
}
