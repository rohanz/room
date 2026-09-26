import fs from 'node:fs'
import path from 'node:path'
import { retainedDeclaredFile, splitRoomUrl } from '@room/roomd'
import type { RetiredWorker, Worker } from '@room/shared'
import type { Session } from './session.js'

/** All retirement paths withdraw the worker's private retained publisher first. */
export function retireCollected(s: Session, w: Worker, record: RetiredWorker): void {
  if (fs.existsSync(path.join(w.dir, '.git'))) fs.rmSync(retainedDeclaredFile(w.dir, s.roomName, w.name, splitRoomUrl(s.roomUrl).serverUrl), { force: true })
  s.room.retireParticipant(w.name, record)
}

/** Legacy archives can still contain live coordination; repair through normal retirement cleanup. */
export function repairRetired(s: Session, present: ReadonlySet<string>): void {
  for (const { worker, record } of s.room.legacyRetirements(present)) retireCollected(s, worker, record)
}
