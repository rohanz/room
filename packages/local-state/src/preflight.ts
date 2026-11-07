/**
 * Runtime and filesystem preflight (spec M1; contract protocol.ts). Built-ins only, and `node:sqlite` is loaded
 * only through a catchable dynamic import with its ExperimentalWarning filtered, so a refused runtime reports
 * a bounded diagnostic instead of crashing, and the warning never reaches host logs.
 * Opens disposable probe databases only: in-memory, plus a WAL probe in private scratch on a qualified filesystem.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { randomBytes } from 'node:crypto'
import { detectFilesystem, systemFilesystemReaders, type FilesystemReaders } from './filesystem.js'
import { primePrivateState, privateStateDirectory } from './private-state.js'
import {
  GATE_LIMITS, NODE_FLOOR, NODE_MAJOR, SQLITE_FLOOR, STORAGE_PATHS,
  type FilesystemResult, type PreflightEvidence, type PreflightFailure, type PreflightResult, type PreflightSurface,
} from './protocol.js'

export interface PreflightOptions {
  /** Canonical Git common directory whose filesystem is probed. Omit for runtime-only preflight (MCP entry). */
  commonDir?: string
  /** Test seams; production uses the running process. */
  runtime?: { execPath?: string; version?: string; release?: NodeJS.ProcessRelease; sharedSqlite?: boolean; platform?: NodeJS.Platform; arch?: string }
  /** Self-contained JS async function source, evaluated only in the isolated probe worker (tests only). */
  importSqlite?: string
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

/**
 * Self-contained worker source so bundled bootstrap wrappers need no adjacent worker asset or loader.
 * All SQLite calls (including construction and close) run off the bootstrap thread. A native call
 * may finish after termination is requested; check the absolute deadline around EVERY synchronous
 * step so it can never advance to another probe/scratch operation or publish late success.
 * Keep this source covered by the emitted-wrapper dependency audit.
 */
const SQLITE_PROBE_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const expired = () => performance.now() >= workerData.deadline;
const check = () => { if (expired()) throw Object.assign(new Error('preflight deadline expired'), { failure: 'timeout' }); };
const step = fn => { check(); const value = fn(); check(); return value; };
let sqlite;
function fail(failure, detail) { return { failure, detail }; }
async function runtimeProbe() {
  const original = process.emitWarning;
  process.emitWarning = function(warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type ?? (warning instanceof Error ? warning.name : undefined);
    if (type === 'ExperimentalWarning' && /\bSQLite\b/i.test(text ?? '')) return;
    return original.call(process, warning, ...rest);
  };
  try {
    check();
    sqlite = await (workerData.importSqlite ? (0, eval)('(' + workerData.importSqlite + ')')() : import('node:sqlite'));
    check();
  } catch (error) { return fail(error.failure ?? 'sqlite-import', error.message); }
  finally { process.emitWarning = original; }
  if (typeof sqlite?.DatabaseSync !== 'function') return fail('sqlite-api', 'node:sqlite has no DatabaseSync');
  let db;
  try {
    db = step(() => new sqlite.DatabaseSync(':memory:', { enableForeignKeyConstraints: true, allowExtension: false }));
    for (const method of ['exec', 'prepare', 'close', 'loadExtension'])
      if (typeof db[method] !== 'function') return fail('sqlite-api', 'DatabaseSync.' + method + ' missing');
    const get = sql => { const statement = step(() => db.prepare(sql)); return step(() => Object.values(statement.get() ?? {})[0]); };
    const version = String(get('SELECT sqlite_version() AS v'));
    const parts = version.split('.').map(Number), floor = workerData.sqliteFloor.split('.').map(Number);
    const comparison = parts[0] - floor[0] || parts[1] - floor[1] || parts[2] - floor[2];
    if (comparison < 0) return { ...fail('sqlite-version', 'SQLite ' + version + ' is below the minimum ' + workerData.sqliteFloor), sqlite: version };
    step(() => db.exec('PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;'));
    if (Number(get('PRAGMA foreign_keys')) !== 1) return fail('pragma', 'foreign_keys could not be enabled');
    if (Number(get('PRAGMA trusted_schema')) !== 0) return fail('pragma', 'trusted_schema could not be disabled');
    try { step(() => db.loadExtension(path.join(path.sep, 'room-preflight-no-such-extension'))); return fail('pragma', 'extension loading is enabled'); }
    catch (error) {
      check();
      if (!/not allowed|disabled|ERR_LOAD_SQLITE_EXTENSION|ERR_INVALID_STATE/i.test((error.code ?? '') + ' ' + error.message))
        return fail('pragma', 'extension loading check failed: ' + error.message);
    }
    return { sqlite: version };
  } catch (error) { return fail(error.failure ?? 'sqlite-api', 'SQLite probe failed: ' + error.message); }
  finally { if (db && !expired()) step(() => db.close()); }
}
function walProbe(dir) {
  check();
  const file = path.join(dir, 'probe.sqlite'), open = new Set();
  const connect = () => { const db = step(() => new sqlite.DatabaseSync(file, { enableForeignKeyConstraints: true, allowExtension: false, timeout: 0 })); open.add(db); return db; };
  const close = db => { step(() => db.close()); open.delete(db); };
  const get = (db, sql) => { const statement = step(() => db.prepare(sql)); return step(() => Object.values(statement.get() ?? {})[0]); };
  try {
    const a = connect();
    const mode = get(a, 'PRAGMA journal_mode = WAL');
    if (String(mode).toLowerCase() !== 'wal') return fail('journal', 'journal_mode is ' + mode + ', not wal');
    step(() => a.exec('PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE probe (n INTEGER PRIMARY KEY) STRICT;'));
    step(() => a.exec('BEGIN IMMEDIATE; INSERT INTO probe (n) VALUES (1); COMMIT;'));
    const b = connect();
    if (Number(get(b, 'SELECT count(*) AS c FROM probe')) !== 1) return fail('journal', 'second connection did not see the committed row');
    close(b); close(a);
    const c = connect();
    if (String(get(c, 'PRAGMA journal_mode')).toLowerCase() !== 'wal') return fail('journal', 'journal_mode changed after reopen');
    if (Number(get(c, 'SELECT count(*) AS c FROM probe')) !== 1) return fail('journal', 'row missing after reopen');
    return {};
  } finally {
    // On timeout termination owns connection teardown; leave scratch for inspection, never do late I/O.
    if (!expired()) {
      for (const db of open) close(db);
      for (const name of ['probe.sqlite', 'probe.sqlite-wal', 'probe.sqlite-shm']) step(() => fs.rmSync(path.join(dir, name), { force: true }));
      step(() => fs.rmdirSync(dir));
    }
  }
}
parentPort.on('message', async message => {
  let result;
  try { check(); result = message.kind === 'runtime' ? await runtimeProbe() : walProbe(message.dir); check(); }
  catch (error) { result = fail(error.failure ?? 'journal', error.message); }
  parentPort.postMessage(result);
});
`

type ProbeResult = { sqlite?: string; failure?: PreflightFailure; detail?: string }

export async function preflight(surface: PreflightSurface, options: PreflightOptions = {}): Promise<PreflightResult> {
  const started = performance.now()
  const deadlineAt = started + (options.timeoutMs ?? GATE_LIMITS.preflightMs)
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

  let worker: Worker | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const timeout = () => fail('timeout', `preflight exceeded ${options.timeoutMs ?? GATE_LIMITS.preflightMs} ms`)
  const check = () => { if (timedOut || performance.now() >= deadlineAt) throw new Error('preflight deadline expired') }
  const probe = (message: { kind: 'runtime' | 'wal'; dir?: string }): Promise<ProbeResult> => new Promise((resolve, reject) => {
    const done = (result: ProbeResult) => { cleanup(); resolve(result) }
    const error = (error: Error) => { cleanup(); reject(error) }
    const exited = (code: number) => error(new Error(`probe worker exited (${code})`))
    const cleanup = () => { worker!.off('message', done); worker!.off('error', error); worker!.off('exit', exited) }
    worker!.once('message', done); worker!.once('error', error); worker!.once('exit', exited)
    worker!.postMessage(message)
  })
  const work = async (): Promise<PreflightResult> => {
    const version = evidence.node
    if (Number(version.split('.')[0]) !== NODE_MAJOR) return fail('node-version', `Node ${version} is not the qualified ${NODE_MAJOR}.x line`)
    if (compareVersions(version, NODE_FLOOR) < 0) return fail('node-version', `Node ${version} is below the minimum ${NODE_FLOOR}`)
    // Official distributions identify nodejs.org and bundle SQLite. Reject distinguishable vendor
    // metadata. A rebuild preserving the official release name/source URL and bundled SQLite is
    // indistinguishable here; this metadata check is not binary provenance/attestation.
    const shared = runtime.sharedSqlite ?? (process.config.variables as Record<string, unknown>).node_shared_sqlite === true
    if (release.name !== 'node' || source !== 'nodejs.org' || shared)
      return fail('node-vendor', 'runtime must identify nodejs.org Node.js with bundled SQLite (no shared/system SQLite)')
    check()
    worker = new Worker(SQLITE_PROBE_SOURCE, { eval: true, execArgv: [],
      workerData: { deadline: deadlineAt, sqliteFloor: SQLITE_FLOOR, importSqlite: options.importSqlite } })
    const runtimeResult = await probe({ kind: 'runtime' })
    check()
    if (runtimeResult.sqlite) evidence.sqlite = runtimeResult.sqlite
    if (runtimeResult.failure) return fail(runtimeResult.failure, runtimeResult.detail ?? 'runtime probe failed')

    let storage: 'qualified' | 'unqualified' = 'unqualified'
    if (options.commonDir) {
      const filesystem: FilesystemResult = await detectFilesystem(options.commonDir, options.filesystem ?? systemFilesystemReaders)
      check()
      evidence.filesystem = filesystem
      if (filesystem.journal === 'wal') {
        // Do not create scratch after a late filesystem/privacy response, even after the caller timed out.
        try {
          await primePrivateState(options.commonDir)
          check()
          const scratchRoot = path.join(options.commonDir, STORAGE_PATHS.preflightScratch)
          privateStateDirectory(scratchRoot)
          check()
          // Retain the shared parent: another probe may be between parent and child creation.
          // PID-bearing child names allow recovery only after the owning process is gone.
          const dir = path.join(scratchRoot, `p${process.pid}-n${randomBytes(8).toString('hex')}`)
          privateStateDirectory(dir)
          check()
          const journal = await probe({ kind: 'wal', dir })
          check()
          if (journal.failure) return fail(journal.failure, journal.detail ?? 'WAL probe failed')
        } catch (error) {
          check()
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'EACCES' || code === 'EPERM' || /private|permission|ownership|symlink/i.test((error as Error).message)) return fail('permission', `private preflight scratch unavailable: ${(error as Error).message}`)
          return fail('journal', `WAL probe failed: ${(error as Error).message}`)
        }
        storage = 'qualified'
      }
    }
    check()
    return { ok: true, storage, evidence: { ...evidence, elapsedMs: Math.round(performance.now() - started) } }
  }

  const deadline = new Promise<PreflightResult>(resolve => {
    // Referenced: even an import that never settles must produce a typed timeout.
    timer = setTimeout(() => {
      timedOut = true
      // A stuck native call may defer thread teardown. Deadline checks in the worker fence subsequent
      // steps; termination is requested immediately and never blocks this bounded diagnostic.
      void worker?.terminate().catch(() => {})
      resolve(timeout())
    }, Math.max(0, deadlineAt - performance.now()))
  })
  try {
    const result = await Promise.race([work(), deadline])
    return timedOut || performance.now() >= deadlineAt ? timeout() : result
  } catch (error) {
    return timedOut || performance.now() >= deadlineAt ? timeout() : fail('sqlite-api', `probe worker failed: ${(error as Error).message}`)
  } finally {
    clearTimeout(timer)
    void worker?.terminate().catch(() => {})
  }
}

/** One bounded stderr line for a refusal; MCP stdout stays clean. */
export function preflightDiagnostic(result: Extract<PreflightResult, { ok: false }>): string {
  const { evidence } = result
  return `Room cannot start (${evidence.surface}): ${result.failure}: ${result.detail}. Runtime: ${evidence.executable}, Node ${evidence.node}, SQLite ${evidence.sqlite ?? 'unavailable'}. Remedy: ${result.remedy}.`
    .replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, 2048)
}
