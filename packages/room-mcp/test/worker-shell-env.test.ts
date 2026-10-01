import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { workerCommand, workerProcessEnv } from '../src/worker-config.js'
import { cleanupWorkerLogs } from '../src/worker-git.js'
import { CODEX_SHELL_FILTER, codexShellFilterWarning, workerShellEnvScript, workerShellEnvWarnings, writeWorkerShellEnv } from '../src/worker-shell-env.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-shell-env-'))
  dirs.push(dir)
  return dir
}
function has(shell: string): boolean {
  try { execFileSync(shell, ['-c', 'true'], { stdio: 'ignore' }); return true } catch { return false }
}

const options = { threads: 2, memGb: 1, server: 'local', room: 'local/repo', dir: '/repo/.room/workers/w', tag: 'w', lead: 'l', owner: 'o',
  share: 'intent', run: 1, nonce: 'n', registry: '/repo/.git/room/registry', id: 'id', token: 'secret', logDir: '/repo', isWorker: true, port: 4414 }

it('runs in the shell of every Claude Bash command: drops every ROOM_ variable and keeps PORT, thread caps and the lead\'s env file', () => {
  if (process.platform === 'win32') return
  const dir = tmp()
  const lead = path.join(dir, "lead's env.sh")
  fs.writeFileSync(lead, 'export LEAD_FLAG=1\nexport ROOM_FROM_LEAD_FILE=1\n')
  const script = path.join(dir, 'w.env.sh')
  fs.writeFileSync(script, workerShellEnvScript(lead))
  const env = { PATH: process.env.PATH, ROOM_WORKER_ID: 'id', ROOM_TOKEN: 'secret', ROOM_B: 'x y', ROOM_C: 'a\nROOM_FAKE=1', PORT: '4414', OMP_NUM_THREADS: '2' }
  for (const shell of ['sh', 'bash', 'zsh'].filter(has)) {
    const out = execFileSync(shell, ['-c', `. '${script.replace(/'/g, `'\\''`)}'; env`], { env, encoding: 'utf8' })
    const names = out.split('\n').map(line => line.split('=')[0])
    expect(names.filter(n => n.startsWith('ROOM_')), shell).toEqual([])
    expect(out, shell).toContain('PORT=4414')
    expect(out, shell).toContain('OMP_NUM_THREADS=2')
    expect(out, shell).toContain('LEAD_FLAG=1')
  }
})

it('skips a lead env file that no longer exists instead of failing the command', () => {
  if (process.platform === 'win32') return
  const dir = tmp()
  const script = path.join(dir, 'w.env.sh')
  fs.writeFileSync(script, workerShellEnvScript(path.join(dir, 'gone.sh')))
  expect(execFileSync('sh', ['-c', `. '${script}'; echo ran`], { env: { PATH: process.env.PATH, ROOM_TAG: 'w' }, encoding: 'utf8' })).toBe('ran\n')
  expect(workerShellEnvScript()).not.toContain('[ -f')
})

it('writes the env file 0600 next to the worker log, replacing rather than following a planted link', () => {
  const lead = tmp()
  const workers = path.join(lead, '.room', 'workers')
  fs.mkdirSync(workers, { recursive: true })
  const target = path.join(lead, 'elsewhere')
  fs.writeFileSync(target, 'untouched')
  fs.symlinkSync(target, path.join(workers, 'w.env.sh'))
  const written = writeWorkerShellEnv(lead, 'w', undefined)
  expect(written).toEqual({ file: path.join(workers, 'w.env.sh') })
  expect(fs.lstatSync(written.file!).isSymbolicLink()).toBe(false)
  if (process.platform !== 'win32') expect(fs.statSync(written.file!).mode & 0o777).toBe(0o600)
  expect(fs.readFileSync(target, 'utf8')).toBe('untouched')
  expect(fs.readFileSync(written.file!, 'utf8')).toBe(workerShellEnvScript())
})

it('reports an env file it could not write instead of launching silently unscrubbed', () => {
  const lead = tmp()
  fs.writeFileSync(path.join(lead, '.room'), 'not a directory')
  const written = writeWorkerShellEnv(lead, 'w', undefined)
  expect(written.file).toBeUndefined()
  expect(written.warning).toMatch(/^warning: could not write .*w\.env\.sh .*; w's shell commands still see Room's ROOM_\* variables/)
})

it('removes the env file with the worker logs', () => {
  const lead = tmp()
  const workers = path.join(lead, '.room', 'workers')
  fs.mkdirSync(workers, { recursive: true })
  for (const name of ['w.log', 'w.mcp.log', 'w.env.sh']) fs.writeFileSync(path.join(workers, name), '')
  cleanupWorkerLogs(lead, { dir: path.join(workers, 'w'), tag: 'w' })
  expect(fs.existsSync(path.join(lead, '.room'))).toBe(false)
})

it('gives a Claude worker the env file and keeps PORT and thread caps; Codex filters its shell instead', () => {
  const claude = workerProcessEnv({ ...options, host: 'claude', shellEnvFile: '/repo/.room/workers/w.env.sh' }, {})
  expect(claude.CLAUDE_ENV_FILE).toBe('/repo/.room/workers/w.env.sh')
  expect(claude.PORT).toBe('4414')
  expect(claude.OMP_NUM_THREADS).toBe('2')
  // The worker's own Room MCP server still gets its coordination variables.
  expect(claude.ROOM_WORKER_ID).toBe('id')
  expect(claude.ROOM_TOKEN).toBe('secret')
  expect(workerProcessEnv({ ...options, host: 'claude' }, {}).CLAUDE_ENV_FILE).toBeUndefined()
  expect(workerProcessEnv({ ...options, host: 'codex', shellEnvFile: '/repo/.room/workers/w.env.sh' }, {}).CLAUDE_ENV_FILE).toBeUndefined()

  expect(CODEX_SHELL_FILTER).toBe('shell_environment_policy.filters={"ROOM_*"="exclude"}')
  for (const resume of [false, true]) {
    const args = workerCommand('codex', undefined, 'task', undefined, undefined, { resume, sessionId: resume ? 's' : undefined }).args
    expect(args[args.indexOf(CODEX_SHELL_FILTER) - 1]).toBe('-c')
    expect(args.at(-1)).toBe('task')
  }
  expect(workerCommand('claude', undefined, 'task').args.join(' ')).not.toContain('shell_environment_policy')
})

it('warns when a host cannot apply the scrub', () => {
  expect(codexShellFilterWarning('codex-cli 0.145.3')).toMatch(/^warning: codex-cli 0\.145\.3 predates shell_environment_policy\.filters \(0\.146\.0\)/)
  expect(codexShellFilterWarning('codex-cli 0.146.0')).toBeUndefined()
  expect(codexShellFilterWarning('codex-cli 0.159.2')).toBeUndefined()
  expect(codexShellFilterWarning('codex-cli 1.0.0-alpha.1')).toBeUndefined()
  // Unreadable versions are not a scrub failure: a codex that cannot print its version will not start the worker either.
  expect(codexShellFilterWarning(undefined)).toBeUndefined()
  expect(workerShellEnvWarnings('w', 'claude', { file: '/x' }, 'win32', () => undefined).join('\n')).toMatch(/PowerShell/)
  expect(workerShellEnvWarnings('w', 'claude', { file: '/x' }, 'darwin', () => undefined)).toEqual([])
  expect(workerShellEnvWarnings('w', 'claude', { warning: 'warning: x' }, 'darwin', () => undefined)).toEqual(['warning: x'])
  expect(workerShellEnvWarnings('w', 'codex', {}, 'darwin', () => 'codex-cli 0.140.0')).toHaveLength(1)
  expect(workerShellEnvWarnings('w', 'codex', {}, 'darwin', () => 'codex-cli 0.159.2')).toEqual([])
})
