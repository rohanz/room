/**
 * Windows diagnostic: why does PowerShell time out inside the detached local daemon but not in a normal child?
 * Launches node children the way packages/relay/src/daemon.ts launches the daemon (variants below), and each child
 * runs the same kind of PowerShell ACL inspection private-state.ts runs, recording elapsed time and stderr to a file.
 * Run: node scripts/windows-powershell-probe.mjs   (manual workflow .github/workflows/windows-diagnostics.yml)
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

if (process.argv[2] === 'child') {
  const [, , , out, target] = process.argv
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== 'psmodulepath') env[k] = v
  env.ROOM_PRIVATE_PATH = target
  const script = "$ErrorActionPreference='Stop'; $p=$env:ROOM_PRIVATE_PATH; $a=Get-Acl -LiteralPath $p; $a.GetOwner([Security.Principal.SecurityIdentifier]).Value"
  const started = Date.now()
  let result
  try {
    const stdout = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env, timeout: 30_000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    result = { ok: true, ms: Date.now() - started, stdout: stdout.trim() }
  } catch (error) {
    result = { ok: false, ms: Date.now() - started, code: error.code, signal: error.signal, stderr: String(error.stderr ?? '').slice(0, 800), message: String(error.message).slice(0, 300) }
  }
  fs.writeFileSync(out, JSON.stringify(result))
  process.exit(0)
}

const minimalEnv = () => {
  const env = {}
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'TZ',
    'SystemDrive', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'ComSpec', 'PATHEXT', 'APPDATA',
    'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME']) if (process.env[name] !== undefined) env[name] = process.env[name]
  return env
}
const variants = [
  { name: 'attached, full env, inherit stdio', detached: false, env: process.env, stdio: 'ignore', windowsHide: true },
  { name: 'detached, full env', detached: true, env: process.env, stdio: 'ignore', windowsHide: true },
  { name: 'detached, minimal env (daemon)', detached: true, env: minimalEnv(), stdio: 'ignore', windowsHide: true },
  { name: 'attached, minimal env', detached: false, env: minimalEnv(), stdio: 'ignore', windowsHide: true },
  { name: 'detached, minimal env, windowsHide false', detached: true, env: minimalEnv(), stdio: 'ignore', windowsHide: false },
]
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-probe-'))
for (const v of variants) {
  const out = path.join(dir, `${variants.indexOf(v)}.json`)
  const started = Date.now()
  const child = spawn(process.execPath, [process.argv[1], 'child', out, dir], { detached: v.detached, env: v.env, stdio: v.stdio, windowsHide: v.windowsHide, shell: false })
  child.unref()
  while (!fs.existsSync(out) && Date.now() - started < 45_000) await new Promise(r => setTimeout(r, 200))
  const result = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { ok: false, message: 'no result within 45 s' }
  console.log(`${v.name}: ${JSON.stringify(result)}`)
}
