/** Built-ins only: run locally or in CI against the committed plugin bundle.
 * node scripts/sqlite-evidence.mjs [--output <file>] [--expect-refusal node-version] [--scratch-parent <directory>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
let output, expectedRefusal, scratchParent = os.tmpdir()
while (args.length) {
  const flag = args.shift(), value = args.shift()
  if (!value || !['--output', '--expect-refusal', '--scratch-parent'].includes(flag)) throw new Error('usage: sqlite-evidence.mjs [--output <file>] [--expect-refusal node-version] [--scratch-parent <directory>]')
  if (flag === '--output') output = value
  else if (flag === '--scratch-parent') scratchParent = path.resolve(value)
  else if (value === 'node-version') expectedRefusal = value
  else throw new Error('only node-version refusal evidence is supported')
}
const root = fs.mkdtempSync(path.join(scratchParent, 'room-sqlite-evidence-'))
const expectedFilesystem = { darwin: 'apfs', linux: 'ext4', win32: 'ntfs' }[process.platform]
const evidence = {
  expectedFilesystem, scratchParent,
  kind: 'sqlite-runtime', at: new Date().toISOString(), executable: fs.realpathSync(process.execPath),
  node: process.version, release: process.release, platform: process.platform, arch: process.arch,
  os: { type: os.type(), release: os.release(), version: os.version() },
  expectedRefusal: expectedRefusal ?? null,
}
try {
  const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8', timeout: 10_000 })
  if (init.error || init.status !== 0) throw new Error(`git init failed: ${init.error ?? init.stderr}`)
  const bundle = fileURLToPath(new URL('../plugins/room/server/room-state.mjs', import.meta.url))
  const run = spawnSync(process.execPath, [bundle, 'preflight', '--common-dir', path.join(root, '.git'), '--json'],
    { cwd: root, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 })
  evidence.preflight = { status: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr,
    ...(run.error ? { error: String(run.error) } : {}) }
  evidence.roomPaths = [
    ...fs.readdirSync(path.join(root, '.git')).filter(name => name.startsWith('room')).map(name => `.git/${name}`),
    ...fs.readdirSync(root).filter(name => name.startsWith('.room')),
  ]
  evidence.roomStateCreated = evidence.roomPaths.length > 0
  const result = JSON.parse(run.stdout)
  evidence.preflight.result = result
  evidence.passed = !run.error && (expectedRefusal
    ? run.status === 1 && result.ok === false && result.failure === expectedRefusal && !evidence.roomStateCreated
    : run.status === 0 && result.ok === true && result.storage === 'qualified'
      && !!expectedFilesystem && result.evidence?.filesystem?.kind === expectedFilesystem
      && result.evidence.filesystem.journal === 'wal')
  if (!evidence.passed) process.exitCode = 1
} catch (error) {
  evidence.passed = false
  evidence.error = String(error)
  process.exitCode = 1
} finally {
  const json = JSON.stringify(evidence, null, 2) + '\n'
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true })
    fs.writeFileSync(output, json)
  }
  process.stdout.write(json)
  fs.rmSync(root, { recursive: true, force: true })
}
