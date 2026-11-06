/**
 * Runtime and filesystem preflight (spec M1; contract protocol.ts). Built-ins only, and `node:sqlite` is loaded
 * only through a catchable dynamic import with its ExperimentalWarning filtered, so a refused runtime reports
 * a bounded diagnostic instead of crashing, and the warning never reaches host logs.
 * Opens disposable probe databases only: in-memory, plus a WAL probe in private scratch on a qualified filesystem.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { detectFilesystem, systemFilesystemReaders, type FilesystemReaders } from './filesystem.js'
import { primePrivateState, privateStateDirectory } from './private-state.js'
import {
  GATE_LIMITS, NODE_FLOOR, NODE_MAJOR, SQLITE_FLOOR, STORAGE_PATHS,
  type FilesystemResult, type PreflightEvidence, type PreflightFailure, type PreflightResult, type PreflightSurface,
} from './protocol.js'

type Sqlite = typeof import('node:sqlite')
type Database = InstanceType<Sqlite['DatabaseSync']>

export interface PreflightOptions {
  /** Canonical Git common directory whose filesystem is probed. Omit for runtime-only preflight (MCP entry). */
  commonDir?: string
  /** Test seams; production uses the running process. */
  runtime?: { execPath?: string; version?: string; release?: NodeJS.ProcessRelease; sharedSqlite?: boolean; platform?: NodeJS.Platform; arch?: string }
  importSqlite?: () => Promise<Sqlite>
  filesystem?: FilesystemReaders
  timeoutMs?: number
}

const REMEDY = 'install the official Node.js 22 (22.22.3 or later) from nodejs.org, put its bin directory (Windows: the folder containing node.exe) first on the PATH the host is launched with, fully stop the host and any MCP-launching daemon, restart, then rerun `node <plugin>/server/room-state.mjs preflight`'
const MAX_DETAIL = 512

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

/** Filter exactly node:sqlite's ExperimentalWarning while the module loads; every other warning passes. */
export async function importSqliteQuietly(): Promise<Sqlite> {
  const original = process.emitWarning
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const text = typeof warning === 'string' ? warning : warning?.message
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type ?? (warning instanceof Error ? warning.name : undefined)
    if (type === 'ExperimentalWarning' && /\bSQLite\b/i.test(text ?? '')) return
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest)
  } as typeof process.emitWarning
  try { return await import('node:sqlite') }
  finally { process.emitWarning = original }
}

function verifyPragmas(db: Database): string | undefined {
  db.exec('PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;')
  const value = (pragma: string) => Object.values(db.prepare(`PRAGMA ${pragma}`).get() ?? {})[0]
  if (Number(value('foreign_keys')) !== 1) return 'foreign_keys could not be enabled'
  if (Number(value('trusted_schema')) !== 0) return 'trusted_schema could not be disabled'
  try { db.loadExtension(path.join(path.sep, 'room-preflight-no-such-extension')); return 'extension loading is enabled' }
  catch (error) { if (!/not allowed|disabled|ERR_LOAD_SQLITE_EXTENSION|ERR_INVALID_STATE/i.test(`${(error as NodeJS.ErrnoException).code ?? ''} ${(error as Error).message}`)) return `extension loading check failed: ${(error as Error).message}` }
  return undefined
}

/**
 * Two WAL connections on the target filesystem: commit, cross-connection read, close, reopen, verify.
 * Runs only on a filesystem already proven local and qualified. The Windows ACL boundary is primed
 * asynchronously first, so the remaining privacy and SQLite work is short and synchronous; the preflight
 * deadline cannot preempt a synchronous call, and nothing slow remains in one.
 */
async function walProbe(sqlite: Sqlite, commonDir: string): Promise<string | undefined> {
  await primePrivateState(commonDir)
  const scratchRoot = path.join(commonDir, STORAGE_PATHS.preflightScratch)
  privateStateDirectory(scratchRoot)
  const dir = path.join(scratchRoot, randomBytes(8).toString('hex'))
  privateStateDirectory(dir)
  const file = path.join(dir, 'probe.sqlite')
  const open: Database[] = []
  const connect = () => { const db = new sqlite.DatabaseSync(file, { enableForeignKeyConstraints: true, allowExtension: false, timeout: 0 } as ConstructorParameters<Sqlite['DatabaseSync']>[1]); open.push(db); return db }
  try {
    const a = connect()
    const mode = Object.values(a.prepare('PRAGMA journal_mode = WAL').get() ?? {})[0]
    if (String(mode).toLowerCase() !== 'wal') return `journal_mode is ${String(mode)}, not wal`
    a.exec('PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE probe (n INTEGER PRIMARY KEY) STRICT;')
    a.exec('BEGIN IMMEDIATE; INSERT INTO probe (n) VALUES (1); COMMIT;')
    const b = connect()
    if (Number(Object.values(b.prepare('SELECT count(*) AS c FROM probe').get() ?? {})[0]) !== 1) return 'second connection did not see the committed row'
    b.close(); a.close(); open.length = 0
    const c = connect()
    const reopened = Object.values(c.prepare('PRAGMA journal_mode').get() ?? {})[0]
    if (String(reopened).toLowerCase() !== 'wal') return `journal_mode after reopen is ${String(reopened)}`
    if (Number(Object.values(c.prepare('SELECT count(*) AS c FROM probe').get() ?? {})[0]) !== 1) return 'row missing after reopen'
    return undefined
  } finally {
    for (const db of open) { try { db.close() } catch { /* already closed */ } }
    // Only this probe's files, after every connection is closed.
    for (const name of ['probe.sqlite', 'probe.sqlite-wal', 'probe.sqlite-shm']) fs.rmSync(path.join(dir, name), { force: true })
    try { fs.rmdirSync(dir) } catch { /* leave a non-empty directory for inspection */ }
  }
}

export async function preflight(surface: PreflightSurface, options: PreflightOptions = {}): Promise<PreflightResult> {
  const started = performance.now()
  const runtime = options.runtime ?? {}
  const release = runtime.release ?? process.release
  let executable = runtime.execPath ?? process.execPath
  try { executable = fs.realpathSync.native(executable) } catch { /* report the unresolved path */ }
  let source: string | undefined
  try { source = release.sourceUrl ? new URL(release.sourceUrl).host : undefined } catch { source = 'unparseable' }
  const evidence: PreflightEvidence = {
    surface, executable, node: runtime.version ?? process.versions.node,
    vendor: { name: release.name, ...(source ? { source } : {}),
      platform: runtime.platform ?? process.platform, arch: runtime.arch ?? process.arch },
    elapsedMs: 0,
  }
  const fail = (failure: PreflightFailure, detail: string): PreflightResult =>
    ({ ok: false, failure, evidence: { ...evidence, elapsedMs: Math.round(performance.now() - started) }, detail: detail.replace(/[\r\n]/g, ' ').slice(0, MAX_DETAIL), remedy: REMEDY })

  const work = async (): Promise<PreflightResult> => {
    const version = evidence.node
    if (Number(version.split('.')[0]) !== NODE_MAJOR) return fail('node-version', `Node ${version} is not the qualified ${NODE_MAJOR}.x line`)
    if (compareVersions(version, NODE_FLOOR) < 0) return fail('node-version', `Node ${version} is below the minimum ${NODE_FLOOR}`)
    // Official nodejs.org distributions bundle SQLite. A build linked to a system SQLite (common in distribution
    // and package-manager builds) is unqualified. Other rebuilds that keep the bundled library and the official
    // release metadata cannot be told apart here.
    const shared = runtime.sharedSqlite ?? (process.config.variables as Record<string, unknown>).node_shared_sqlite === true
    if (release.name !== 'node' || shared) return fail('node-vendor', release.name !== 'node' ? `runtime ${release.name} is not Node.js` : 'this Node.js build uses a system SQLite library, not the bundled one; it is not an official nodejs.org binary')
    let sqlite: Sqlite
    try { sqlite = await (options.importSqlite ?? importSqliteQuietly)() }
    catch (error) { return fail('sqlite-import', `import('node:sqlite') failed: ${(error as Error).message}`) }
    if (typeof sqlite?.DatabaseSync !== 'function') return fail('sqlite-api', 'node:sqlite has no DatabaseSync')
    let db: Database
    try { db = new sqlite.DatabaseSync(':memory:', { enableForeignKeyConstraints: true, allowExtension: false } as ConstructorParameters<Sqlite['DatabaseSync']>[1]) }
    catch (error) { return fail('sqlite-api', `DatabaseSync failed: ${(error as Error).message}`) }
    try {
      for (const method of ['exec', 'prepare', 'close', 'loadExtension'] as const) if (typeof db[method] !== 'function') return fail('sqlite-api', `DatabaseSync.${method} missing`)
      const sqliteVersion = String(Object.values(db.prepare('SELECT sqlite_version() AS v').get() ?? {})[0])
      evidence.sqlite = sqliteVersion
      if (compareVersions(sqliteVersion, SQLITE_FLOOR) < 0) return fail('sqlite-version', `SQLite ${sqliteVersion} is below the minimum ${SQLITE_FLOOR}`)
      const pragma = verifyPragmas(db)
      if (pragma) return fail('pragma', pragma)
    } catch (error) { return fail('sqlite-api', `SQLite probe failed: ${(error as Error).message}`) }
    finally { try { db.close() } catch { /* closed */ } }

    let storage: 'qualified' | 'unqualified' = 'unqualified'
    if (options.commonDir) {
      const filesystem: FilesystemResult = await detectFilesystem(options.commonDir, options.filesystem ?? systemFilesystemReaders)
      evidence.filesystem = filesystem
      if (filesystem.journal === 'wal') {
        // Never open WAL on a path not proven local; a qualified filesystem must pass the real probe.
        let journal: string | undefined
        try { journal = await walProbe(sqlite, options.commonDir) }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'EACCES' || code === 'EPERM' || /private|permission|ownership|symlink/i.test((error as Error).message)) return fail('permission', `private preflight scratch unavailable: ${(error as Error).message}`)
          return fail('journal', `WAL probe failed: ${(error as Error).message}`)
        }
        if (journal) return fail('journal', journal)
        storage = 'qualified'
      }
    }
    return { ok: true, storage, evidence: { ...evidence, elapsedMs: Math.round(performance.now() - started) } }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<PreflightResult>(resolve => {
    // Referenced on purpose: a hung import must end in this typed timeout, not an unsettled-await exit.
    // The finally below clears it, so it never outlives the preflight.
    timer = setTimeout(() => resolve(fail('timeout', `preflight exceeded ${options.timeoutMs ?? GATE_LIMITS.preflightMs} ms`)), options.timeoutMs ?? GATE_LIMITS.preflightMs)
  })
  try { return await Promise.race([work(), deadline]) }
  finally { clearTimeout(timer) }
}

/** One bounded stderr line for a refusal; MCP stdout stays clean. */
export function preflightDiagnostic(result: Extract<PreflightResult, { ok: false }>): string {
  const { evidence } = result
  return `Room cannot start (${evidence.surface}): ${result.failure}: ${result.detail}. Runtime: ${evidence.executable}, Node ${evidence.node}, SQLite ${evidence.sqlite ?? 'unavailable'}. Remedy: ${result.remedy}.`
    .replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, 2048)
}
