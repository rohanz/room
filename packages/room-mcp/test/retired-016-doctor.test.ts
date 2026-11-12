import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { collectLocalState } from '../src/local-state-gc.js'
import { resolveConfig } from '../src/config.js'
import { rememberTag } from '../src/choice.js'
import { joinSession } from '../src/session.js'
import { openPreferred } from '../../relay/src/daemon.js'
import { localRoomName } from '../../roomd/src/local.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-retire-r2-'))); roots.push(dir)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'init')
  const linked = path.join(dir, 'linked'); git('worktree', 'add', '-qb', 'feature', linked)
  return { dir, linked, common: path.join(dir, '.git'), git }
}
const write = (file: string, text = 'never read these private bytes') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file }

it('ignores linked-worktree old choices without rewriting them but retains schema-2 and custom choices', async () => {
  const { dir, linked, common } = repo(), file = path.join(common, 'room-choice.json'), room = await localRoomName(linked)
  expect(room).toBe(`local/${path.basename(dir)}`)
  for (const [name, schema, expected] of [[`${room}/feature`, undefined, undefined], [`${room}/feature`, 2, `${room}/feature`], ['local/another/custom', undefined, 'local/another/custom']] as const) {
    const before = JSON.stringify({ where: 'local', room: name, at: 1, ...(schema ? { schema } : {}) })
    fs.writeFileSync(file, before)
    expect((await resolveConfig({ dir: linked, env: {} })).room).toBe(expected)
    expect((await resolveConfig({ dir, env: {} })).room).toBe(expected)
    if (schema === undefined && expected === undefined) await rememberTag(linked, 'new-session')
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  }
})

it.each(['', '   ', '!!!'])('refuses an explicit empty/invalid local room %j before daemon startup even beside a remembered choice', async room => {
  const { dir, common } = repo()
  write(path.join(common, 'room-choice.json'), JSON.stringify({ where: 'local', room: 'local/remembered', schema: 2, at: 1 }))
  await expect(joinSession({ dir, server: 'local', name: 'Test', room })).rejects.toThrow(/local room name must not be empty/)
  expect(fs.existsSync(path.join(common, 'room', 'relay.json'))).toBe(false)
})

it('preserves old journals and sources through GC without reading their contents', () => {
  const { common, linked } = repo()
  const own = execFileSync('git', ['-C', linked, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim()
  const files = [write(path.join(common, 'room/registry/migration.json'), '{"done":false}'),
    write(path.join(common, 'room/registry/migration.lock')), write(path.join(common, 'room/relay/migrated-old.json')),
    write(path.join(common, 'room-local/old.ydoc')), write(path.join(own, 'room-session.json'))]
  const before = files.map(file => fs.readFileSync(file))
  for (const file of files) fs.utimesSync(file, new Date(0), new Date(0))
  const read = vi.spyOn(fs, 'readFileSync')
  collectLocalState(common, { probe: () => undefined })
  expect(read.mock.calls.some(([p]) => files.includes(String(p)))).toBe(false)
  read.mockRestore()
  expect(files.map(file => fs.readFileSync(file))).toEqual(before)
})

it('uses a separate port when an unrelated old-format relay occupies the preferred port', async () => {
  const open = vi.fn(async (port: number) => { if (port === 4404) throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' }); return port })
  expect(await openPreferred(4404, open, async () => false)).toBe(0)
  expect(open.mock.calls).toEqual([[4404], [0]])
})

it.each(['session-start.mjs', 'before-edit.mjs'])('the shipped %s hook never reads, rewrites or removes old-format hook state in main or linked Git dirs', script => {
  const { dir, common, linked } = repo()
  const own = execFileSync('git', ['-C', linked, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim()
  const names = ['room-session.json', 'room-hook-seen.json', 'room-state.json', 'room-hook-activity.json', 'room-write-intents-previous.json', 'previous.notice-lock']
  const files = [common, own].flatMap(root => names.map(name => write(path.join(root, name), '{"session_id":"current-session","companyTold":true}')))
  const before = files.map(file => fs.readFileSync(file))
  const preload = path.join(dir, 'audit-old.cjs')
  fs.writeFileSync(preload, `
const fs = require('node:fs'), path = require('node:path'), old = new Set(${JSON.stringify(files)}), touched = [];
for (const method of ['readFileSync','writeFileSync','appendFileSync','rmSync','unlinkSync','renameSync']) {
 const original = fs[method];
 fs[method] = function (...args) {
  if (args.slice(0, method === 'renameSync' ? 2 : 1).some(v => old.has(path.resolve(String(v))))) touched.push(method);
  return original.apply(this, args);
 };
}
process.on('exit', () => process.stdout.write('AUDIT ' + JSON.stringify(touched) + '\\n'));
`)
  const hook = new URL('../../../plugins/room/hooks/' + script, import.meta.url).pathname
  for (const cwd of [dir, linked]) {
    const stdout = execFileSync(process.execPath, ['--require', preload, hook, '--host', 'claude'], {
      input: JSON.stringify({ cwd, session_id: 'current-session', tool_name: 'Read', tool_input: {} }), encoding: 'utf8', timeout: 10000,
    })
    expect(stdout.split('\n').find(line => line.startsWith('AUDIT '))).toBe('AUDIT []')
  }
  expect(files.map(file => fs.readFileSync(file))).toEqual(before)
})
