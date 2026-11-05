import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'

const common = new URL('../../../plugins/room/hooks/common.mjs', import.meta.url).href
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-hook-private-')); roots.push(root); return root }
function write(file: string, platform = process.platform) {
  const code = `Object.defineProperty(process,'platform',{value:${JSON.stringify(platform)}}); const {writeJsonAtomic}=await import(${JSON.stringify(common)}); writeJsonAtomic(${JSON.stringify(file)},{ok:true});`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return result.stderr
}

it.skipIf(process.platform === 'win32')('creates and repairs every legacy hook session directory as 0700', () => {
  const root = fixture(), room = path.join(root, 'room'), session = path.join(room, 'sessions', 'sid'), file = path.join(session, 'session.json')
  write(file)
  const dirs = [room, path.dirname(session), session]
  expect(dirs.map(dir => fs.statSync(dir).mode & 0o777)).toEqual([0o700, 0o700, 0o700])
  for (const dir of dirs) fs.chmodSync(dir, 0o755)
  write(file)
  expect(dirs.map(dir => fs.statSync(dir).mode & 0o777)).toEqual([0o700, 0o700, 0o700])
  expect(fs.statSync(file).mode & 0o777).toBe(0o600)
})

it('does not follow a symlink in the Room state path', () => {
  const root = fixture(), outside = fixture()
  fs.symlinkSync(outside, path.join(root, 'room'), 'junction')
  write(path.join(root, 'room', 'sessions', 'sid', 'session.json'))
  expect(fs.readdirSync(outside)).toEqual([])
})

it.skipIf(process.platform === 'win32')('writes hook state under a group-writable git parent (umask 002)', () => {
  const root = fixture(), room = path.join(root, 'room'), file = path.join(room, 'sessions', 'sid', 'session.json')
  fs.chmodSync(root, 0o775)
  write(file)
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ok: true })
  expect(fs.statSync(room).mode & 0o777).toBe(0o700)
})

it('on Windows writes only below a root bearing a regular private marker', () => {
  const root = fixture(), room = path.join(root, 'room'), file = path.join(room, 'sessions', 'sid', 'session.json')
  write(file, 'win32')
  expect(fs.existsSync(room)).toBe(false)
  fs.mkdirSync(room, { mode: 0o700 })
  write(file, 'win32')
  expect(fs.readdirSync(room)).toEqual([])
  fs.mkdirSync(path.join(room, '.private'))
  write(file, 'win32')
  expect(fs.existsSync(path.dirname(file))).toBe(false)
  fs.rmdirSync(path.join(room, '.private'))
  const target = path.join(root, 'marker')
  fs.writeFileSync(target, 'v1\n')
  fs.symlinkSync(target, path.join(room, '.private'))
  write(file, 'win32')
  expect(fs.existsSync(path.dirname(file))).toBe(false)
  fs.unlinkSync(path.join(room, '.private'))
  fs.writeFileSync(path.join(room, '.private'), 'v1\n', { mode: 0o600 })
  write(file, 'win32')
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ok: true })
})

it('runs first-start Windows hooks without Room state, output loss or deferred writes', () => {
  const root = fixture(), hooks = new URL('../../../plugins/room/hooks/', import.meta.url)
  execFileSync('git', ['init', '-q', root])
  const run = (script: string) => execFileSync(process.execPath, ['--input-type=module', '-e',
    `Object.defineProperty(process,'platform',{value:'win32'}); await import(${JSON.stringify(new URL(script, hooks).href)});`],
  { input: JSON.stringify({ cwd: root, session_id: 'fresh-session', tool_name: 'Read', tool_input: { file_path: 'app.ts' } }), encoding: 'utf8', timeout: 10000 })
  // With no MCP, neither hook has an inbox/company line to emit or acknowledge.
  expect(run('session-start.mjs')).toBe('')
  expect(run('before-edit.mjs')).toBe('')
  expect(fs.existsSync(path.join(root, '.git', 'room'))).toBe(false)
  // Nothing was queued before the root existed, so MCP initialization finds an empty root.
  const state = path.join(root, '.git', 'room')
  fs.mkdirSync(state, { mode: 0o700 })
  expect(fs.readdirSync(state)).toEqual([])
  fs.writeFileSync(path.join(state, '.private'), 'v1\n', { mode: 0o600 })
  const session = path.join(state, 'sessions', createHash('sha256').update('fresh-session').digest('hex').slice(0, 16))
  fs.mkdirSync(session, { recursive: true, mode: 0o700 })
  const snapshot = JSON.stringify({ at: Date.now(), company: true, room: 'local/test', others: ['peer'], owedCount: 2, claims: [] })
  fs.writeFileSync(path.join(session, 'state.json'), snapshot)
  // Once the MCP has created the root, hooks read its snapshot and record as on other platforms; the MCP snapshot is never rewritten by a hook.
  expect(run('session-start.mjs')).toContain('peer')
  expect(run('before-edit.mjs')).toContain('2 messages pending; Room is reconnecting.')
  expect(fs.readdirSync(session)).toContain('state.json')
  expect(fs.readFileSync(path.join(session, 'state.json'), 'utf8')).toBe(snapshot)
})
