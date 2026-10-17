import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { digestPath, manifestHeadOf, participantRecord, participantsView, snapshotMetadata, type ParticipantMetadataSnapshot } from '@room/shared'
import { git, gitBlobInfoMany } from '@room/roomd/git'
import { containedRepoPath, DISK_READ_PATH, validRepoPath } from '@room/roomd'
import { readBoundedDiskText } from './tools/disk-text.js'
import { checkoutPublisher } from './tools/share.js'
import type { Session } from './session.js'
import type { WorkerRecord } from './worker-status.js'

type Publication = NonNullable<WorkerRecord['keptPublication']>
const MAX_PATHS = 2000, MAX_PATH_BYTES = 128 * 1024
const failedAttempts = new WeakMap<Session, { key: string; until: number; publication: Publication }>()

/** A requested full reconciliation is queued after application, including when a
 * stale scan is in flight. It may fail without throwing, so also verify the exact
 * post-application content before acknowledging its complete publication. */
export async function acknowledgeKeptPublication(s: Session, previous: Publication | undefined, paths: readonly string[],
  written: readonly { p: string; after: Buffer | null }[] = [], timeoutMs = 5000, retryNow = false): Promise<Publication> {
  const required = [...new Set([...(previous?.paths ?? []), ...paths])].sort()
  const publisher = checkoutPublisher(s) ?? s.me.name, head = manifestHeadOf(s.room, publisher)
  const holder = participantRecord(s.room, publisher)?.holder
  const key = JSON.stringify([publisher, holder?.sessionId, holder?.epoch, s.room.roomSalt, head?.fence, head?.rev, required, previous?.overflow])
  const failed = failedAttempts.get(s)
  // Only pending outcomes are reused, briefly. Recovery in the same generation
  // is retried after one second; publication progress retries immediately.
  if (!retryNow && failed?.key === key && performance.now() < failed.until) return failed.publication
  const publication = await acknowledgeOnce(s, previous, paths, written, timeoutMs)
  if (publication.pending) failedAttempts.set(s, { key, until: performance.now() + 1000, publication })
  else failedAttempts.delete(s)
  return publication
}

async function acknowledgeOnce(s: Session, previous: Publication | undefined, paths: readonly string[],
  written: readonly { p: string; after: Buffer | null }[], timeoutMs: number): Promise<Publication> {
  const all = [...new Set([...(previous?.paths ?? []), ...paths])].sort()
  const retained: string[] = []
  let bytes = 0
  for (const p of all) { bytes += Buffer.byteLength(p); if (retained.length >= MAX_PATHS || bytes > MAX_PATH_BYTES) break; retained.push(p) }
  const overflow = previous?.overflow || retained.length !== all.length
  const pending: Publication = { paths: retained, pending: true, ...(overflow ? { overflow: true } : {}) }
  if (overflow || !s.daemon?.reconcileGitChanges || !s.daemon?.settle || !s.daemon.fence || (checkoutPublisher(s) ?? s.me.name) !== s.me.name) return pending
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      (async (): Promise<Publication> => {
        const [format, expectedHead] = (await git(s.dir, ['rev-parse', '--show-object-format', 'HEAD'])).trim().split('\n')
        if (format !== 'sha1' && format !== 'sha256') return pending
        const hash = (bytes: Buffer) => createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
        const required = new Map<string, string | null>()
        const root = fs.realpathSync(s.dir)
        const diskHash = async (p: string): Promise<string | null> => {
          const file = path.join(root, p)
          try {
            const safe = containedRepoPath(root, file, { leaf: 'read-contained-link' })
            if (!safe.ok) throw new Error('unsafe publication verification path')
            const text = await readBoundedDiskText(safe.path, 'latin1', { root, path: file })
            return hash(Buffer.from(text, 'latin1'))
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return null }
        }
        for (const p of pending.paths) {
          if (!validRepoPath(p, DISK_READ_PATH)) return pending
          required.set(p, await diskHash(p))
        }
        // Fixed after-images prevent an in-flight pre-application scan from being
        // acknowledged merely because its revision advanced.
        for (const { p, after } of written) if (required.has(p)) required.set(p, after === null ? null : hash(after))
        await s.daemon.reconcileGitChanges()
        await s.daemon.settle()
        const publisher = checkoutPublisher(s) ?? s.me.name
        const meta = snapshotMetadata(s.room, publisher, s.awareness ? participantsView(s.room, s.awareness, Date.now()) : [])
        const record = meta?.record, head = meta?.head
        if (publisher !== s.me.name || !head?.complete || head.level !== 'full' || head.coverage.kind !== 'all'
          || !meta?.fenceValid || !record?.holder || head.fence !== s.daemon.fence || head.fence !== record.git?.fence
          || head.base !== record.git.base || record.git.head !== expectedHead || String(record.holder.epoch) !== head.fence) return pending
        const entries = s.room.manifest.get(`${publisher}\0${head.fence}`)
        const base = await gitBlobInfoMany(s.dir, head.base, pending.paths)
        const normalized: string[] = []
        for (const [p, expected] of required) {
          const entry = entries?.get(p)
          if (entry && (entry.fence !== head.fence || (entry.state !== 'shared' && (entry.held !== 'binary' || !entry.hash)))) return pending
          if (!entry && (!meta.roomSalt || head.excluded.includes(digestPath(meta.roomSalt, p)))) return pending
          if (entry?.state === 'shared' && entry.change !== 'D') {
            const text = s.room.overlayText(`${publisher}\0${head.fence}`, p)?.toString()
            if (text === undefined || hash(Buffer.from(text, 'utf8')) !== entry.hash) return pending
          }
          const published = entry?.change === 'D' ? null : entry?.hash ?? base.get(p)?.hash ?? null
          if (published !== expected) {
            // A Git-clean CRLF checkout is absent from changedSince(), while the
            // committed blob is LF. Only absent committed paths may use Git's
            // clean filters; published entries still require the exact raw hash.
            if (entry || expected === null || !base.get(p)) return pending
            normalized.push(p)
          }
        }
        for (let offset = 0; offset < normalized.length;) {
          const chunk: string[] = []
          let argumentBytes = 0
          while (offset < normalized.length && chunk.length < 128) {
            const p = normalized[offset], size = Buffer.byteLength(p) + 3
            if (chunk.length && argumentBytes + size > 16 * 1024) break
            chunk.push(p); argumentBytes += size; offset++
          }
          // Named files use their own .gitattributes/autocrlf clean filters.
          // Batch arguments are bounded for Windows as well as POSIX hosts.
          const hashes = (await git(s.dir, ['hash-object', '--', ...chunk])).trim().split('\n')
          if (hashes.length !== chunk.length) return pending
          for (let i = 0; i < chunk.length; i++) {
            const p = chunk[i]
            if (hashes[i] !== base.get(p)!.hash || await diskHash(p) !== required.get(p)) return pending
          }
        }
        // A replacement or publication during the verification cannot inherit this ack.
        const current = manifestHeadOf(s.room, publisher), holder = participantRecord(s.room, publisher)?.holder
        if (!current || current.fence !== head.fence || current.rev !== head.rev || holder?.sessionId !== record.holder.sessionId
          || s.room.roomSalt !== meta.roomSalt || !meta.roomSalt || !/^[a-f0-9]{64}$/i.test(meta.roomSalt)) return pending
        return { paths: pending.paths, pending: false, ack: { publisher, sessionId: record.holder.sessionId, fence: head.fence, rev: head.rev, roomSalt: meta.roomSalt } }
      })(),
      new Promise<Publication>(resolve => { timer = setTimeout(() => resolve(pending), timeoutMs) }),
    ])
  } catch { return pending }
  finally { if (timer) clearTimeout(timer) }
}

export function keptPublicationMatches(s: Session, publication: Publication | undefined, captured?: ParticipantMetadataSnapshot, base?: string): boolean {
  const ack = publication?.ack
  if (!ack || publication?.pending || publication?.overflow) return false
  if (base !== undefined && publication.base !== base) return false
  if (captured && captured.name !== ack.publisher) return false
  const meta = captured ?? snapshotMetadata(s.room, ack.publisher, s.awareness ? participantsView(s.room, s.awareness, Date.now()) : [])
  const head = meta?.head, record = meta?.record
  return !!meta?.fenceValid && !!head?.complete && head.level === 'full' && head.coverage.kind === 'all' && head.fence === ack.fence
    && !!ack.roomSalt && meta.roomSalt === ack.roomSalt
    && head.rev >= ack.rev && head.base === record?.git?.base && record.git.fence === head.fence
    && record.holder?.sessionId === ack.sessionId && String(record.holder.epoch) === head.fence
}
