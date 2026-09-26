/** Owns the worktree-private record of declared files kept visible after task scope ends. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readRecordSync, worktreeGitDirSync, writeRecordSync } from './git-dirs.js'
import { RECORDED_PATH, validRepoPath } from './repo-path.js'

export class RetainedDeclaredPaths extends Set<string> {
  private readonly file: string

  constructor(dir: string, private readonly room: string, private readonly participant: string, server: string) {
    super()
    this.server = normaliseServer(server)
    this.file = retainedDeclaredFile(dir, room, participant, server)
    type Record = { server?: unknown; room?: unknown; participant?: unknown; paths?: unknown }
    const record = readRecordSync<Record>(this.file)
    const legacyFile = path.join(worktreeGitDirSync(dir), 'room-retained-declared.json')
    const legacy = record ? undefined : readRecordSync<Record>(legacyFile)
    const source = record ?? legacy
    if (source?.server === this.server && source.room === room && source.participant === participant && Array.isArray(source.paths)) {
      for (const value of source.paths) if (typeof value === 'string' && validRepoPath(value, RECORDED_PATH)) super.add(value)
      if (legacy) { this.save(); fs.rmSync(legacyFile, { force: true }) }
    }
  }

  private readonly server: string

  private save(): void {
    if (this.size) writeRecordSync(this.file, { server: this.server, room: this.room, participant: this.participant, paths: [...this] })
    else fs.rmSync(this.file, { force: true })
  }

  override add(path: string): this {
    if (!this.has(path)) { super.add(path); this.save() }
    return this
  }

  override delete(path: string): boolean {
    const removed = super.delete(path)
    if (removed) this.save()
    return removed
  }

  override clear(): void {
    if (this.size) { super.clear(); this.save() }
  }
}

/** One private record per publisher identity; the hash keeps URLs and names out of filenames. */
export function retainedDeclaredFile(dir: string, room: string, participant: string, server: string): string {
  const identity = JSON.stringify([normaliseServer(server), room, participant])
  const hash = createHash('sha256').update(identity).digest('hex')
  return path.join(worktreeGitDirSync(dir), `room-retained-declared-${hash}.json`)
}

/** Withdraw this publisher's current and 0.16.12 records without touching another identity. */
export function deleteRetainedDeclaredRecord(dir: string, room: string, participant: string, server: string): void {
  const gitDir = worktreeGitDirSync(dir)
  fs.rmSync(retainedDeclaredFile(dir, room, participant, server), { force: true })
  const legacyFile = path.join(gitDir, 'room-retained-declared.json')
  const legacy = readRecordSync<{ server?: unknown; room?: unknown; participant?: unknown }>(legacyFile)
  if (legacy?.server === normaliseServer(server) && legacy.room === room && legacy.participant === participant) {
    fs.rmSync(legacyFile, { force: true })
  }
}

function normaliseServer(server: string): string {
  const url = new URL(server)
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}
