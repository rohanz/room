import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { preflight, preflightDiagnostic } from '../src/preflight.js'
import { primePrivateState } from '../src/private-state.js'
import type { FilesystemReaders } from '../src/filesystem.js'

const require = createRequire(import.meta.url)
const roots: string[] = []
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function commonDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preflight-'))
  roots.push(dir)
  fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n')
  return fs.realpathSync.native(dir)
}
const official = { name: 'node', sourceUrl: 'https://nodejs.org/download/release/v22.22.3/node-v22.22.3.tar.gz' } as NodeJS.ProcessRelease

it('accepts this runtime and qualifies a local WAL probe, removing only its own probe files', async () => {
  const dir = commonDir()
  const result = await preflight('offline', { commonDir: dir })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.evidence.executable).toBe(fs.realpathSync.native(process.execPath))
  expect(result.evidence.sqlite).toMatch(/^3\.\d+\.\d+$/)
  if (result.evidence.filesystem?.journal === 'wal') {
    expect(result.storage).toBe('qualified')
    expect(fs.readdirSync(path.join(dir, 'room', 'preflight'))).toEqual([])
  } else expect(result.storage).toBe('unqualified')
  expect(result.evidence.elapsedMs).toBeLessThan(10_000)
})

it.each([
  ['22.12.0 (node:sqlite import fails)', { version: '22.22.3' }, "async () => { throw new Error('No such built-in module: node:sqlite') }", 'sqlite-import'],
  ['a runtime below the floor', { version: '22.14.0' }, undefined, 'node-version'],
  ['another major line', { version: '24.11.0' }, undefined, 'node-version'],
  ['a build linked to a system SQLite', { version: '22.23.4', sharedSqlite: true }, undefined, 'node-vendor'],
  ['a vendor source host', { release: { name: 'node', sourceUrl: 'https://vendor.example/node.tar.gz' } as NodeJS.ProcessRelease }, undefined, 'node-vendor'],
  ['missing source metadata', { release: { name: 'node' } as NodeJS.ProcessRelease }, undefined, 'node-vendor'],
  ['an invalid source URL', { release: { name: 'node', sourceUrl: 'invalid' } as NodeJS.ProcessRelease }, undefined, 'node-vendor'],
  ['a non-Node runtime', { version: '22.23.4', release: { name: 'bun' } as NodeJS.ProcessRelease }, undefined, 'node-vendor'],
] as const)('refuses %s with a typed failure and remedy', async (_label, runtime, importSqlite, failure) => {
  const dir = commonDir()
  const result = await preflight('mcp', { commonDir: dir, runtime: { release: official, ...runtime }, ...(importSqlite ? { importSqlite } : {}) })
  expect(result).toMatchObject({ ok: false, failure })
  if (result.ok) return
  expect(result.remedy).toMatch(/PATH/)
  expect(preflightDiagnostic(result).length).toBeLessThanOrEqual(2048)
  expect(fs.existsSync(path.join(dir, 'room'))).toBe(false) // nothing written before refusal
})

it('refuses a SQLite older than the floor (22.14-era 3.47.2)', async () => {
  const result = await preflight('mcp', { runtime: { release: official, version: '22.22.3' }, importSqlite: `async () => {
    const real = await import('node:sqlite');
    class OldDatabase extends real.DatabaseSync {
      prepare(sql) { return sql.includes('sqlite_version') ? { get: () => ({ v: '3.47.2' }) } : super.prepare(sql); }
    }
    return { ...real, DatabaseSync: OldDatabase };
  }` })
  expect(result).toMatchObject({ ok: false, failure: 'sqlite-version', evidence: { sqlite: '3.47.2' } })
})

it('refuses a missing DatabaseSync API', async () => {
  const result = await preflight('daemon', { runtime: { release: official, version: '22.22.3' }, importSqlite: 'async () => ({})' })
  expect(result).toMatchObject({ ok: false, failure: 'sqlite-api' })
})

it('never opens WAL on an unqualified filesystem: reports unqualified and writes nothing', async () => {
  const dir = commonDir()
  const network: FilesystemReaders = { platform: 'linux', realpath: () => '/srv/repo/.git', statfsType: () => 0x6969, macMounts: () => '',
    linuxMountinfo: () => `36 25 0:32 / / rw - nfs4 server:/export rw\n`, windowsDriveType: () => '', windowsVolumeInfo: () => '', home: () => '/home/u', env: {} }
  const result = await preflight('offline', { commonDir: dir, filesystem: network })
  expect(result).toMatchObject({ ok: true, storage: 'unqualified', evidence: { filesystem: { kind: 'network', journal: 'refuse' } } })
  expect(fs.existsSync(path.join(dir, 'room'))).toBe(false)
})

it('reports a timeout as a catchable failure', async () => {
  const result = await preflight('mcp', { runtime: { release: official, version: '22.22.3' }, timeoutMs: 20, importSqlite: '() => new Promise(() => {})' })
  expect(result).toMatchObject({ ok: false, failure: 'timeout' })
})

it('keeps node:sqlite\'s ExperimentalWarning off stderr while other warnings still print', () => {
  const script = `
    const { preflight } = await import(${JSON.stringify(new URL('../src/preflight.ts', import.meta.url).href)});
    const result = await preflight('mcp');
    process.emitWarning('unrelated warning', 'ExperimentalWarning');
    await new Promise(resolve => setImmediate(resolve));
    process.stdout.write(JSON.stringify({ ok: result.ok }));`
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 })
  expect(child.status).toBe(0)
  expect(JSON.parse(child.stdout)).toEqual({ ok: true })
  expect(child.stderr).not.toMatch(/SQLite is an experimental feature/i)
  expect(child.stderr).toMatch(/unrelated warning/)
}, 60_000)

it('enforces the deadline while filesystem detection is still waiting on the OS', async () => {
  const dir = commonDir()
  const hanging: FilesystemReaders = { platform: 'linux', realpath: () => '/srv/repo/.git', statfsType: () => undefined, macMounts: () => '',
    linuxMountinfo: () => new Promise<string>(() => {}), windowsDriveType: () => '', windowsVolumeInfo: () => '', home: () => '/home/u', env: {} }
  const started = performance.now()
  const result = await preflight('offline', { commonDir: dir, filesystem: hanging, timeoutMs: 100 })
  expect(result).toMatchObject({ ok: false, failure: 'timeout' })
  expect(performance.now() - started).toBeLessThan(2_000)
})

it('still produces a diagnostic for a malformed release source URL', async () => {
  const result = await preflight('mcp', { runtime: { release: { name: 'node', sourceUrl: 'not a url' } as NodeJS.ProcessRelease, version: '22.14.0' } })
  expect(result).toMatchObject({ ok: false, failure: 'node-version', evidence: { vendor: { source: 'unparseable' } } })
})

it('keeps the diagnostic on one line even when the executable path contains a newline', async () => {
  const result = await preflight('mcp', { runtime: { release: official, version: '22.14.0', execPath: '/tmp/odd\npath/node' } })
  expect(result.ok).toBe(false)
  if (!result.ok) expect(preflightDiagnostic(result)).not.toMatch(/[\r\n]/)
})

it('ends a hung SQLite import with the typed timeout, not an unsettled-await exit', () => {
  const script = `
    const { preflight } = await import(${JSON.stringify(new URL('../src/preflight.ts', import.meta.url).href)});
    const result = await preflight('mcp', { timeoutMs: 200, importSqlite: '() => new Promise(() => {})' });
    process.stdout.write(JSON.stringify({ failure: result.failure }));`
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 })
  expect(child.status).toBe(0)
  expect(JSON.parse(child.stdout)).toEqual({ failure: 'timeout' })
}, 60_000)

// Explicit ext4 input exercises probe control flow, not host filesystem qualification.
const local: FilesystemReaders = { platform: 'linux', realpath: () => '/srv/repo/.git', statfsType: () => 0xef53,
  linuxMountinfo: () => '36 25 0:32 / / rw - ext4 /dev/test rw', macMounts: () => '',
  windowsDriveType: () => '', windowsVolumeInfo: () => '', home: () => '/home/u', env: {} }

it.each(['constructor', 'pragma', 'wal-commit', 'wal-close', 'wal-reopen'])('enforces a deadline while %s blocks synchronously', async stage => {
  const dir = commonDir(), reached = path.join(dir, 'reached')
  // Prime Windows ACLs outside this SQLite blocking-call test's deadline; privacy has its own tests.
  if (stage.startsWith('wal-')) await primePrivateState(dir)
  // The worker signals the boundary before blocking: a startup timeout cannot falsely pass this test.
  const result = await preflight('offline', { commonDir: dir, filesystem: local, timeoutMs: 1_000,
    importSqlite: `async () => {
      const real = await import('node:sqlite'), fs = await import('node:fs');
      const stage = ${JSON.stringify(stage)}, reached = ${JSON.stringify(reached)};
      const block = () => { fs.writeFileSync(reached, 'yes'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000); };
      let opens = 0;
      class SlowDatabase extends real.DatabaseSync {
        constructor(file, options) {
          if (stage === 'constructor' || stage === 'wal-reopen' && file !== ':memory:' && ++opens === 3) block();
          super(file, options); this.file = file;
        }
        exec(sql) { if (stage === 'pragma' || stage === 'wal-commit' && sql.includes('COMMIT')) block(); return super.exec(sql); }
        close() { if (stage === 'wal-close' && this.file !== ':memory:') block(); return super.close(); }
      }
      return { ...real, DatabaseSync: SlowDatabase };
    }` })
  expect(fs.existsSync(reached)).toBe(true)
  expect(result).toMatchObject({ ok: false, failure: 'timeout' })
  expect(result.evidence.elapsedMs).toBeLessThan(2_000)
  if (stage === 'constructor' || stage === 'pragma') expect(fs.existsSync(path.join(dir, 'room'))).toBe(false)
})

it('a late filesystem response cannot start WAL or touch scratch after timeout', async () => {
  const dir = commonDir()
  let resolve!: (text: string) => void
  const pending = new Promise<string>(done => { resolve = done })
  const result = await preflight('offline', { commonDir: dir, timeoutMs: 200, filesystem: { ...local, linuxMountinfo: () => pending } })
  expect(result).toMatchObject({ ok: false, failure: 'timeout' })
  resolve('36 25 0:32 / / rw - ext4 /dev/test rw')
  await new Promise(done => setTimeout(done, 50))
  expect(fs.existsSync(path.join(dir, 'room'))).toBe(false)
})

it('checks the absolute deadline before success even if the main-thread timer has not run', async () => {
  const dir = commonDir()
  const result = await preflight('offline', { commonDir: dir, timeoutMs: 200, filesystem: { ...local,
    linuxMountinfo: () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); return '36 25 0:32 / / rw - ext4 /dev/test rw' },
  } })
  expect(result).toMatchObject({ ok: false, failure: 'timeout' })
  expect(fs.existsSync(path.join(dir, 'room'))).toBe(false)
})
