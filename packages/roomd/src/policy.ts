import { createHash } from 'node:crypto'
import { containsPath, normalizeCoordinationPath, type ManifestEntry } from '@room/shared'
import { clampShare, type ShareLevel } from './share-level.js'
import { parseRoomIgnore, type RoomIgnore } from './roomignore.js'

/** One immutable authorization snapshot. The store replaces it for every grant or ceiling change. */
export interface SharingPolicy {
  readonly level: ShareLevel
  readonly requested: ShareLevel
  readonly ceiling: ShareLevel
  readonly textPrefixes: readonly string[]
  readonly ending: readonly string[]
  readonly publisher: boolean
  readonly publisherName?: string
}

export interface ExclusionRules {
  readonly roomIgnore: RoomIgnore
  readonly sizeCap: number
  readonly budget: number
  /** Changes whenever the ignore file, size cap, or budget changes. */
  readonly id: string
}

export interface PublicationInputs {
  readonly policy: SharingPolicy
  readonly rules: ExclusionRules
  /** Resolved participant manifest base, not necessarily worktree HEAD. */
  readonly head: string
}

export function policyFromLevel(level: ShareLevel, textPrefixes: readonly string[] = [], ceiling: ShareLevel = 'full', publisher = true): SharingPolicy {
  return Object.freeze({ level: clampShare(level, ceiling), requested: level, ceiling, textPrefixes: Object.freeze([...textPrefixes]), ending: Object.freeze([]), publisher })
}

export function authorizesText(policy: SharingPolicy, relpath: string): boolean {
  return policy.publisher && (policy.level === 'full' || (policy.level === 'declared' && policy.textPrefixes.some(prefix => containsPath(prefix, relpath))))
}

/** Private environment files remain excluded even when deliberately tracked. */
export function defaultExcludedPath(relpath: string): boolean {
  return relpath.split('/').some(part => part === '.env' || part.startsWith('.env.') && part !== '.env.example')
}

export const DEFAULT_IGNORED_DIRS = new Set(['node_modules', '.venv', 'dist', 'build', '.git', '.room', 'target', '.next', 'coverage', '__pycache__'])
export function defaultIgnoredPath(relpath: string): boolean {
  return relpath.split('/').some(segment => DEFAULT_IGNORED_DIRS.has(segment) || segment === '.DS_Store' || segment === '.coverage' || segment.endsWith('.egg-info') || /\.(?:pyc|pyo|npy|npz|parquet|pkl|pt|bin|sqlite|zip|gz|tmp)$/i.test(segment) || segment.endsWith('~') || /^(?:\.#.*|\.tmp(?:[.-].*)?|\..+\.(?:tmp(?:[.-].*)?|sw[opx]|part|atomic))$/i.test(segment))
}

/** Generated dependency lockfiles are shared only after Git has indexed them. */
export const TRACKED_ONLY_LOCKFILES = new Set(['uv.lock', 'poetry.lock', 'Pipfile.lock', 'pdm.lock', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'go.sum'])
export const isTrackedOnlyLockfile = (relpath: string): boolean => TRACKED_ONLY_LOCKFILES.has(relpath.slice(relpath.lastIndexOf('/') + 1))

export function rulesFromText(text: string, sizeCap: number, budget: number): ExclusionRules {
  return Object.freeze({ roomIgnore: parseRoomIgnore(text), sizeCap, budget, id: createHash('sha256').update(JSON.stringify([text, sizeCap, budget])).digest('hex') })
}

/** A checkout observation relative to the captured base. No disk I/O occurs in plan(). */
export interface DiskFact {
  path: string
  kind: 'file' | 'absent' | 'unsafe' | 'error'
  hash?: string
  baseHash?: string
  size?: number
  text?: string
  binary?: boolean
  excluded?: boolean
  ignored?: boolean
  exclusionReason?: 'untracked lockfile'
  at?: number
  /** Local comparison for an excluded large file, without retaining its hash. */
  changed?: boolean
}

export type PlannedEntry = Omit<ManifestEntry, 'at' | 'fence'> & { text?: string; at?: number }
export interface PublicationPlan {
  readonly entries: ReadonlyMap<string, PlannedEntry>
  readonly excluded: readonly string[]
  readonly excludedPaths: readonly string[]
  readonly unsettled: readonly string[]
  readonly textPaths: readonly string[]
  readonly excludedReasons: ReadonlyMap<string, 'ignore' | 'size' | 'budget' | 'unsafe' | 'untracked lockfile'>
}

/** Pure, ordered policy decision. A digest is created only after the publication gate. */
export function plan(inputs: PublicationInputs, disk: readonly DiskFact[], salt: string): PublicationPlan {
  const entries = new Map<string, PlannedEntry>()
  const excluded: string[] = []
  const excludedPaths: string[] = []
  const unsettled: string[] = []
  const textPaths: string[] = []
  const excludedReasons = new Map<string, 'ignore' | 'size' | 'budget' | 'unsafe' | 'untracked lockfile'>()
  const policy = inputs.policy
  if (policy.level === 'intent' || !policy.publisher) return { entries, excluded, excludedPaths, unsettled, textPaths, excludedReasons }
  let used = 0
  for (const fact of [...disk].sort((a, b) => a.path.localeCompare(b.path))) {
    const p = normalizeCoordinationPath(fact.path)
    const changed = fact.changed ?? (fact.kind === 'absent' ? !!fact.baseHash : fact.kind === 'unsafe' || fact.hash !== fact.baseHash)
    const hide = (reason: 'ignore' | 'size' | 'budget' | 'unsafe' | 'untracked lockfile') => { excludedPaths.push(p); excludedReasons.set(p, reason); excluded.push(createHash('sha256').update(Buffer.from(salt, 'hex')).update(p, 'utf8').digest('hex')) }
    if (fact.excluded || fact.ignored || defaultExcludedPath(p) || defaultIgnoredPath(p) || inputs.rules.roomIgnore.ignores(p)) { if (changed) hide(fact.exclusionReason ?? 'ignore'); continue }
    if (fact.kind === 'error') { unsettled.push(p); continue }
    if (!changed) continue
    if (fact.kind === 'absent') {
      const entry: PlannedEntry = { change: 'D', state: 'shared' }
      if (authorizesText(policy, p) && fact.baseHash) entry.baseHash = fact.baseHash
      entries.set(p, entry)
      continue
    }
    if (fact.kind === 'unsafe' || fact.size === undefined || fact.size > inputs.rules.sizeCap || !fact.hash) { hide(fact.size !== undefined && fact.size > inputs.rules.sizeCap ? 'size' : 'unsafe'); continue }
    const change = fact.baseHash ? 'M' : 'A'
    if (!authorizesText(policy, p)) { entries.set(p, { change, state: 'held', held: 'scope', at: fact.at }); continue }
    const values = { change, hash: fact.hash, size: fact.size, ...(fact.baseHash ? { baseHash: fact.baseHash } : {}), at: fact.at } as const
    if (fact.binary || fact.text === undefined) { entries.set(p, { ...values, state: 'held', held: 'binary' }); continue }
    if (used + fact.size > inputs.rules.budget) { hide('budget'); continue }
    used += fact.size
    entries.set(p, { ...values, state: 'shared', text: fact.text })
    textPaths.push(p)
  }
  return { entries, excluded: excluded.sort(), excludedPaths, unsettled, textPaths, excludedReasons }
}
