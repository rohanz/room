import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
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

function powerShellHook(input: unknown) {
  const written = writeWorkerShellEnv(tmp(), 'w', undefined)
  expect(written.hook, 'Claude Bash-only env file leaves PowerShell ROOM_* untouched').toBeTypeOf('string')
  return spawnSync(process.execPath, [written.hook!], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, ROOM_WORKER_ID: 'worker-id', ROOM_TOKEN: 'test-token', PORT: '4414', OMP_NUM_THREADS: '2' },
  })
}

it('isolates PowerShell with visible updatedInput and preserves all fields and normal permission review', () => {
  const input = { command: "Write-Output 'a quoted $value `tick'\r\nnode --version # trailing comment", timeout: 9000, description: 'run', run_in_background: false }
  const result = powerShellHook({ hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: input })
  expect(result.status).toBe(0)
  const out = JSON.parse(result.stdout)
  expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: {
    ...input, command: expect.stringContaining(input.command),
  } } })
  expect(out.hookSpecificOutput.updatedInput.command).toMatch(/^Get-ChildItem Env:ROOM_\* \| Remove-Item -ErrorAction Stop\r?\n/)
  expect(out.hookSpecificOutput.updatedInput.command.endsWith(input.command)).toBe(true)
  expect(out.hookSpecificOutput).not.toHaveProperty('permissionDecision')
})

it('leaves Bash, MCP calls and other hook events unchanged', () => {
  for (const event of [
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'env' } },
    { hook_event_name: 'PreToolUse', tool_name: 'mcp__room__room_state', tool_input: {} },
    { hook_event_name: 'SessionStart', tool_name: 'PowerShell', tool_input: { command: 'env' } },
  ]) {
    const result = powerShellHook(event)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  }
})

it('does not add a second scrub prefix when the host retries modified input', () => {
  const event = { hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command: 'node --version' } }
  const first = JSON.parse(powerShellHook(event).stdout)
  const second = JSON.parse(powerShellHook({ ...event, tool_input: first.hookSpecificOutput.updatedInput }).stdout)
  expect(second).toEqual(first)
})

it('denies malformed inputs and unsupported PowerShell declarations instead of running unsanitized', () => {
  for (const input of [
    '{broken',
    null,
    [],
    { tool_name: 'PowerShell', tool_input: { command: 'node --version' } },
    { hook_event_name: 'PreToolUse', tool_input: { command: 'node --version' } },
    { hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: {} },
    { hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command: 1 } },
    ...['param($name)\nWrite-Output $name', 'param <# comment #> ($name)', '# comment\n[CmdletBinding()]\nparam($name)', '#requires -Version 7\nnode --version', 'using namespace System\nnode --version', 'using <# comment #> namespace System', "Write-Output 'param($name)'", "Write-Output 'param'"]
      .map(command => ({ hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command } })),
  ]) {
    const result = powerShellHook(input)
    expect(result.status).toBe(0)
    const out = JSON.parse(result.stdout).hookSpecificOutput
    expect(out.hookEventName).toBe('PreToolUse')
    expect(out.permissionDecision).toBe('deny')
    expect(out.permissionDecisionReason).toMatch(/Room.*PowerShell/)
    expect(out).not.toHaveProperty('updatedInput')
  }
})

it('uses an exec-form worker hook on fresh/resumed Claude launches without replacing existing settings', () => {
  const hook = "C:\\room space\\worker's $name `tick\\w.shell-env.mjs"
  for (const resume of [false, true]) for (const pluginDir of [undefined, 'C:\\plugin space']) {
    const args = workerCommand('claude', undefined, 'task', undefined, undefined,
      { resume, sessionId: resume ? 's' : undefined, pluginDir, shellEnvHook: hook }).args
    expect(args.filter(v => v === '--settings')).toHaveLength(1)
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({
      ...(pluginDir ? { enabledPlugins: { 'room@room': false } } : {}),
      hooks: { PreToolUse: [{ matcher: 'PowerShell', hooks: [{ type: 'command', command: 'node', args: [hook], timeout: 5 }] }] },
    })
    expect(args).toContain('acceptEdits')
    expect(args).not.toContain('--dangerously-skip-permissions')
  }
})

const powerShell = ['pwsh', ...(process.platform === 'win32' ? ['powershell.exe'] : [])].find(bin =>
  spawnSync(bin, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 5000, stdio: 'ignore' }).status === 0)

const skipNativePowerShell = (platform: NodeJS.Platform, shell: string | undefined) => platform !== 'win32' && !shell

it('requires a usable PowerShell on Windows instead of silently skipping native CI coverage', () => {
  expect(skipNativePowerShell('win32', undefined)).toBe(false)
  expect(skipNativePowerShell('win32', 'powershell.exe')).toBe(false)
  expect(skipNativePowerShell('darwin', undefined)).toBe(true)
  expect(skipNativePowerShell('linux', 'pwsh')).toBe(false)
})

it.skipIf(skipNativePowerShell(process.platform, powerShell))('executes the scrub on real PowerShell: child drops ROOM_* and keeps PORT, caps, user env; host stays coordinated', () => {
  expect(powerShell, 'Native Windows PowerShell coverage requires usable pwsh or powershell.exe; the shell is missing, blocked, or its bounded probe failed.').toBeDefined()
  const toolInput = { command: "[ordered]@{ roomNames = @(Get-ChildItem Env:ROOM_* | Select-Object -ExpandProperty Name); port = $env:PORT; cap = $env:OMP_NUM_THREADS; user = $env:USER_SETTING } | ConvertTo-Json -Compress" }
  const out = JSON.parse(powerShellHook({ hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: toolInput }).stdout)
  const host = { ...process.env, ROOM_WORKER_ID: 'worker-id', ROOM_TOKEN: 'test-token', room_lower: 'lower', PORT: '4414', OMP_NUM_THREADS: '2', USER_SETTING: 'preserved' }
  const command = out.hookSpecificOutput.updatedInput.command
  const result = JSON.parse(execFileSync(powerShell!, ['-NoProfile', '-NonInteractive', '-Command', command], { env: host, encoding: 'utf8', timeout: 5000 }))
  expect(result).toEqual({ roomNames: [], port: '4414', cap: '2', user: 'preserved' })
  const withoutRoom = Object.fromEntries(Object.entries(host).filter(([key]) => !/^ROOM_/i.test(key)))
  const empty = spawnSync(powerShell!, ['-NoProfile', '-NonInteractive', '-Command', command], { env: withoutRoom, encoding: 'utf8', timeout: 5000 })
  expect(empty.status).toBe(0)
  expect(empty.stderr).toBe('')
  expect(JSON.parse(empty.stdout)).toEqual({ roomNames: [], port: '4414', cap: '2', user: 'preserved' })
  expect(host.ROOM_WORKER_ID).toBe('worker-id')
  expect(host.ROOM_TOKEN).toBe('test-token')
})

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

it('writes both artifacts 0600 next to the worker log, replacing rather than following planted links', () => {
  const lead = tmp()
  const workers = path.join(lead, '.room', 'workers')
  fs.mkdirSync(workers, { recursive: true })
  const target = path.join(lead, 'elsewhere')
  fs.writeFileSync(target, 'untouched')
  fs.symlinkSync(target, path.join(workers, 'w.env.sh'))
  fs.symlinkSync(target, path.join(workers, 'w.shell-env.mjs'))
  const written = writeWorkerShellEnv(lead, 'w', undefined)
  expect(written).toEqual({ file: path.join(workers, 'w.env.sh'), hook: path.join(workers, 'w.shell-env.mjs') })
  expect(fs.lstatSync(written.file!).isSymbolicLink()).toBe(false)
  expect(fs.lstatSync(written.hook!).isSymbolicLink()).toBe(false)
  if (process.platform !== 'win32') for (const file of [written.file!, written.hook!]) expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  expect(fs.readFileSync(target, 'utf8')).toBe('untouched')
  expect(fs.readFileSync(written.file!, 'utf8')).toBe(workerShellEnvScript())
})

it('refuses a linked .room or workers directory instead of writing through it', () => {
  for (const linked of ['.room', 'workers']) {
    const lead = tmp(), outside = tmp()
    for (const file of ['w.env.sh', 'w.shell-env.mjs']) fs.writeFileSync(path.join(outside, file), 'untouched')
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    if (linked === '.room') fs.symlinkSync(outside, path.join(lead, '.room'), type)
    else { fs.mkdirSync(path.join(lead, '.room')); fs.symlinkSync(outside, path.join(lead, '.room', 'workers'), type) }
    const written = writeWorkerShellEnv(lead, 'w', undefined)
    expect(written.file).toBeUndefined()
    expect(written.hook).toBeUndefined()
    expect(written.warning).toContain('still see Room')
    expect(fs.readFileSync(path.join(outside, 'w.env.sh'), 'utf8')).toBe('untouched')
    expect(fs.readFileSync(path.join(outside, 'w.shell-env.mjs'), 'utf8')).toBe('untouched')
  }
})

it('reports a partial hook write failure while retaining the working Bash env file', async () => {
  const lead = tmp()
  const workers = path.join(lead, '.room', 'workers')
  fs.mkdirSync(path.join(workers, 'w.shell-env.mjs'), { recursive: true })
  const written = writeWorkerShellEnv(lead, 'w', undefined)
  expect(written.file).toBe(path.join(workers, 'w.env.sh'))
  expect(written.hook).toBeUndefined()
  expect(fs.readFileSync(written.file!, 'utf8')).toBe(workerShellEnvScript())
  expect(written.warning).toMatch(/could not write .*w\.shell-env\.mjs .*PowerShell commands still see/)
  expect(await workerShellEnvWarnings('w', 'claude', written, 'darwin')).toEqual([written.warning])
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
  for (const name of ['w.log', 'w.mcp.log', 'w.env.sh', 'w.shell-env.mjs']) fs.writeFileSync(path.join(workers, name), '')
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

it('warns when a host cannot apply the scrub', async () => {
  expect(codexShellFilterWarning('codex-cli 0.145.3')).toMatch(/^warning: codex-cli 0\.145\.3 predates shell_environment_policy\.filters \(0\.146\.0\)/)
  expect(codexShellFilterWarning('codex-cli 0.146.0')).toBeUndefined()
  expect(codexShellFilterWarning('codex-cli 0.159.2')).toBeUndefined()
  expect(codexShellFilterWarning('codex-cli 1.0.0-alpha.1')).toBeUndefined()
  // Unreadable versions are not a scrub failure: a codex that cannot print its version will not start the worker either.
  expect(codexShellFilterWarning(undefined)).toBeUndefined()
  expect((await workerShellEnvWarnings('w', 'claude', { file: '/x' }, 'win32', async () => undefined)).join('\n')).toMatch(/PowerShell/)
  expect(await workerShellEnvWarnings('w', 'claude', { file: '/x', hook: '/h' }, 'win32')).toEqual([])
  expect(await workerShellEnvWarnings('w', 'claude', { file: '/x' }, 'darwin', async () => undefined)).toEqual([])
  expect(await workerShellEnvWarnings('w', 'claude', { warning: 'warning: x' }, 'darwin', async () => undefined)).toEqual(['warning: x'])
  expect(await workerShellEnvWarnings('w', 'codex', {}, 'darwin', async () => 'codex-cli 0.140.0')).toHaveLength(1)
  expect(await workerShellEnvWarnings('w', 'codex', {}, 'darwin', async () => 'codex-cli 0.159.2')).toEqual([])
})

// rc11 rehearsal R4: the first spawn ran `codex --version` synchronously, stalling the lead's MCP (4.8 s in the
// load reproduction) while every other tool call waited. This runs the real reader against a slow `codex`.
it.skipIf(process.platform === 'win32')('reads the installed Codex version without blocking the event loop (POSIX fake codex fixture)', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'room-codex-version-'))
  try {
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nsleep 0.5\necho codex-cli 0.140.0\n', { mode: 0o755 })
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`)
    const started = performance.now()
    const pending = workerShellEnvWarnings('w', 'codex', {}, 'darwin')
    expect(performance.now() - started).toBeLessThan(250)
    let timerRan = false
    setTimeout(() => { timerRan = true }, 10)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(timerRan).toBe(true)
    expect(await pending).toEqual([expect.stringMatching(/^warning: codex-cli 0\.140\.0 predates/)])
  } finally { vi.unstubAllEnvs(); fs.rmSync(bin, { recursive: true, force: true }) }
})
