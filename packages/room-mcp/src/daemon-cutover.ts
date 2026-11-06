import { sessionHostIdentity } from './hosts/session-host.js'
import { directoryChain, sessionEntries } from './session-entries.js'
/** Read-only clone-wide drain inspection. Never signals processes, edits snapshots or takes authority. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cloneId, privateStateDirectory, relayIdentity, verifyPrivatePath } from '@room/relay'
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
  checks?: string
  skipped?: boolean
  sha256?: string
  /** Further files this client's evidence is read from; they are part of its drained fingerprint. */
  evidence?: string[]
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
  const hashes = new Map<string, string>()
  // Every inventory record goes through one no-follow reader: a link or special file is an issue, never absent.
  const chains = new Map<string, ReturnType<typeof directoryChain>>()
  /** The folders from the git common dir down to `dir`, checked once per inspection; issues are reported once. */
  const folder = (dir: string) => {
    let chain = chains.get(dir)
    if (!chain) {
      chain = directoryChain(commonDir, dir)
      chains.set(dir, chain)
      if (chain.state === 'issue') state.issues.push(chain.message)
    }
    return chain.state
  }
  const read = (file: string): Record<string, any> | undefined => {
    if (folder(path.dirname(file)) !== 'present') return undefined
    const bytes = readRegular(file, MAX_RECORD_BYTES, state.issues)
    if (!bytes) return undefined
    hashes.set(file, createHash('sha256').update(bytes).digest('hex'))
    return parseObject(file, bytes, state.issues)
  }
  const entries = (dir: string): string[] => {
    if (folder(dir) !== 'present') return []
    try {
      const names = fs.readdirSync(dir).sort()
      if (names.length > MAX_RECORDS) { state.issues.push(`Inventory exceeds ${MAX_RECORDS} records at ${dir}; drain inspection is incomplete`); return names.slice(0, MAX_RECORDS) }
      return names
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') state.issues.push(`Cannot list ${dir}: ${(e as Error).message}`)
      return []
    }
  }
  /** The record's hash, or with further evidence files a hash over each file's hash ('absent' when it does not exist). */
  const fingerprint = (file: string, evidence?: string[]): string | undefined => {
    const own = hashes.get(file)
    if (own === undefined || !evidence?.length) return own
    return createHash('sha256').update([file, ...evidence].map(f => `${path.relative(commonDir, f)}:${hashes.get(f) ?? 'absent'}`).join('\n')).digest('hex')
  }
  const alive = (identity?: ProcessIdentity): Liveness => identity ? liveness(identity, options.probe) : 'unknown'
  const add = (client: Omit<CutoverClient, 'liveness' | 'pid'>, identity?: ProcessIdentity, verdict?: Liveness) => {
    if (verdict === undefined && identity?.pid === currentPid) return
    const liveness = verdict ?? alive(identity), sha256 = fingerprint(client.source, client.evidence)
    // An unchanged drained record is not judged again, but evidence that a process is alive is never suppressed.
    const resolution = resolutions.find(r => r.source === path.relative(commonDir, client.source) && r.sha256 === sha256)
    const skipped = liveness !== 'alive' && (isDrained(client.source, client.evidence) || !!resolution)
    state.clients.push({ ...client, sha256, ...(skipped ? { skipped: true, reason: resolution ? `resolved by operator at ${new Date(resolution.at).toISOString()}` : 'unchanged record previously drained' } : {}), ...(identity ? { pid: identity.pid } : !client.bindingOnly && !skipped ? { reason: 'process identity is missing or malformed' } : {}), liveness })
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

  const record = readAuthoritative(path.join(room, 'daemon-cutover.json'), state.issues)
  state.drainRecorded = record?.v === 1 && record.clone === cloneId(commonDir) && record.keyFingerprint === state.keyFingerprint && Number.isFinite(record.at)
  const drained = new Map<string, string>(state.drainRecorded && Array.isArray(record?.drainedClients)
    ? record.drainedClients.filter((v: unknown) => object(v) && typeof v.source === 'string' && typeof v.sha256 === 'string').map((v: any) => [v.source, v.sha256]) : [])
  const isDrained = (file: string, evidence?: string[]) => {
    const value = fingerprint(file, evidence)
    return value !== undefined && drained.get(path.relative(commonDir, file)) === value
  }

  const resolutionRecord = readAuthoritative(path.join(room, RESOLUTIONS), state.issues)
  const parsedResolutions = validResolutions(resolutionRecord, cloneId(commonDir))
  const resolutions = parsedResolutions ?? []
  if (resolutionRecord && !parsedResolutions) state.issues.push(`Invalid or foreign daemon cutover resolutions in ${path.join(room, RESOLUTIONS)}; they must name this clone. Inspect and remove the file before cutover`)
  const upgradedWorkers = new Set<string>()
  if (options.currentWorkerId) upgradedWorkers.add(options.currentWorkerId)
  const workerProcesses = new Map<string, { identity?: ProcessIdentity; runtime: CutoverClient['runtime']; processClaim: boolean }>()
  const sessions = path.join(room, 'sessions')
  for (const entry of sessionEntries(sessions, commonDir)) {
    if (entry.kind === 'issue') { state.issues.push(entry.message); continue }
    const dir = entry.path, sid = path.basename(dir)
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
      const hostIdentity = sessionHostIdentity(session)
      // Ancestors can be shared or long-lived processes; only the recorded host is evidence for this session.
      if (runtime !== 'daemon-client' && !currentBinding) add({ kind: 'session', source: path.join(dir, 'session.json'), label: String(session.session_id ?? sid), cwd, host, runtime, ...(!hostIdentity && !has(session, 'hostPid') && !has(session, 'chain') ? { bindingOnly: true } : {}) }, hostIdentity)
    }
  }
  const workers = path.join(room, 'registry', 'workers')
  for (const name of entries(workers).filter(v => v.endsWith('.json'))) {
    const file = path.join(workers, name), worker = read(file)
    if (!worker) continue
    const runs = Array.isArray(worker.runs) ? worker.runs : []
    const run = runs.at(-1), launch = run?.launch
    const reportFile = run && typeof worker.id === 'string' && /^[\w-]+$/.test(worker.id) && Number.isSafeInteger(run.n)
      ? path.join(room, 'registry', 'runs', worker.id, `${run.n}.report.json`) : undefined
    const report = reportFile ? read(reportFile) : undefined
    // An absent identity is harmless only when the record makes no process claim.
    // Even an imported/never outcome cannot erase contradictory process fields.
    const processClaim = has(launch, 'pid') || has(launch, 'process') || report?.hostProcess != null
      || launch != null && (!object(launch) || !['never', 'imported'].includes(launch.outcome))
    if (!processClaim && (launch?.outcome === 'never' || ['retired', 'abandoned'].includes(worker.phase))) continue
    const identity = identityOf(launch?.process) ?? identityOf(report?.hostProcess) ?? identityOf({ pid: launch?.pid })
    const runtime = upgradedWorkers.has(worker.id) ? 'daemon-client' : 'legacy'
    workerProcesses.set(worker.id, { identity, runtime, processClaim })
    const full = [
      ...(has(launch, 'process') ? [identityOf(launch.process)] : []),
      ...(has(report, 'hostProcess') ? [identityOf(report!.hostProcess)] : []),
    ]
    // A bare pid adds evidence only when no full identity (pid and start time) already names that pid: a bare pid
    // cannot tell its process from a later one that reused the number.
    const bare = has(launch, 'pid') && !full.some(value => value?.pid === launch.pid && !!value?.startTime) ? [identityOf({ pid: launch.pid })] : []
    const identities = [...full, ...bare]
    const verdicts = identities.map(alive)
    const verdict = verdicts.includes('alive') ? 'alive' : !verdicts.length || verdicts.includes('unknown') ? 'unknown' : 'dead'
    const checks = `Check any process whose working directory is in ${worker.dir ?? 'the worker worktree'}, the host session transcript for hostSessionId ${worker.hostSessionId ?? '(unknown)'}, and the worker log file ${worker.logFile ?? (typeof worker.dir === 'string' && typeof worker.tag === 'string' ? path.join(path.dirname(worker.dir), worker.tag + '.log') : '(see worker record)')}`
    add({ kind: 'worker', source: file, label: String(worker.name ?? worker.tag ?? name), cwd: worker.dir, host: worker.host,
      runtime, checks, ...(!processClaim ? { bindingOnly: true } : {}), ...(reportFile ? { evidence: [reportFile] } : {}) }, identity, verdict)
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
  state.blocked = state.issues.length > 0 || !!(state.owner && state.owner.liveness !== 'dead' && state.owner.runtime !== 'daemon')
    || state.clients.some(c => !c.skipped && c.runtime === 'legacy' && !c.bindingOnly && c.liveness !== 'dead')
  return state
}

export function daemonCutoverRows(state: DaemonCutoverState): string[] {
  const owner = state.owner
  const refusal = owner?.liveness === 'unknown' ? `drain required; unknown owner: pid ${owner.pid}, port ${owner.port ?? 'unknown'}` : 'drain required'
  const rows = [`${state.blocked ? 'FAIL' : 'INFO'}  local daemon cutover: ${state.blocked ? refusal : owner?.runtime === 'daemon' && owner.liveness === 'alive' ? 'authenticated daemon' : 'recorded legacy processes drained'}; ${state.worktrees.length} worktree(s); drain record ${state.drainRecorded ? 'present' : 'not yet written'}`]
  if (owner) rows.push(`INFO  local owner: pid ${owner.pid}, port ${owner.port ?? 'unknown'}, ${owner.runtime}, ${owner.liveness}${owner.release ? `, release ${owner.release}` : ''}`)
  for (const c of state.clients) rows.push(`${!c.skipped && c.runtime === 'legacy' && !c.bindingOnly && c.liveness !== 'dead' ? 'FAIL' : 'INFO'}  cutover ${c.kind}: ${c.label}${c.host ? ` (${c.host})` : ''}; ${c.skipped ? `${c.reason}; skipped` : c.bindingOnly ? 'binding only; no process evidence' : `pid ${c.pid ?? 'unknown'}, ${c.liveness}`}, ${c.runtime}${c.cwd ? `; ${c.cwd}` : ''}${c.reason ? `; ${c.reason}; ${c.source}` : ''}`)
  const bundle = fileURLToPath(new URL('../../../plugins/room/server/room-mcp.mjs', import.meta.url))
  const entry = import.meta.url.endsWith('/room-mcp.mjs') ? fileURLToPath(import.meta.url) : bundle
  for (const c of state.clients.filter(blockingClient)) {
    const record = path.relative(state.commonDir, c.source)
    const args = [entry, 'cutover-resolve', '--dir', state.worktrees[0] ?? state.commonDir, '--record', record, '--confirm-not-running']
    rows.push(`FIX   ${c.label}: ${c.checks ?? 'Check the recorded process and host session; save and exit it if running'}. Record ${JSON.stringify(record)}. After verifying it is not running, run (${process.platform === 'win32' ? 'PowerShell' : 'sh'}): ${cutoverResolveCommand(args)}`)
  }

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
    drainedClients: state.clients.filter(c => c.runtime === 'legacy' && c.sha256).map(c => ({ source: path.relative(state.commonDir, c.source), sha256: c.sha256 })),
    disregardedBindings: state.clients.filter(c => c.bindingOnly).map(c => path.relative(state.commonDir, c.source)) })
}

const RESOLUTIONS = 'daemon-cutover-resolutions.json'
const MAX_AUTHORITATIVE_BYTES = 1024 * 1024

/**
 * Read a regular file without following links. Absent is undefined with no issue; a link, special file, oversized
 * file or a file replaced while being read is an issue, so it can never pass for an absent one.
 */
function readRegular(file: string, limit: number, issues: string[], verify?: (file: string) => void): Buffer | undefined {
  let fd: number | undefined, seen = false
  try {
    const before = fs.lstatSync(file)
    seen = true
    if (!before.isFile()) { issues.push(`${file} must be a regular file, not a ${before.isSymbolicLink() ? 'symlink' : 'special file'}`); return undefined }
    if (before.size > limit) { issues.push(`${file} exceeds ${limit} bytes`); return undefined }
    verify?.(file)
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) { issues.push(`${file} changed while being read`); return undefined }
    if (stat.size > limit) { issues.push(`${file} exceeds ${limit} bytes`); return undefined }
    // Read to end of file, bounded: a file can grow after every size check, and a prefix is not the record.
    const chunks: Buffer[] = []
    let length = 0
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - length))
      const n = fs.readSync(fd, chunk, 0, chunk.length, length)
      if (n === 0) break
      chunks.push(chunk.subarray(0, n)); length += n
      if (length > limit) { issues.push(`${file} exceeds ${limit} bytes`); return undefined }
    }
    return Buffer.concat(chunks, length)
  } catch (error) {
    // Only absence at the first lookup is harmless; a file that disappears once seen is unreadable evidence.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !seen) return undefined
    issues.push(`Cannot inspect ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`)
    return undefined
  } finally { if (fd !== undefined) fs.closeSync(fd) }
}

function parseObject(file: string, bytes: Buffer, issues: string[]): Record<string, any> | undefined {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>
    issues.push(`${file} is not a JSON object`)
  } catch { issues.push(`Cannot inspect ${file}: invalid JSON`) }
  return undefined
}

/** A file whose content can waive a blocker (the drain record, operator resolutions) must also be private. */
function readAuthoritative(file: string, issues: string[]): Record<string, any> | undefined {
  const bytes = readRegular(file, MAX_AUTHORITATIVE_BYTES, issues, verifyPrivatePath)
  return bytes ? parseObject(file, bytes, issues) : undefined
}

/** The resolve command for this platform's shell: POSIX single quotes, or PowerShell's call operator and quotes. */
export function cutoverResolveCommand(args: string[], platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `& node ${args.map(a => "'" + a.replace(/'/g, "''") + "'").join(' ')}`
  return `node ${args.map(a => "'" + a.replace(/'/g, "'\\''") + "'").join(' ')}`
}

interface Resolution { source: string; sha256: string; at: number; note?: string }
function validResolutions(record: Record<string, any> | undefined, clone: string): Resolution[] | undefined {
  if (!record) return []
  return record.v === 1 && record.clone === clone && Array.isArray(record.resolutions) && record.resolutions.every((r: any) => object(r)
    && typeof r.source === 'string' && typeof r.sha256 === 'string' && /^[a-f0-9]{64}$/.test(r.sha256)
    && Number.isFinite(r.at) && !isNaN(new Date(r.at).getTime()) && (r.note === undefined || typeof r.note === 'string'))
    ? record.resolutions : undefined
}
const blockingClient = (c: CutoverClient) => !c.skipped && c.runtime === 'legacy' && !c.bindingOnly && c.liveness !== 'dead'

/** Explicit human attestation, scoped to the exact inspected record and evidence bytes. */
export async function resolveDaemonCutover(commonDir: string, source: string, confirmNotRunning: boolean, note?: string, options: InspectOptions = {}): Promise<void> {
  if (!confirmNotRunning) throw new Error('--confirm-not-running is required after checking the process, transcript and log')
  if (!source || path.isAbsolute(source) || source.split(/[\\/]/).includes('..')) throw new Error('--record must be relative to the git common dir')
  const state = await inspectDaemonCutover(commonDir, options)
  const client = state.clients.find(c => path.relative(state.commonDir, c.source) === source)
  if (!client || !blockingClient(client)) throw new Error('Record is not currently blocking')
  if (client.liveness === 'alive') throw new Error('Cannot resolve a live process')
  if (!client.sha256 || state.issues.length) throw new Error('Cannot resolve with incomplete inspection evidence')
  const room = path.join(state.commonDir, 'room')
  privateStateDirectory(room)
  const file = path.join(room, RESOLUTIONS), problems: string[] = []
  const previous = readAuthoritative(file, problems)
  if (problems.length) throw new Error(problems.join('; '))
  const clone = cloneId(state.commonDir), resolutions = validResolutions(previous, clone)
  if (!resolutions) throw new Error(`Invalid or foreign daemon cutover resolutions in ${file}`)
  writeAtomic(file, { v: 1, clone, resolutions: [...resolutions, { source, sha256: client.sha256, at: Date.now(), ...(note !== undefined ? { note } : {}) }] })
  verifyPrivatePath(file, true)
}
