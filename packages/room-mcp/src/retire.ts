import fs from 'node:fs'
import path from 'node:path'
import { PolicyStore } from './policy-store.js'
import type { RetiredWorker, Worker } from '@room/shared'
import type { Session } from './session.js'
import { releasePoster } from './post.js'

/** All retirement paths remove the worker's local sharing authority first. */
export function retireCollected(s: Session, w: Worker, record: RetiredWorker): void {
  if (fs.existsSync(path.join(w.dir, '.git'))) PolicyStore.retire(w.dir, s.roomName, w.name, new URL(s.roomUrl).origin)
  s.room.retireParticipant(w.name, record, releasePoster(s.post))
}

/** Legacy archives can still contain live coordination; repair through normal retirement cleanup. */
export function repairRetired(s: Session, present: ReadonlySet<string>): void {
  for (const { worker, record } of s.room.legacyRetirements(present)) retireCollected(s, worker, record)
}
