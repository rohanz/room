import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'room-bootstrap-process-'))
const entries = {
  mcp: 'packages/room-mcp/src/entry.ts',
  daemon: 'packages/relay/src/daemon-bin.ts',
  offline: 'packages/room-mcp/src/offline/entry.ts',
} as const
beforeAll(async () => {
  for (const [surface, entry] of Object.entries(entries)) {
    await build({ entryPoints: [path.join(root, entry)], outfile: path.join(scratch, `${surface}.mjs`),
      bundle: true, platform: 'node', format: 'esm', target: 'node22', tsconfig: path.join(root, 'tsconfig.base.json'),
      plugins: [{ name: 'test-only-runtime-and-app', setup(b) {
        // Only this test build honors the environment seam. Production wrappers cannot bypass preflight.
        b.onLoad({ filter: /[/\\]preflight\.ts$/ }, async args => ({ loader: 'ts', contents: fs.readFileSync(args.path, 'utf8')
          .replace('const runtime = options.runtime ?? {}', `const runtime = process.env.ROOM_TEST_PREFLIGHT === 'old' ? { version: '22.14.0' } : options.runtime ?? {}`)
          .replace('options.importSqlite ?? importSqliteQuietly', `options.importSqlite ?? (process.env.ROOM_TEST_PREFLIGHT === 'import' ? async () => { throw new Error('No such built-in module: node:sqlite') } : importSqliteQuietly)`) }))
        b.onResolve({ filter: /\.\/(?:index|daemon-app|room-state)\.js$/ }, args => {
          if (args.kind === 'dynamic-import') return { path: 'application', namespace: 'test-app' }
        })
        b.onLoad({ filter: /.*/, namespace: 'test-app' }, () => ({ contents: `
          import fs from 'node:fs'; import path from 'node:path';
          fs.writeFileSync(path.join(process.env.ROOM_TEST_COMMON, 'loaded'), 'application');
          export async function main() { return 7 }
        ` }))
      } }],
    })
  }
})
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))
function run(surface: keyof typeof entries, mode = '', args: string[] = []) {
  const common = fs.mkdtempSync(path.join(scratch, 'common-'))
  fs.writeFileSync(path.join(common, 'HEAD'), 'ref: refs/heads/main\n')
  const child = spawnSync(process.execPath, [path.join(scratch, `${surface}.mjs`), ...args, ...(surface === 'mcp' ? [] : ['--common-dir', common])], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, ROOM_TEST_PREFLIGHT: mode, ROOM_TEST_COMMON: common },
  })
  expect(child.error).toBeUndefined()
  return { ...child, common }
}
it.each(Object.keys(entries) as (keyof typeof entries)[])('%s loads its application only after successful preflight, with clean stdout and no SQLite warning', surface => {
  const child = run(surface)
  expect(child.status).toBe(surface === 'offline' ? 7 : 0)
  expect(child.stdout).toBe('')
  expect(child.stderr).toBe('')
  expect(fs.existsSync(path.join(child.common, 'loaded'))).toBe(true)
})
it.each((Object.keys(entries) as (keyof typeof entries)[]).flatMap(surface => ['old', 'import'].map(mode => [surface, mode] as const)))('%s refuses %s before application loading or Room writes', (surface, mode) => {
  const child = run(surface, mode)
  expect(child.status).toBe(1)
  expect(child.stdout).toBe('')
  expect(child.stderr.trim().split('\n')).toHaveLength(1)
  expect(child.stderr.length).toBeLessThanOrEqual(2049)
  expect(child.stderr).toContain(mode === 'old' ? 'node-version' : 'sqlite-import')
  expect(child.stderr).toContain('Remedy:')
  expect(fs.readdirSync(child.common)).toEqual(['HEAD'])
})
it('offline preflight --json returns the exact result and never imports the app on success or refusal', () => {
  for (const mode of ['', 'old']) {
    const child = run('offline', mode, ['preflight', '--json'])
    const result = JSON.parse(child.stdout)
    expect(child.status).toBe(mode ? 1 : 0)
    expect(result).toMatchObject({ ok: !mode, evidence: { surface: 'offline', executable: fs.realpathSync.native(process.execPath) } })
    expect(fs.existsSync(path.join(child.common, 'loaded'))).toBe(false)
    if (mode) { expect(result.failure).toBe('node-version'); expect(fs.existsSync(path.join(child.common, 'room'))).toBe(false) }
    else { expect(result.evidence.sqlite).toMatch(/^3\./); expect(child.stderr).toBe('') }
  }
})

it('offline status uses runtime-only preflight and creates no Room state', () => {
  const child = run('offline', '', ['status', '--json'])
  expect(child.status).toBe(7) // application status is propagated unchanged
  expect(fs.existsSync(path.join(child.common, 'loaded'))).toBe(true)
  expect(fs.existsSync(path.join(child.common, 'room'))).toBe(false)
})
it('reports a daemon preflight refusal to the launcher without writing Room state', () => {
  const report = path.join(scratch, 'startup-error')
  const child = run('daemon', 'old', ['--startup-report', report])
  expect(child.status).toBe(1)
  expect(fs.readFileSync(report, 'utf8')).toBe(child.stderr.trim())
  expect(fs.existsSync(path.join(child.common, 'room'))).toBe(false)
})
