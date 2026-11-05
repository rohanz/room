/** Read-only clone-wide drain inspection. Never signals processes, edits snapshots or takes authority. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cloneId, privateStateDirectory, relayIdentity } from '@room/relay'
import { liveness, writeAtomic, type Liveness, type ProcessIdentity } from '@room/relay/leases'
import { sameStartTime, type ProcessProbe } from '@room/relay/process'

const exec = promisify(execFile)
const MAX_RECORD_BYTES = 2 * 1024 * 1024
const MAX_RECORDS = 4096
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const pidOf = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0
const has = (v: unknown, key: string): boolean => object(v) && Object.hasOwn(v, key)
const identityOf = (v: unknown): ProcessIdentity | undefined => object(v) && pidOf(v.pid)
  ? { pid: v.pid, startTime: typeof v.startTime === 'string' ? v.startTime : '', executable: typeof v.executable === 'string' ? v.executable : '' } : undefined

interface CutoverClient {
  kind: 'session' | 'mcp' | 'worker' | 'legacy-session'
  source: string
  label: string
  cwd?: string
  host?: string
  pid?: number
  liveness: Liveness
  runtime: 'legacy' | 'daemon-client'
  bindingOnly?: boolean
  reason?: string
}
export interface DaemonCutoverState {
  commonDir: string
  worktrees: string[]
  clients: CutoverClient[]
  owner?: { pid: number; port?: number; release?: string; runtime: string; liveness: Liveness; identity?: ProcessIdentity }
  issues: string[]
  blocked: boolean
  drainRecorded: boolean
  keyFingerprint?: string
  /** Required human checks; disk records cannot enumerate unrecorded hosts or viewers. */
  manual: string[]
}
interface InspectOptions {
  probe?: ProcessProbe
  authenticate?: typeof relayIdentity
  currentPid?: number
  /** This running release's freshly resolved host binding; independent of arbitration's publication poll. */
  currentSessionId?: string
  /** Only supply after admitWorkerEnvironment verifies this process's current launch nonce and checkout. */
  currentWorkerId?: string
}
const manual = [
  'Stop old-plugin launches and reconnect loops in every linked worktree, on both hosts; retain worker files and results.',
  'Close local viewers and stop nested hosts and local/team bridges, including clients without session records.',
  'Quiesce publication and validate reloadable selective snapshots plus private authority files before the last replica exits. On 0.17.25–0.17.30, establish and compare a verified checkpoint while a replica is still alive; stop success or a text export is insufficient.',
]

/** Missing is distinct from malformed/unreadable; evidence is never quarantined or deleted. */
export async function inspectDaemonCutover(commonDir: string, options: InspectOptions = {}): Promise<DaemonCutoverState> {
  commonDir = fs.realpathSync(commonDir)
  const state: DaemonCutoverState = { commonDir, worktrees: [], clients: [], issues: [], blocked: false, drainRecorded: false, manual: [...manual] }
  const currentPid = options.currentPid ?? process.pid
  const read = (file: string): Record<string, any> | undefined => {
    try {
      if (fs.statSync(file).size > MAX_RECORD_BYTES) throw new Error('record exceeds size limit')
      const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!object(value)) throw new Error('expected an object')
      return value
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') state.issues.push(`Cannot inspect ${file}: ${e instanceof SyntaxError ? 'invalid JSON' : (e as NodeJS.ErrnoException).code ?? 'invalid or oversized record'}`)
      return undefined
    }
  }
  const entries = (dir: string): string[] => {
    try {
      const names = fs.readdirSync(dir).sort()
      if (names.length > MAX_RECORDS) { state.issues.push(`Inventory exceeds ${MAX_RECORDS} records at ${dir}; drain inspection is incomplete`); return names.slice(0, MAX_RECORDS) }
      return names
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') state.issues.push(`Cannot list ${dir}: ${(e as Error).message}`)
      return []
    }
  }
  const alive = (identity?: ProcessIdentity): Liveness => identity ? liveness(identity, options.probe) : 'unknown'
  const add = (client: Omit<CutoverClient, 'liveness' | 'pid'>, identity?: ProcessIdentity) => {
    if (identity?.pid === currentPid) return
    state.clients.push({ ...client, ...(identity ? { pid: identity.pid } : !client.bindingOnly ? { reason: 'process identity is missing or malformed' } : {}), liveness: alive(identity) })
  }
  try {
    const { stdout } = await exec('git', ['--git-dir', commonDir, 'worktree', 'list', '--porcelain', '-z'], { timeout: 5000, maxBuffer: MAX_RECORD_BYTES })
    state.worktrees = stdout.split('\0').filter(v => v.startsWith('worktree ')).map(v => v.slice(9))
  } catch (e) { state.issues.push(`Cannot inventory linked worktrees: ${(e as Error).message}`) }

  const room = path.join(commonDir, 'room')
  const discovery = read(path.join(room, 'relay.json'))
  if (typeof discovery?.key === 'string') state.keyFingerprint = createHash('sha256').update(discovery.key).digest('hex')
  const lock = read(path.join(room, 'hub', 'authority.lock'))
  const lockIdentity = identityOf(lock)
  const discoveryIdentity = discovery?.lead !== undefined && discovery.lead !== true ? identityOf(discovery.lead) : identityOf(discovery)
  const invalidDiscoveryIdentity = discovery?.lead !== undefined && discovery.lead !== true &&
    (!discoveryIdentity?.startTime || !discoveryIdentity.executable || discoveryIdentity.pid !== discovery.pid)
  if (invalidDiscoveryIdentity) state.issues.push('Invalid local relay discovery process identity; preserve it and repair ownership evidence before cutover')
  if (lock && !lockIdentity) state.issues.push('Authority lock has no valid process identity; preserve it and repair ownership evidence before cutover')
  if (discovery && (!pidOf(discovery.pid) || !Number.isSafeInteger(discovery.port) || discovery.port < 1 || discovery.port > 65535 || typeof discovery.key !== 'string' || !discovery.key || discovery.schema !== 2)) {
    state.issues.push('Invalid local relay discovery; preserve it and repair ownership evidence before cutover')
  } else if (discovery || lockIdentity) {
    const identity = lockIdentity ?? (invalidDiscoveryIdentity ? undefined : discoveryIdentity)
    if (identity) {
      let health: Record<string, unknown> | undefined
      const status = alive(identity)
      if (discovery && status !== 'dead') {
        const answer = await (options.authenticate ?? relayIdentity)(discovery.port, discovery.key)
        if (answer?.proven && answer.health.clone === cloneId(commonDir) && answer.health.pid === identity.pid) health = answer.health
      }
      state.owner = { pid: identity.pid, ...(discovery ? { port: discovery.port } : {}), ...(typeof health?.release === 'string' ? { release: health.release } : {}),
        runtime: health ? String(health.runtime ?? 'session-relay') : String(discovery?.runtime ?? 'session-relay'),
        liveness: health ? 'alive' : status, identity }
      // Discovery is a hint: it cannot exempt an owner from the legacy gate without key/clone proof.
      if (state.owner.runtime === 'daemon' && status !== 'dead' && !health) state.issues.push(`Cannot authenticate daemon owner pid ${identity.pid}; unknown runtime blocks cutover`)
      const disagrees = discoveryIdentity && lockIdentity && (discoveryIdentity.pid !== lockIdentity.pid
        || !!discoveryIdentity.startTime && !!lockIdentity.startTime && !sameStartTime(discoveryIdentity.startTime, lockIdentity.startTime)
        || !!discoveryIdentity.executable && !!lockIdentity.executable && discoveryIdentity.executable !== lockIdentity.executable)
      if (disagrees && !invalidDiscoveryIdentity && (status !== 'dead' || alive(discoveryIdentity) !== 'dead')) state.issues.push(`Discovery process pid ${discoveryIdentity.pid} disagrees with authority owner pid ${lockIdentity!.pid}; rediscover before cutover`)
    }
  }

  const upgradedWorkers = new Set<string>()
  if (options.currentWorkerId) upgradedWorkers.add(options.currentWorkerId)
  const workerProcesses = new Map<string, { identity?: ProcessIdentity; runtime: CutoverClient['runtime']; processClaim: boolean }>()
  const sessions = path.join(room, 'sessions')
  for (const sid of entries(sessions)) {
    const dir = path.join(sessions, sid)
    const session = read(path.join(dir, 'session.json')), mcp = read(path.join(dir, 'mcp.json'))
    const runtime = mcp?.pid === currentPid || mcp?.runtime === 'daemon-client' && alive(identityOf(mcp)) === 'alive' ? 'daemon-client' : 'legacy'
    // Binding can change (or remain unknown) between arbitration's two-second publications.
    // The caller knows its own running contract and admitted worker; disk is evidence for other MCPs.
    const currentBinding = !!session && (!!options.currentSessionId && session.session_id === options.currentSessionId
      || !!options.currentWorkerId && session.worker_id === options.currentWorkerId)
    if ((runtime === 'daemon-client' || currentBinding) && typeof session?.worker_id === 'string') upgradedWorkers.add(session.worker_id)
    const host = typeof session?.host === 'string' ? session.host : undefined
    const cwd = typeof session?.cwd === 'string' ? session.cwd : undefined
    if (mcp) add({ kind: 'mcp', source: path.join(dir, 'mcp.json'), label: String(session?.session_id ?? sid), cwd, host, runtime }, identityOf(mcp))
    if (session) {
      const hostIdentity = Array.isArray(session.chain) ? identityOf(session.chain.find((v: unknown) => object(v) && v.pid === session.hostPid)) : undefined
      // Ancestors can be shared or long-lived processes; only the recorded host is evidence for this session.
      if (runtime !== 'daemon-client' && !currentBinding) add({ kind: 'session', source: path.join(dir, 'session.json'), label: String(session.session_id ?? sid), cwd, host, runtime, ...(!has(session, 'hostPid') ? { bindingOnly: true } : {}) }, hostIdentity ?? identityOf({ pid: session.hostPid }))
    }
  }
  const workers = path.join(room, 'registry', 'workers')
  for (const name of entries(workers).filter(v => v.endsWith('.json'))) {
    const file = path.join(workers, name), worker = read(file)
    if (!worker) continue
    const runs = Array.isArray(worker.runs) ? worker.runs : []
    const run = runs.at(-1), launch = run?.launch
    const report = run && typeof worker.id === 'string' && /^[\w-]+$/.test(worker.id) && Number.isSafeInteger(run.n)
      ? read(path.join(room, 'registry', 'runs', worker.id, `${run.n}.report.json`)) : undefined
    // An absent identity is harmless only when the record makes no process claim.
    // Even an imported/never outcome cannot erase contradictory process fields.
    const processClaim = has(launch, 'pid') || has(launch, 'process') || report?.hostProcess != null
      || launch != null && (!object(launch) || !['never', 'imported'].includes(launch.outcome))
    if (!processClaim && (launch?.outcome === 'never' || ['retired', 'abandoned'].includes(worker.phase))) continue
    const identity = identityOf(launch?.process) ?? identityOf(report?.hostProcess) ?? identityOf({ pid: launch?.pid })
    const runtime = upgradedWorkers.has(worker.id) ? 'daemon-client' : 'legacy'
    workerProcesses.set(worker.id, { identity, runtime, processClaim })
    add({ kind: 'worker', source: file, label: String(worker.name ?? worker.tag ?? name), cwd: worker.dir, host: worker.host,
      runtime, ...(!processClaim ? { bindingOnly: true } : {}) }, identity)
  }
  // Pre-session-directory plugins leave one record in each linked worktree's Git directory.
  const gitDirs = [commonDir, ...entries(path.join(commonDir, 'worktrees')).map(n => path.join(commonDir, 'worktrees', n))]
  for (const dir of gitDirs) {
    const file = path.join(dir, 'room-session.json'), session = read(file)
    if (session) {
      const worker = workerProcesses.get(session.worker_id)
      const identity = identityOf(session) ?? identityOf({ pid: session.hostPid }) ?? worker?.identity
      const processClaim = has(session, 'pid') || has(session, 'hostPid') || worker?.processClaim
      add({ kind: 'legacy-session', source: file, label: String(session.session_id ?? dir), cwd: session.cwd, host: session.host,
        runtime: options.currentSessionId && session.session_id === options.currentSessionId ? 'daemon-client' : worker?.runtime ?? 'legacy', ...(!processClaim ? { bindingOnly: true } : {}) }, identity)
    }
  }
  const record = read(path.join(room, 'daemon-cutover.json'))
  state.drainRecorded = record?.v === 1 && record.clone === cloneId(commonDir) && record.keyFingerprint === state.keyFingerprint && Number.isFinite(record.at)
  state.blocked = state.issues.length > 0 || !!(state.owner && state.owner.liveness !== 'dead' && state.owner.runtime !== 'daemon')
    || state.clients.some(c => c.runtime === 'legacy' && !c.bindingOnly && c.liveness !== 'dead')
  return state
}

export function daemonCutoverRows(state: DaemonCutoverState): string[] {
  const owner = state.owner
  const refusal = owner?.liveness === 'unknown' ? `drain required; unknown owner: pid ${owner.pid}, port ${owner.port ?? 'unknown'}` : 'drain required'
  const rows = [`${state.blocked ? 'FAIL' : 'INFO'}  local daemon cutover: ${state.blocked ? refusal : owner?.runtime === 'daemon' && owner.liveness === 'alive' ? 'authenticated daemon' : 'recorded legacy processes drained'}; ${state.worktrees.length} worktree(s); drain record ${state.drainRecorded ? 'present' : 'not yet written'}`]
  if (owner) rows.push(`INFO  local owner: pid ${owner.pid}, port ${owner.port ?? 'unknown'}, ${owner.runtime}, ${owner.liveness}${owner.release ? `, release ${owner.release}` : ''}`)
  for (const c of state.clients) rows.push(`${c.runtime === 'legacy' && !c.bindingOnly && c.liveness !== 'dead' ? 'FAIL' : 'INFO'}  cutover ${c.kind}: ${c.label}${c.host ? ` (${c.host})` : ''}; ${c.bindingOnly ? 'binding only; no process evidence' : `pid ${c.pid ?? 'unknown'}, ${c.liveness}`}, ${c.runtime}${c.cwd ? `; ${c.cwd}` : ''}${c.reason ? `; ${c.reason}; ${c.source}` : ''}`)
  rows.push(...state.issues.map(issue => `FAIL  local daemon cutover: ${issue}`))
  if (state.blocked) rows.push('FIX   Drain/save/exit all old local clients across this clone and linked worktrees, including both hosts, workers, nested hosts, bridges and viewers. Verify the old owner exited; then restart updated clients to start the daemon. Do not force-kill the sole replica or start a parallel listener. See docs/upgrading.md, Local daemon cutover.')
  return rows
}

/** Call before ensure/start and every rediscovery. A saved drain never exempts an old takeover. */
export async function requireDaemonRuntime(commonDir: string, options: InspectOptions = {}): Promise<void> {
  const state = await inspectDaemonCutover(commonDir, options)
  if (state.blocked) throw new Error(daemonCutoverRows(state).join('\n'))
  if (state.drainRecorded) return
  privateStateDirectory(path.join(state.commonDir, 'room'))
  writeAtomic(path.join(state.commonDir, 'room', 'daemon-cutover.json'), { v: 1, clone: cloneId(state.commonDir), at: Date.now(),
    ...(state.keyFingerprint ? { keyFingerprint: state.keyFingerprint } : {}),
    ...(state.owner?.liveness === 'dead' ? { deadOwner: state.owner.identity } : {}),
    disregardedBindings: state.clients.filter(c => c.bindingOnly).map(c => path.relative(state.commonDir, c.source)) })
}
