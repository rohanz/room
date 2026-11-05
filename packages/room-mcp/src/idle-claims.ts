import type { PresenceKind } from './hosts/types.js'
/** The idle-release file journal is independent of worker lifecycle storage. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { participantRecord, type RoomDoc } from '@room/shared'
import { privateStateDirectory } from '@room/relay'
import { withGuard, writeAtomic } from './leases.js'
import { idleClaimsDue } from './worker-status.js'
export interface IdleClaimsAction {
  roomKey: string; sessionId: string; participant: string; idleEpoch: string; epoch?: string
  host: PresenceKind; lastActivityMs: number; monotonicMs: () => number
  doc: RoomDoc; postNotice: (id: string, text: string) => void | { ok: boolean; text?: string } | Promise<{ ok: boolean; text?: string }>
  /** The local name lease must still belong to this process and epoch after guard acquisition. */
  ownsParticipant?: () => boolean
}
interface IdleReleaseRecord {
  state: 'pending' | 'done'; claimIds: string[]; claimNames: string[]; hadScope: boolean
  /** Replay identity is stored in the record: a restarted presence clock need not repeat its old idle epoch. */
  roomKey?: string; sessionId?: string; participant?: string; idleEpoch?: string; scopeAt?: number
}
const readJson = <T>(file: string): T | undefined => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T }
  catch (e) { if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return undefined; throw e }
}
const files = (dir: string, suffix: string): string[] => {
  try { return fs.readdirSync(dir).filter(n => n.endsWith(suffix)).map(n => path.join(dir, n)) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
}
const GUARD_WAIT_MS = 30_000
const GUARD_POLL_MS = 25
const guardBusy = (error: unknown): boolean => error instanceof Error && error.message.startsWith('lease guard busy: ')
const pauseForGuard = async (deadline: number, error: unknown): Promise<void> => {
  if (!guardBusy(error)) throw error
  const remaining = deadline - performance.now()
  if (remaining <= 0) throw new Error(`registry guard wait exceeded ${GUARD_WAIT_MS} ms: ${(error as Error).message}`)
  await new Promise<void>(resolve => setTimeout(resolve, Math.min(GUARD_POLL_MS, remaining)))
}
/** Retry acquisition only; a callback that entered its guard is never replayed. */
async function guarded<T>(file: string, fn: () => T, deadline = performance.now() + GUARD_WAIT_MS): Promise<T> {
  for (;;) {
    let entered = false
    try { return withGuard<T>(file, (() => { entered = true; return fn() }) as () => T extends PromiseLike<unknown> ? never : T) }
    catch (error) { if (entered) throw error; await pauseForGuard(deadline, error) }
  }
}
export class IdleClaimsJournal {
  private readonly root: string
  private constructor(readonly commonDir: string) { this.root = path.join(commonDir, 'room', 'registry') }
  static open(commonDir: string): IdleClaimsJournal { return new IdleClaimsJournal(commonDir) }
  private quarantine(file: string, why: unknown): void {
    const dir = path.join(this.root, 'quarantine')
    privateStateDirectory(dir)
    const dest = path.join(dir, `${path.basename(file)}.bad-${Date.now()}-${randomBytes(4).toString('hex')}`)
    try { fs.renameSync(file, dest); process.stderr.write(`[room] quarantined ${file}: ${why}\n`) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
  private idleClaimsDir(sessionId: string): string {
    return path.join(this.commonDir, 'room', 'sessions', sessionId.replace(/[^a-zA-Z0-9_-]/g, '_'), 'idle-claims')
  }

  private idleClaimsFile(roomKey: string, sessionId: string, idleEpoch: string): string {
    const key = createHash('sha256').update(`${roomKey}\0${sessionId}\0${idleEpoch}`).digest('hex')
    return path.join(this.idleClaimsDir(sessionId), `${key}.json`)
  }

  private pendingIdleClaims(roomKey: string, sessionId: string, idleEpoch: string, participant?: string): { file: string; record: IdleReleaseRecord } | undefined {
    const direct = this.idleClaimsFile(roomKey, sessionId, idleEpoch)
    const candidates = [direct, ...files(this.idleClaimsDir(sessionId), '.json').filter(file => file !== direct)]
    for (const file of candidates) {
      let record: IdleReleaseRecord | undefined
      try { record = readJson<IdleReleaseRecord>(file) } catch (error) { this.quarantine(file, error); continue }
      if (!record || record.state !== 'pending' || !Array.isArray(record.claimIds) || !Array.isArray(record.claimNames)) continue
      if (file !== direct && (record.roomKey !== roomKey || record.sessionId !== sessionId || !record.idleEpoch)) continue
      if (participant && record.participant && record.participant !== participant) continue
      return { file, record }
    }
    return undefined
  }

  hasPendingIdleClaims(roomKey: string, sessionId: string, idleEpoch: string): boolean {
    return !!this.pendingIdleClaims(roomKey, sessionId, idleEpoch)
  }

  /** Callable by the wave-4 presence loop; its durable journal makes crash replay idempotent. */
  async reconcileIdleClaims(action: IdleClaimsAction): Promise<boolean> {
    const { doc, participant } = action
    const ownsNow = (): boolean => {
      const holder = participantRecord(doc, participant)?.holder
      if (action.ownsParticipant?.() !== true) return false
      return holder ? holder.sessionId === action.sessionId && action.epoch === String(holder.epoch) : true
    }
    if (!ownsNow()) return false
    const claims = [...doc.claims.values()].filter(c => c.by === participant && c.byKind !== 'human')
    const hasScope = doc.scopes.has(participant)
    const replay = this.pendingIdleClaims(action.roomKey, action.sessionId, action.idleEpoch, participant)
    const file = replay?.file ?? this.idleClaimsFile(action.roomKey, action.sessionId, action.idleEpoch)
    if (!replay && !fs.existsSync(file) && !idleClaimsDue({ host: action.host, lastActivityMs: action.lastActivityMs,
      nowMs: action.monotonicMs(), heldClaims: claims.length, hasScope })) return false
    const pending = await guarded(file, () => {
      // Async guard acquisition may outlive this participant's name lease.
      if (!ownsNow()) return false
      let journal = readJson<IdleReleaseRecord>(file)
      if (journal?.state === 'done') return false
      if (!journal) {
        journal = { state: 'pending', claimIds: claims.map(c => c.id),
          claimNames: claims.map(c => c.path.endsWith('/') ? c.path : `${c.path}:${c.from}-${c.to}`), hadScope: hasScope,
          roomKey: action.roomKey, sessionId: action.sessionId, participant, idleEpoch: action.idleEpoch,
          ...(hasScope ? { scopeAt: doc.scope(participant)?.at } : {}) }
        writeAtomic(file, journal)
      }
      const pending = journal
      doc.doc.transact(() => {
        for (const claimId of pending.claimIds) {
          const current = doc.claims.get(claimId)
          if (current?.by === participant && current.byKind !== 'human') doc.removeClaim(claimId)
        }
        if (pending.hadScope && (pending.scopeAt === undefined || doc.scope(participant)?.at === pending.scopeAt)) doc.clearScope(participant)
      })
      return pending
    })
    if (!pending) return false
    const noticeId = `idle-claims:${pending.sessionId ?? action.sessionId}:${pending.idleEpoch ?? action.idleEpoch}`
    const names = pending.claimNames.length ? `released claims ${pending.claimNames.join(', ')}` : 'released no claims'
    const posted = await action.postNotice(noticeId, `${participant} ${names}${pending.hadScope ? ' and cleared its scope' : ''} after 8 h idle`)
    if (posted?.ok === false) return false
    return guarded(file, () => {
      const current = readJson<IdleReleaseRecord>(file)
      if (!current || current.state === 'done') return false
      writeAtomic(file, { ...current, state: 'done' })
      return true
    })
  }
}
