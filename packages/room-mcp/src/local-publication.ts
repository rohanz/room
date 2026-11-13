import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { containedRepoPath, DISK_READ_PATH, realGitCommonDir, validRepoPath } from '@room/roomd'
import { git } from '@room/roomd/git'
import { readBoundedDiskText } from './tools/disk-text.js'
import type { ParticipantMetadataSnapshot } from '@room/shared'
import { nameLeaseFile, type NameLease } from './names.js'

/** The clone-local name lease binds the captured publisher's session/process
 * identity to this checkout. A participant name or common Git dir alone cannot
 * distinguish a replacement publisher in another checkout or on another machine. */
export async function localLeadRoot(commonDir: string,
  publisher: ParticipantMetadataSnapshot | undefined, roomKey: string | undefined) {
  if (!publisher?.fenceValid || !publisher.record?.holder || !roomKey) return undefined
  const holder = publisher.record.holder
  if (!holder.sessionId || !Number.isSafeInteger(holder.pid) || holder.pid <= 0 || !holder.startTime || !holder.executable) return undefined
  try {
    const file = nameLeaseFile(commonDir, roomKey, publisher.name)
    const lease = JSON.parse(fs.readFileSync(file, 'utf8')) as NameLease
    if (typeof lease.worktree !== 'string' || !path.isAbsolute(lease.worktree) || fs.lstatSync(lease.worktree).isSymbolicLink()) return undefined
    const root = fs.realpathSync(lease.worktree)
    if (lease.worktree !== root || await realGitCommonDir(root) !== commonDir) return undefined
    if (fs.realpathSync((await git(root, ['rev-parse', '--show-toplevel'])).trim()) !== root) return undefined
    const current = () => {
      try {
        const lease = JSON.parse(fs.readFileSync(file, 'utf8')) as NameLease
        return lease.name === publisher.name && lease.roomKey === roomKey && lease.worktree === root
          && lease.holder.sessionId === holder.sessionId && lease.holder.pid === holder.pid
          && lease.holder.startTime === holder.startTime && lease.holder.executable === holder.executable
      } catch { return false }
    }
    return current() ? { root, current } : undefined
  } catch { return undefined }
}

/** A preview reads the publication, then checks its exact bytes (or Git-clean
 * committed bytes) against the local checkout. Retain a raw-byte witness so a
 * later disk edit invalidates the preview even before the publisher scans it. */
export async function witnessPublishedPath(root: string, p: string, published: string | null,
  cleanBase: string | undefined, limit: number) {
  const raw = async (): Promise<Buffer | null> => {
    if (!validRepoPath(p, DISK_READ_PATH) || fs.realpathSync(root) !== root) throw new Error('unsafe local publication witness')
    const file = path.join(root, p)
    try {
      const safe = containedRepoPath(root, file, { leaf: 'read-contained-link' })
      if (!safe.ok) throw new Error('unsafe local publication path')
      return Buffer.from(await readBoundedDiskText(safe.path, 'latin1', { root, path: file }, limit), 'latin1')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // realpath of a missing leaf cannot establish containment. A deletion
      // witness must also rule out dangling links and outside parent links.
      if (!containedRepoPath(root, file, { leaf: 'reject-link', allowMissing: true }).ok)
        throw new Error('unsafe absent local publication path')
      return null
    }
  }
  const fingerprint = (bytes: Buffer | null) => bytes === null ? null : createHash('sha256').update(bytes).digest('hex')
  try {
    const bytes = await raw(), before = fingerprint(bytes)
    const expected = published === null ? null : Buffer.from(published, 'utf8')
    let matches = bytes === null ? expected === null : expected !== null && bytes.equals(expected)
    // Only an absent manifest entry for a present committed file may use clean
    // filters. Explicit published changes/deletions always require exact bytes.
    if (!matches && cleanBase && bytes !== null && expected !== null) {
      const format = cleanBase.length === 64 ? 'sha256' : 'sha1'
      const hash = createHash(format).update(`blob ${expected.length}\0`).update(expected).digest('hex')
      matches = (await git(root, ['hash-object', '--', p])).trim() === hash && fingerprint(await raw()) === before
    }
    return { matches, current: async () => { try { return fingerprint(await raw()) === before } catch { return false } } }
  } catch { return { matches: false, current: async () => false } }
}
