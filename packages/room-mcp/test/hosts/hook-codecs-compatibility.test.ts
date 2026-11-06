/** Before/after hook captures from b9727223. Expectations first passed against the unextracted hooks.
 * No native host or socket is needed: these cover emitted JSON and the local receipt/runtime files. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

const hooks = fileURLToPath(new URL('../../../../plugins/room/hooks/', import.meta.url))
const roots: string[] = []
const now = 1_790_000_000_000
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-codec-'))
  roots.push(root)
  execFileSync('git', ['init', '-q', root])
  const id = 'hook-codec-session'
  const sd = path.join(root, '.git/room/sessions', createHash('sha256').update(id).digest('hex').slice(0, 16))
  const preload = path.join(root, 'clock.mjs')
  fs.writeFileSync(preload, `Date.now = () => ${now};`)
  const write = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)) }
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(sd, name), 'utf8'))
  const run = (script: string, raw: object, argv: string[] = [], nodeArgs: string[] = []) => execFileSync(process.execPath,
    [...nodeArgs, '--import', preload, path.join(hooks, script), ...argv], {
      input: JSON.stringify({ cwd: root, session_id: id, ...raw }), encoding: 'utf8', timeout: 10_000, stdio: 'pipe',
      env: { ...process.env, ROOM_WORKER_ID: '', ROOM_HOST: '', ROOM_WORKER_HOST: '' },
    })
  const receipt = () => JSON.parse(fs.readFileSync(path.join(root, '.git/room/hook-receipts', createHash('sha256').update(id).digest('hex').slice(0, 32) + '.json'), 'utf8'))
  return { root, id, sd, write, read, run, receipt }
}

it.each(['claude', 'codex'])('%s startup keeps exact output and recorded fields', host => {
  const f = fixture()
  f.write(path.join(f.sd, 'state.json'), { at: now, room: 'fixture', company: true, companyLine: '[room] Peer is here.' })
  expect(f.run('session-start.mjs', { source: '', model: ' model ', effort: { level: ' high ' }, transcript_path: '/fixture/transcript' }, host === 'claude' ? ['--host', host] : []))
    .toBe('{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[room] Peer is here."}}')
  const { chain, hostPid, ...record } = f.read('session.json')
  expect(Array.isArray(chain)).toBe(true)
  expect(hostPid === undefined || Number.isInteger(hostPid)).toBe(true)
  expect(record).toEqual({ session_id: f.id, host, cwd: f.root, at: now, source: '', model: 'model', effort: 'high', ...(host === 'claude' ? { transcript_path: '/fixture/transcript' } : {}) })
  expect(f.read('hook.json')).toEqual({ companyTold: true })
})

const edits = [
  { name: 'Write', input: { file_path: 'src/a.ts' } },
  { name: 'Edit', input: { filePath: 'src/a.ts' } },
  { name: 'Bash', input: { command: 'echo x > src/a.ts' } },
  { name: 'exec_command', input: { cmd: 'echo x > src/a.ts' } },
  { name: 'PowerShell', input: { command: 'Set-Content -Path src/a.ts -Value x' } },
  { name: 'apply_patch', input: '*** Update File: src/a.ts\n' },
]
for (const host of ['claude', 'codex', undefined]) it.each(edits)(`${host ?? 'missing record'} $name keeps JSON and receipts`, edit => {
  const f = fixture()
  if (host) f.write(path.join(f.sd, 'session.json'), { session_id: f.id, host })
  f.write(path.join(f.sd, 'state.json'), { at: now, room: 'fixture', company: true, companyLine: '[room] Peer is here.',
    near: [{ path: 'src/', by: 'Peer', reason: 'scope' }], claims: [{ id: 'claim', path: 'src/a.ts', from: 2, to: 3, by: 'Peer', intent: 'change API' }] })
  const raw = { tool_name: edit.name, tool_input: edit.input, model: ' event-model ', effort: { level: ' high ' } }
  const context = "[room] Peer is here.\n[room] Claim before editing: Peer has scope on src/.\n[room claims on src/a.ts]\n  Peer's agent holds src/a.ts:2-3 — change API. Do not edit inside that range; room_wait or ask."
  expect(f.run('before-edit.mjs', raw)).toBe(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }))
  expect(f.read('hook.json')).toEqual({ companyTold: true,
    near: { 'src/a.ts': 'open:["Peer has scope on src/"]' },
    claims: { 'src/a.ts': { claim: '["claim","src/a.ts",2,3,null,"Peer","change API",null]' } } })
  expect(f.read('runtime.json')).toEqual({ effort: 'high', ...(host === 'codex' ? { model: 'event-model' } : {}), at: now })
  expect(f.read('hook-activity.json')).toEqual({ at: now, session_id: f.id, event: 'PreToolUse' })
  expect(f.receipt()).toEqual({ sessionId: f.id, at: now })
  expect(f.run('before-edit.mjs', raw)).toBe('')
})

it.each(['claude', 'codex', undefined])('%s subagent preserves early receipts but no told-context receipt', host => {
  const f = fixture()
  if (host) f.write(path.join(f.sd, 'session.json'), { session_id: f.id, host })
  f.write(path.join(f.sd, 'state.json'), { at: now, company: true, companyLine: '[room] Peer is here.' })
  expect(f.run('before-edit.mjs', { agent_id: 'subagent', tool_name: 'Write', tool_input: { path: 'a.ts' } })).toBe('')
  expect(f.read('hook-activity.json')).toEqual({ at: now, session_id: f.id, event: 'PreToolUse' })
  expect(f.receipt()).toEqual({ sessionId: f.id, at: now })
  expect(fs.existsSync(path.join(f.sd, 'hook.json'))).toBe(false)
})

it.each(['claude', 'codex', undefined])('%s failed stdout preserves early receipts without recording shown context', host => {
  const f = fixture()
  if (host) f.write(path.join(f.sd, 'session.json'), { session_id: f.id, host })
  f.write(path.join(f.sd, 'state.json'), { at: now, company: true, companyLine: '[room] Peer is here.' })
  const failStdout = path.join(f.root, 'stdout.mjs')
  fs.writeFileSync(failStdout, "process.stdout.write = (_text, callback) => { callback(new Error('closed')); return false };")
  expect(f.run('before-edit.mjs', { tool_name: 'Write', tool_input: { path: 'a.ts' } }, [], ['--import', failStdout])).toBe('')
  expect(f.receipt()).toEqual({ sessionId: f.id, at: now })
  expect(fs.existsSync(path.join(f.sd, 'hook.json'))).toBe(false)
  expect(f.run('before-edit.mjs', { tool_name: 'Read' })).toContain('[room] Peer is here.')
})

it('retries absent and unreadable transcripts, preserving runtime until a changed tail is readable', () => {
  const f = fixture(), transcript = path.join(f.root, 'transcript')
  f.write(path.join(f.sd, 'session.json'), { session_id: f.id, host: 'claude', model: 'startup-model' })
  f.write(path.join(f.sd, 'runtime.json'), { model: 'previous-model', effort: 'low', extra: 'keep', at: 1 })
  const raw = { tool_name: 'Read', transcript_path: transcript, effort: { level: 'high' } }
  f.run('before-edit.mjs', raw)
  expect(f.read('runtime.json')).toEqual({ model: 'previous-model', effort: 'high', extra: 'keep', at: now })
  // A directory stats successfully but cannot be read as a transcript on supported hosts.
  fs.mkdirSync(transcript)
  f.run('before-edit.mjs', raw)
  expect(f.read('runtime.json').transcript).toBeUndefined()
  fs.rmdirSync(transcript)
  fs.writeFileSync(transcript, JSON.stringify({ message: { model: 'lagging-model' } }) + '\n')
  f.run('before-edit.mjs', raw)
  const first = f.read('runtime.json')
  expect(first.model).toBe('previous-model')
  expect(first.transcript).toEqual({ path: transcript, mtimeMs: fs.statSync(transcript).mtimeMs, size: fs.statSync(transcript).size })
  fs.renameSync(transcript, transcript + '.old')
  f.run('before-edit.mjs', raw)
  expect(f.read('runtime.json')).toEqual(first)
  fs.writeFileSync(transcript, JSON.stringify({ message: { model: 'switched-model' } }) + '\n')
  f.run('before-edit.mjs', raw)
  expect(f.read('runtime.json')).toMatchObject({ model: 'switched-model', effort: 'high', extra: 'keep', transcript: { path: transcript } })
})
