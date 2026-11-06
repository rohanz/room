/**
 * Local daemon cutover rehearsal on a throwaway clone (docs/upgrading.md, "Local daemon cutover").
 *
 *   npx tsx scripts/cutover-rehearsal.mts --old <plugin dir of the pre-daemon release> [--new <plugin dir>]
 *
 * Two sessions run the OLD plugin's real MCP bundle, leave unread mail, then exit (the old relay saves and stops).
 * A session on the NEW bundle then performs the cutover: it must report a clean check, run on the daemon and still
 * receive the mail. Finally the daemon is stopped with the documented `room-daemon.mjs stop`. Nothing outside a
 * temporary directory is touched; ROOM_* variables from this shell are not passed on.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(name)
  const value = i >= 0 ? process.argv[i + 1] : fallback
  if (!value) throw new Error(`missing ${name}`)
  return path.resolve(value)
}
const oldPlugin = arg('--old'), newPlugin = arg('--new', path.join(import.meta.dirname, '..', 'plugins', 'room'))
const fromClone = process.argv.includes('--from-clone') ? arg('--from-clone') : undefined
const bundle = (plugin: string) => {
  const file = path.join(plugin, 'server', 'room-mcp.mjs')
  if (!fs.existsSync(file)) throw new Error(`no MCP bundle at ${file}`)
  return file
}
const version = (plugin: string) => JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).version as string

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-cutover-rehearsal-'))
fs.chmodSync(root, 0o700)
const clone = path.join(root, 'shop')
try {
fs.mkdirSync(clone)
const git = (...args: string[]) => execFileSync('git', args, { cwd: clone, encoding: 'utf8' }).trim()
git('init', '-q'); git('config', 'user.email', 'rehearsal@example.invalid'); git('config', 'user.name', 'Rehearsal')
fs.writeFileSync(path.join(clone, 'app.py'), 'def total(items):\n    return sum(items)\n')
git('add', '.'); git('commit', '-qm', 'init')
const common = path.resolve(clone, git('rev-parse', '--git-common-dir'))

function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(ROOM_|CLAUDE|CODEX_)/.test(k)) env[k] = v
  return env
}
const clients: Client[] = []
async function session(plugin: string, name: string) {
  const home = fs.mkdtempSync(path.join(root, `home-${name}-`))
  const env = scrubbedEnv()
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), ROOM_DIR: clone, ROOM_NAME: name })
  const stderr: string[] = []
  const transport = new StdioClientTransport({ command: process.execPath, args: [bundle(plugin)], env, cwd: clone, stderr: 'pipe' })
  transport.stderr?.on('data', d => stderr.push(...String(d).split('\n').filter(Boolean)))
  const client = new Client({ name: 'cutover-rehearsal', version: '1' })
  await client.connect(transport)
  clients.push(client)
  const call = async (tool: string, args: Record<string, unknown> = {}) =>
    ((await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 })).content as { text: string }[])[0].text
  return { call, stderr, close: () => client.close() }
}
const relayInfo = () => { try { return JSON.parse(fs.readFileSync(path.join(common, 'room', 'relay.json'), 'utf8')) as { pid: number; runtime?: string } } catch { return undefined } }
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 60_000) => {
  const end = Date.now() + ms
  while (!(await ok())) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 250)) }
}
/** On failure keep only the logs and a key-free discovery record, never the copied room state. */
const keepDiagnostics = () => {
  const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'room-cutover-diagnostics-'))
  fs.chmodSync(kept, 0o700)
  for (const [from, name] of [[path.join(common, 'room-mcp.log'), 'room-mcp.log'], [path.join(common, 'room-mcp.log.1'), 'room-mcp.log.1'],
    [path.join(common, 'room', 'daemon.log'), 'daemon.log']] as const) if (fs.existsSync(from)) fs.copyFileSync(from, path.join(kept, name))
  const info = relayInfo() as Record<string, unknown> | undefined
  if (info) fs.writeFileSync(path.join(kept, 'relay.json'), JSON.stringify({ ...info, key: undefined }, null, 2), { mode: 0o600 })
  return kept
}
const step = (text: string) => console.log(`\n== ${text}`)
const check = (label: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`); if (!ok) failures++ }
let failures = 0
const MAIL = `REHEARSAL-MAIL-${Date.now()}`

try {
  if (fromClone) {
    const target = path.join(common, 'room')
    fs.cpSync(path.join(fromClone, 'room'), target, { recursive: true, dereference: false, filter: source => {
      const name = path.basename(source)
      // The source clone's drain record and operator resolutions are bound to that clone and never apply here.
      return name !== 'relay.key' && !/lock/i.test(name) && name !== 'daemon-cutover.json' && name !== 'daemon-cutover-resolutions.json'
        && !fs.lstatSync(source).isSymbolicLink()
    } })
    // Discovery from another clone must never address its live listener or carry its key.
    const discovery = path.join(target, 'relay.json')
    if (fs.existsSync(discovery)) fs.writeFileSync(discovery, JSON.stringify({ schema: 2, pid: 2147483647, port: 1, key: 'rehearsal-only' }), { mode: 0o600 })
  }
  step(`old plugin ${version(oldPlugin)}: Ada and Ben join and leave unread mail`)
  const ada = await session(oldPlugin, 'Ada'), ben = await session(oldPlugin, 'Ben')
  console.log((await ada.call('room_state')).split('\n')[0])
  await until('Ben to appear to Ada', async () => (await ada.call('room_state')).includes('Ben'))
  const sent = await ada.call('room_send', { type: 'note', to: 'Ben', text: MAIL })
  check('old session sent mail to Ben', /^sent/.test(sent), sent.split('\n')[0])
  const oldOwner = relayInfo()
  check('old runtime owns the clone', !!oldOwner && oldOwner.runtime !== 'daemon', JSON.stringify({ pid: oldOwner?.pid, runtime: oldOwner?.runtime ?? 'in-session' }))

  // A clone that has been used for a while also holds clone-wide files in sessions/, such as the durable
  // idle-episode counter. 0.17.34-0.17.37 refused cutover on it (ENOTDIR); keep the rehearsal realistic.
  fs.mkdirSync(path.join(common, 'room', 'sessions'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(common, 'room', 'sessions', 'idle-episode.json'), JSON.stringify({ max: 2 }) + '\n', { mode: 0o600 })

  step('drain: close every old client and wait for the old owner to save and exit')
  await ben.close(); await ada.close(); clients.length = 0
  await until('old owner exit', () => !oldOwner || !alive(oldOwner.pid))
  check('old owner exited', !oldOwner || !alive(oldOwner.pid))

  if (process.argv.includes('--resolve-blocked')) {
    // Plays the operator in this scratch copy only: each record the cutover cannot prove gone is resolved with the
    // printed command, as a person would after the checks it names. Never use this flag's logic on a live clone.
    step('operator: resolve records the cutover cannot prove gone (scratch copy only)')
    const mcp = path.join(newPlugin, 'server', 'room-mcp.mjs')
    let report = ''
    try { report = execFileSync(process.execPath, [mcp, 'doctor', '--dir', clone], { encoding: 'utf8', env: scrubbedEnv() }) }
    catch (error) { report = String((error as { stdout?: string }).stdout ?? '') }
    const records = [...report.matchAll(/^FIX .*?Record ("(?:[^"\\]|\\.)*")\. /gm)].map(m => JSON.parse(m[1]) as string)
    for (const record of records) {
      execFileSync(process.execPath, [mcp, 'cutover-resolve', '--dir', clone, '--record', record, '--confirm-not-running', '--note', 'rehearsal'], { encoding: 'utf8', env: scrubbedEnv() })
      console.log(`resolved ${record}`)
    }
    check('blocked records resolved through the documented command', true, `${records.length} record(s)`)
  }
  step(`new plugin ${version(newPlugin)}: Ben starts, cutover runs, daemon starts`)
  const newBen = await session(newPlugin, 'Ben')
  const health = await newBen.call('room_state', { check: true })
  console.log(health.split('\n').filter(line => /cutover|daemon|FAIL|WARN/i.test(line)).join('\n') || health.split('\n').slice(0, 8).join('\n'))
  check('check reports no failures', !/^\s*FAIL/m.test(health))
  check('check reports the cutover rows', /^INFO  local daemon cutover: /m.test(health))
  check('daemon owns the clone', relayInfo()?.runtime === 'daemon', JSON.stringify(relayInfo() && { pid: relayInfo()!.pid, runtime: relayInfo()!.runtime }))
  check('drain record written', fs.existsSync(path.join(common, 'room', 'daemon-cutover.json')))
  let mail = ''
  await until('Ada\'s mail to reach Ben', async () => (mail = await newBen.call('room_read')).includes(MAIL), 30_000).catch(() => undefined)
  check('mail sent before the cutover is delivered after it', mail.includes(MAIL))
  await newBen.close(); clients.length = 0

  step('rollback path: documented authenticated stop')
  const daemon = relayInfo()
  const stopped = execFileSync(process.execPath, [path.join(newPlugin, 'server', 'room-daemon.mjs'), 'stop', '--common-dir', common], { encoding: 'utf8' })
  check('room-daemon.mjs stop saved and exited', /saved and process exit verified/i.test(stopped), stopped.trim())
  check('daemon process gone', !daemon || !alive(daemon.pid))
} catch (error) {
  failures++
  console.error(`FAIL  rehearsal aborted: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await Promise.allSettled(clients.map(c => c.close()))
  const info = relayInfo()
  if (info && alive(info.pid) && info.runtime === 'daemon') {
    try { execFileSync(process.execPath, [path.join(newPlugin, 'server', 'room-daemon.mjs'), 'stop', '--common-dir', common], { stdio: 'ignore' }) } catch { /* reported above */ }
  }
  if (failures) console.log(`\nkept diagnostics in ${keepDiagnostics()} (private; delete when done)`)
  fs.rmSync(root, { recursive: true, force: true })
  console.log(failures === 0 ? '\nREHEARSAL PASSED' : `\nREHEARSAL FAILED (${failures})`)
  process.exitCode = failures === 0 ? 0 : 1
}

} finally { fs.rmSync(root, { recursive: true, force: true }) }
