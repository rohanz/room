import { validPid } from '@room/relay/process'
/** Legacy lifecycle codecs shared by the file store and offline importer. */
import { isHostId } from './hosts/types.js'
import type { InstanceToken } from './leases.js'
import type { WorkerRecord, RunReport, ExitObservation } from './worker-status.js'
export const safeId = (value: string): boolean => /^w_[A-Za-z0-9_-]{1,64}$/.test(value)
export const safeTag = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) && value !== '..'
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export const tokenShape = (value: unknown): value is InstanceToken => object(value) && Number.isSafeInteger(value.pid)
  && typeof value.startTime === 'string' && typeof value.executable === 'string'
  && typeof value.sessionId === 'string' && typeof value.nonce === 'string'
const processShape = (value: unknown): boolean => object(value) && Number.isSafeInteger(value.pid)
  && typeof value.startTime === 'string' && typeof value.executable === 'string'
const runShape = (value: unknown): boolean => {
  if (!object(value) || !Number.isSafeInteger(value.n) || (value.n as number) < 1
    || !['fresh', 'resume'].includes(value.mode as string) || typeof value.intentAt !== 'number'
    || typeof value.nonce !== 'string' || !Number.isSafeInteger(value.busFrontier) || !Array.isArray(value.promptMsgIds)
    || !tokenShape(value.launcher) || typeof value.logStart !== 'number') return false
  if (value.launch === undefined) return true
  if (!object(value.launch)) return false
  switch (value.launch.outcome) {
    case 'launched': return validPid(value.launch.pid) && (value.launch.process === undefined || processShape(value.launch.process) && validPid((value.launch.process as Record<string, unknown>).pid))
    case 'never': return typeof value.launch.error === 'string'
    case 'ambiguous': return typeof value.launch.at === 'number'
    case 'imported': return true
    default: return false
  }
}
export const recordShape = (value: unknown, id: string): value is WorkerRecord => object(value) && value.v === 1 && value.id === id
  && typeof value.tag === 'string' && safeTag(value.tag) && typeof value.name === 'string'
  && ['local', 'here'].includes(value.mode as string) && typeof value.room === 'string'
  && object(value.lead) && typeof value.lead.participant === 'string' && typeof value.lead.room === 'string' && tokenShape(value.lead.instance)
  && isHostId(value.host) && object(value.budget)
  && typeof value.task === 'string' && typeof value.dir === 'string' && typeof value.branch === 'string'
  && typeof value.outside === 'boolean' && (value.logFile === undefined || typeof value.logFile === 'string') && object(value.prep) && typeof value.prep.step === 'string'
  && object(value.capabilities) && typeof value.capabilities.resume === 'boolean' && typeof value.capabilities.signal === 'boolean'
  && ['delta', 'copy', 'none'].includes(value.capabilities.collect as string)
  && ['intent', 'preparing', 'prepared', 'active', 'collecting', 'discarding', 'retiring', 'retired', 'abandoned'].includes(value.phase as string)
  && Array.isArray(value.runs) && value.runs.length > 0 && value.runs.every(runShape)
  && typeof value.createdAt === 'number' && Number.isSafeInteger(value.seq)
export const reportShape = (value: unknown): value is RunReport => object(value) && Number.isSafeInteger(value.run)
  && typeof value.nonce === 'string' && Array.isArray(value.chain) && value.chain.every(processShape)
  && (value.hostProcess === undefined || value.hostProcess === null || processShape(value.hostProcess))
  && typeof value.joinedAt === 'number' && (value.hostSessionId === undefined || typeof value.hostSessionId === 'string')
  && (value.posted === undefined || typeof value.posted === 'string')
  && (value.done === undefined || (object(value.done) && typeof value.done.at === 'number'
    && typeof value.done.summary === 'string' && Array.isArray(value.done.changed)
    && (value.done.k === undefined || Number.isSafeInteger(value.done.k) && (value.done.k as number) >= 1)))
/** Schema-2 admission explicitly distinguishes an unverified parent from the worker MCP. */
export const admittedHost = (report: RunReport): RunReport['chain'][number] | undefined =>
  report.hostProcess !== undefined ? report.hostProcess ?? undefined : report.chain[1]
export const laterDone = (a: NonNullable<RunReport['done']>, b: NonNullable<RunReport['done']>): boolean =>
  (a.k ?? 1) !== (b.k ?? 1) ? (a.k ?? 1) > (b.k ?? 1) : a.at >= b.at
export const exitShape = (value: unknown): value is ExitObservation => object(value) && Number.isSafeInteger(value.run)
  && (value.code === null || Number.isSafeInteger(value.code)) && typeof value.at === 'number'
  && typeof value.witnessed === 'boolean' && (value.signal === undefined || typeof value.signal === 'string')
