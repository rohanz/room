import fs from 'node:fs'
import path from 'node:path'
import { ROOM_STALE_MS } from '@room/shared'
import { leaseToken, liveness, withGuard } from './leases.js'
import type { ProcessProbe } from '@room/relay/process'

/**
 * The single collector for `<git common dir>/room/`: every file kind Room writes there, who owns it, and when
 * the collector removes it. Owners still delete their own files at the natural end (leave, release, retire);
 * this pass catches what a crash or a missed path left behind. Anything the table does not name is reported
 * (`unknown`), never removed. docs/reference.md "Local state" carries the same table; a test keeps them equal.
 */

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
/** An atomic write never takes this long; an older temporary belongs to a writer that died mid-write. */
export const GC_TEMP_AGE_MS = HOUR
/** A dead holder's lease is useless at once, but a lease written in the last hour may belong to a starting process. */
const DEAD_HOLDER_IDLE_MS = HOUR

type GcLifetime =
  | { kind: 'keep' }
  | { kind: 'age'; ms: number }
  | { kind: 'temp' }
  | { kind: 'dead-holder' }
  | { kind: 'session-dir' }
  | { kind: 'orphan-sharing' }
  | { kind: 'owner' }
  | { kind: 'foreign' }

export interface GcRule {
  /** Path pattern relative to `room/`, as the docs table prints it. */
  path: string
  owner: 'daemon' | 'MCP session' | 'lead MCP' | 'hooks' | 'none'
  lifetime: GcLifetime
  /** Which entries the rule claims: top-level name, and the file name within a directory rule. */
  match: (entry: { top: string; name?: string; isDir: boolean }) => boolean
}

const top = (names: string[], opts: { isDir?: boolean } = {}) =>
  (e: { top: string; name?: string; isDir: boolean }) => e.name === undefined && names.includes(e.top) && (opts.isDir === undefined || e.isDir === opts.isDir)
const inDir = (dir: string, test: (name: string, isDir: boolean) => boolean) =>
  (e: { top: string; name?: string; isDir: boolean }) => e.top === dir && e.name !== undefined && test(e.name, e.isDir)
const isTemp = (name: string) => name.endsWith('.tmp')

/** Top-level directories whose entries the table judges one by one. */
const GC_DIRECTORIES = ['relay', 'hub', 'hub-leases', 'names', 'publishers', 'sessions', 'hook-receipts', 'sharing', 'compat', 'browser', 'profiles', 'preview-evidence', 'registry']

export const GC_RULES: GcRule[] = [
  { path: 'relay.json, hub/incarnation.json', owner: 'daemon', lifetime: { kind: 'keep' },
    match: e => (e.top === 'relay.json' && e.name === undefined) || (e.top === 'hub' && e.name === 'incarnation.json') },
  { path: 'relay/<room>.ydoc, relay/migrated-*.json', owner: 'daemon', lifetime: { kind: 'owner' },
    match: inDir('relay', n => !isTemp(n)) },
  { path: '*.tmp (any directory)', owner: 'MCP session', lifetime: { kind: 'temp' }, match: e => isTemp(e.name ?? e.top) },
  { path: 'hub/authority.lock', owner: 'daemon', lifetime: { kind: 'dead-holder' }, match: inDir('hub', n => n === 'authority.lock') },
  { path: '*.guard (any directory)', owner: 'MCP session', lifetime: { kind: 'dead-holder' }, match: e => (e.name ?? e.top).endsWith('.guard') },
  { path: 'hub-leases/<room>.json', owner: 'daemon', lifetime: { kind: 'keep' }, match: inDir('hub-leases', n => n.endsWith('.json')) },
  { path: 'daemon.log*', owner: 'daemon', lifetime: { kind: 'owner' }, match: e => e.name === undefined && /^daemon\.log(\.\d+)?$/.test(e.top) },
  { path: 'daemon-cutover.json, daemon-cutover-resolutions.json', owner: 'MCP session', lifetime: { kind: 'keep' },
    match: top(['daemon-cutover.json', 'daemon-cutover-resolutions.json']) },
  { path: 'names/<hash>.json', owner: 'MCP session', lifetime: { kind: 'dead-holder' }, match: inDir('names', n => n.endsWith('.json')) },
  { path: 'publishers/<hash>.json', owner: 'MCP session', lifetime: { kind: 'dead-holder' }, match: inDir('publishers', n => n.endsWith('.json')) },
  { path: 'sessions/<session>/', owner: 'MCP session', lifetime: { kind: 'session-dir' }, match: inDir('sessions', (_n, isDir) => isDir) },
  { path: 'sessions/idle-episode.json', owner: 'MCP session', lifetime: { kind: 'age', ms: ROOM_STALE_MS }, match: inDir('sessions', n => n === 'idle-episode.json') },
  { path: 'hook-receipts/<hash>.json', owner: 'hooks', lifetime: { kind: 'age', ms: ROOM_STALE_MS }, match: inDir('hook-receipts', n => n.endsWith('.json')) },
  { path: 'hook-receipts/.pruned, .prune-cursor', owner: 'hooks', lifetime: { kind: 'age', ms: ROOM_STALE_MS }, match: inDir('hook-receipts', n => n.startsWith('.')) },
  { path: 'sharing/<hash>.json', owner: 'MCP session', lifetime: { kind: 'orphan-sharing' }, match: inDir('sharing', n => /^[a-f0-9]{64}\.json$/.test(n)) },
  { path: 'sharing/legacy-baseline.json (+ .lock)', owner: 'MCP session', lifetime: { kind: 'keep' }, match: inDir('sharing', n => n.startsWith('legacy-baseline.json')) },
  { path: 'compat/<hash>.json', owner: 'MCP session', lifetime: { kind: 'age', ms: 30 * DAY }, match: inDir('compat', n => n.endsWith('.json')) },
  { path: 'browser/*.html', owner: 'MCP session', lifetime: { kind: 'age', ms: HOUR }, match: inDir('browser', n => n.endsWith('.html')) },
  { path: 'profiles/*.cpuprofile', owner: 'MCP session', lifetime: { kind: 'age', ms: ROOM_STALE_MS }, match: inDir('profiles', n => n.endsWith('.cpuprofile')) },
  { path: 'preview-evidence/*.json', owner: 'MCP session', lifetime: { kind: 'age', ms: ROOM_STALE_MS }, match: inDir('preview-evidence', n => n.endsWith('.json')) },
  { path: 'registry/workers, tags, adoptions, runs, patches, collect, migration.*', owner: 'lead MCP', lifetime: { kind: 'owner' },
    match: inDir('registry', n => n !== 'quarantine') },
  { path: 'registry/quarantine/*', owner: 'MCP session', lifetime: { kind: 'age', ms: 30 * DAY }, match: inDir('registry/quarantine', () => true) },
  { path: 'storage-gate.json, storage-gate/, preflight/', owner: 'none', lifetime: { kind: 'foreign' }, match: top(['storage-gate.json', 'storage-gate', 'preflight']) },
]

export interface GcOptions { now?: () => number; probe?: ProcessProbe; /** Judge only: report what would go and what is unknown, remove nothing. */ dryRun?: boolean }
export interface GcResult { removed: string[]; unknown: string[] }

/** One pass over `<commonDir>/room`. Read-only until each removal; a file it cannot judge stays. */
export function collectLocalState(commonDir: string, options: GcOptions = {}): GcResult {
  const now = options.now ?? Date.now
  const root = path.join(commonDir, 'room')
  const removed: string[] = [], unknown: string[] = []
  const list = (dir: string) => { try { return fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] } }
  const stat = (file: string) => { try { return fs.statSync(file) } catch { return undefined } }
  const remove = (target: string, recursive = false) => {
    if (options.dryRun) { removed.push(target); return }
    try { fs.rmSync(target, { recursive, force: true }); removed.push(target) } catch { /* another process may hold or have removed it */ }
  }
  const olderThan = (file: string, ms: number) => { const s = stat(file); return !!s && now() - s.mtimeMs >= ms }
  const deadHolderIdle = (file: string) => {
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> } catch { return false }
    const holder = leaseToken(parsed)
    if (!holder || liveness(holder, options.probe) !== 'dead') return false
    const lastActive = typeof parsed.lastActive === 'number' ? parsed.lastActive : 0
    const idleSince = Math.max(lastActive, stat(file)?.mtimeMs ?? now())
    return now() - idleSince >= DEAD_HOLDER_IDLE_MS
  }
  const orphanSharing = (file: string) => {
    let record: { worktree?: string; updatedAt?: number }
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof record } catch { return false }
    if (typeof record.worktree !== 'string' || fs.existsSync(record.worktree)) return false
    return now() - Math.max(record.updatedAt ?? 0, stat(file)?.mtimeMs ?? 0) >= ROOM_STALE_MS
  }
  const apply = (rule: GcRule, target: string, isDir: boolean) => {
    const life = rule.lifetime
    switch (life.kind) {
      case 'keep': case 'owner': return
      case 'foreign': return remove(target, true)
      case 'temp': return olderThan(target, GC_TEMP_AGE_MS) ? remove(target) : undefined
      case 'age': return !isDir && olderThan(target, life.ms) ? remove(target) : undefined
      case 'dead-holder': {
        if (isDir || !deadHolderIdle(target)) return
        if (path.basename(path.dirname(target)) === 'preview-evidence' && /^[a-f0-9]{64}-publication(?:\.guard)+$/.test(path.basename(target)) && !options.dryRun) {
          // Let the lease primitive recheck/recover this exact holder and release
          // its own nonce. Blind removal could unlink a newly acquired successor.
          try { withGuard(target.slice(0, -'.guard'.length), () => { removed.push(target) }, options.probe) }
          catch { /* A live/unknown successor keeps its guard. */ }
          return
        }
        return remove(target)
      }
      case 'orphan-sharing': return !isDir && orphanSharing(target) ? remove(target) : undefined
      case 'session-dir': {
        const newest = Math.max(stat(target)?.mtimeMs ?? 0, ...list(target).map(f => stat(path.join(target, f.name))?.mtimeMs ?? 0))
        return newest && now() - newest >= ROOM_STALE_MS ? remove(target, true) : undefined
      }
    }
  }
  const judge = (key: { top: string; name?: string; isDir: boolean }, rel: string) => {
    const rule = GC_RULES.find(r => r.match(key))
    if (rule) apply(rule, path.join(root, rel), key.isDir)
    else unknown.push(rel)
  }
  for (const entry of list(root)) {
    if (!entry.isDirectory() || !GC_DIRECTORIES.includes(entry.name)) { judge({ top: entry.name, isDir: entry.isDirectory() }, entry.name); continue }
    for (const child of list(path.join(root, entry.name))) {
      if (entry.name === 'registry' && child.name === 'quarantine' && child.isDirectory()) {
        for (const bad of list(path.join(root, 'registry', 'quarantine'))) judge({ top: 'registry/quarantine', name: bad.name, isDir: bad.isDirectory() }, `registry/quarantine/${bad.name}`)
        continue
      }
      judge({ top: entry.name, name: child.name, isDir: child.isDirectory() }, `${entry.name}/${child.name}`)
    }
  }
  return { removed, unknown }
}
