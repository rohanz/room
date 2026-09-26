/** Owns the worktree-private record of declared files kept visible after task scope ends. */
import fs from 'node:fs'
import path from 'node:path'
import { readRecordSync, worktreeGitDirSync, writeRecordSync } from './git-dirs.js'
import { RECORDED_PATH, validRepoPath } from './repo-path.js'

export class RetainedDeclaredPaths extends Set<string> {
  private readonly file: string

  constructor(dir: string, private readonly room: string, private readonly participant: string, server: string) {
    super()
    this.server = normaliseServer(server)
    this.file = path.join(worktreeGitDirSync(dir), 'room-retained-declared.json')
    const record = readRecordSync<{ server?: unknown; room?: unknown; participant?: unknown; paths?: unknown }>(this.file)
    if (record && (record.server !== this.server || record.room !== room || record.participant !== participant)) fs.rmSync(this.file, { force: true })
    if (record?.server === this.server && record.room === room && record.participant === participant && Array.isArray(record.paths)) {
      for (const value of record.paths) if (typeof value === 'string' && validRepoPath(value, RECORDED_PATH)) super.add(value)
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

function normaliseServer(server: string): string {
  const url = new URL(server)
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}
