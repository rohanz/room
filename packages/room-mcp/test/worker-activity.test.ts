import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { workerLine, type WorkerView } from '@room/shared'
import { activityFromEvent, WorkerActivityTracker, ACTIVITY_MAX } from '../src/worker-activity.js'
import { defaultSpawner } from '../src/worker-process.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'room-worker-activity-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
const wt = '/repo/.room/workers/tax'
const SECRET = 'TOPSECRET'
const claudeTool = (name: string, input: object) => JSON.stringify({ type: 'assistant', session_id: 's', message: { content: [{ type: 'tool_use', id: 't', name, input }] } })
const codexItem = (item: object, type = 'item.started') => JSON.stringify({ type, item: { id: 'item_1', ...item } })

describe('activityFromEvent (Claude stream-json)', () => {
  it('labels file tools with the worktree-relative path', () => {
    expect(activityFromEvent(claudeTool('Edit', { file_path: `${wt}/api/tax.py`, old_string: SECRET, new_string: SECRET }), 'claude', wt)).toBe('editing api/tax.py')
    expect(activityFromEvent(claudeTool('Write', { file_path: `${wt}/api/new.py`, content: SECRET }), 'claude', wt)).toBe('editing api/new.py')
    expect(activityFromEvent(claudeTool('Read', { file_path: `${wt}/README.md` }), 'claude', wt)).toBe('reading README.md')
    expect(activityFromEvent(claudeTool('Grep', { pattern: SECRET }), 'claude', wt)).toBe('searching')
  })
  it('keeps only the program and subcommand of a shell command', () => {
    expect(activityFromEvent(claudeTool('Bash', { command: `cd ${wt} && npx vitest run test/x.test.ts --token=${SECRET}`, description: SECRET }), 'claude', wt)).toBe('running npx vitest')
    expect(activityFromEvent(claudeTool('Bash', { command: `/usr/bin/curl -H "Authorization: ${SECRET}" https://x` }), 'claude', wt)).toBe('running curl')
    expect(activityFromEvent(claudeTool('Bash', { command: `git status` }), 'claude', wt)).toBe('running git status')
    expect(activityFromEvent(claudeTool('Bash', { command: `uv run pytest -k ${SECRET}` }), 'claude', wt)).toBe('running uv run')
  })
  const bash = (command: string) => activityFromEvent(claudeTool('Bash', { command }), 'claude', wt)
  it('never takes an argument for a subcommand', () => {
    expect(bash('claude SecretToken123')).toBe('running claude')
    expect(bash(`git ${SECRET}`)).toBe('running git')
    expect(bash(`npm run ${SECRET}`)).toBe('running npm run')
    expect(bash(`npx ${SECRET} --yes`)).toBe('running npx')
    expect(bash(`codex exec ${SECRET}`)).toBe('running codex')
  })
  it('labels quoted or env-prefixed commands only as a command', () => {
    expect(bash(`API_KEY='alpha ${SECRET} omega' npm test`)).toBe('running a command')
    expect(bash(`API_KEY=${SECRET} /usr/bin/curl -H "Authorization: ${SECRET}" https://x`)).toBe('running a command')
    expect(bash(`env API_KEY='alpha ${SECRET} omega' npm test`)).toBe('running a command')
    expect(bash(`env API_KEY="${SECRET}" npm test`)).toBe('running a command')
    expect(bash(`env -i ${SECRET} npm test`)).toBe('running a command')
    expect(bash(`'${SECRET}' --flag`)).toBe('running a command')
    expect(bash(`"/opt/my ${SECRET}/bin/tool" x`)).toBe('running a command')
    expect(bash(`$HOME/${SECRET}/run`)).toBe('running a command')
    expect(bash(`(${SECRET})`)).toBe('running a command')
    // A cd whose argument is quoted is not skipped, so the words inside the quotes are never read.
    expect(bash(`cd "x && ${SECRET} && y" && npm test`)).toBe('running cd')
  })
  it('labels the program env runs, never its names or values', () => {
    expect(bash(`env -u ROOM_TAG -u ROOM_OWNER npx vitest run test/x.test.ts`)).toBe('running npx vitest')
    expect(bash(`env API_KEY=${SECRET} npm test`)).toBe('running npm test')
    expect(bash(`cd ${wt} && env -u ROOM_TAG CI=1 /usr/bin/git status`)).toBe('running git status')
    expect(bash(`/usr/bin/env NODE_ENV=${SECRET} node x.js`)).toBe('running node')
    for (const command of [`env -u ROOM_TAG npx vitest`, `env API_KEY=${SECRET} npm test`]) expect(bash(command)).not.toMatch(/ROOM_TAG|API_KEY|SECRET/)
  })
  it('gives trivial env and probe commands no label', () => {
    for (const command of ['env', 'printenv', `printenv ${SECRET}`, 'pwd', 'which node', `echo $${SECRET}`, 'true', 'sleep 5', 'ls -la src', 'env -u ROOM_TAG', `env -u ROOM_TAG FOO=${SECRET}`, `cd ${wt} && pwd`])
      expect(bash(command)).toBeUndefined()
    expect(activityFromEvent(codexItem({ type: 'command_execution', command: "/bin/zsh -lc 'env -u ROOM_TAG'" }), 'codex', wt)).toBeUndefined()
  })
  it('keeps the last meaningful activity when a probe follows it', () => {
    const file = path.join(tmp, 'probe.log')
    fs.writeFileSync(file, claudeTool('Bash', { command: 'env -u ROOM_TAG npx vitest run' }) + '\n' + claudeTool('Bash', { command: 'env' }) + '\n')
    const tracker = new WorkerActivityTracker()
    expect(tracker.poll(file, 'claude', wt)?.label).toBe('running npx vitest')
    fs.appendFileSync(file, claudeTool('Bash', { command: 'pwd' }) + '\n')
    expect(tracker.poll(file, 'claude', wt)?.label).toBe('running npx vitest')
  })
  it('names room and other tools without their arguments', () => {
    expect(activityFromEvent(claudeTool('mcp__plugin_room_room__room_claim', { intent: SECRET }), 'claude', wt)).toBe('room_claim')
    expect(activityFromEvent(claudeTool('TodoWrite', { todos: [SECRET] }), 'claude', wt)).toBe('using TodoWrite')
  })
  it('never returns assistant text, thinking or tool results', () => {
    expect(activityFromEvent(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: SECRET }, { type: 'thinking', thinking: SECRET }] } }), 'claude', wt)).toBeUndefined()
    expect(activityFromEvent(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: SECRET }] } }), 'claude', wt)).toBeUndefined()
    expect(activityFromEvent(JSON.stringify({ type: 'result', result: SECRET }), 'claude', wt)).toBeUndefined()
  })
  it('takes the last tool_use of a message', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: `${wt}/a.ts` } }, { type: 'text', text: SECRET }, { type: 'tool_use', name: 'Edit', input: { file_path: `${wt}/b.ts` } }] } })
    expect(activityFromEvent(line, 'claude', wt)).toBe('editing b.ts')
  })
})

describe('activityFromEvent (Codex exec --json)', () => {
  it('labels file changes, commands and MCP calls', () => {
    expect(activityFromEvent(codexItem({ type: 'file_change', changes: [{ path: `${wt}/api/tax.py`, kind: 'update' }, { path: `${wt}/b.py`, kind: 'add' }], status: 'in_progress' }), 'codex', wt)).toBe('editing api/tax.py (+1 more)')
    expect(activityFromEvent(codexItem({ type: 'command_execution', command: `/bin/zsh -lc 'npm test -- --key ${SECRET}'`, aggregated_output: '', status: 'in_progress' }), 'codex', wt)).toBe('running npm test')
    expect(activityFromEvent(codexItem({ type: 'command_execution', command: `/bin/bash -lc "cat ${wt}/secret.txt"`, aggregated_output: SECRET, exit_code: 0 }, 'item.completed'), 'codex', wt)).toBe('running cat')
    expect(activityFromEvent(codexItem({ type: 'mcp_tool_call', server: 'room', tool: 'room_scope', arguments: { summary: SECRET } }), 'codex', wt)).toBe('room_scope')
    expect(activityFromEvent(codexItem({ type: 'web_search', query: SECRET }), 'codex', wt)).toBe('searching the web')
  })
  it('applies the same command rule inside the shell wrapper', () => {
    const run = (command: string) => activityFromEvent(codexItem({ type: 'command_execution', command, status: 'in_progress' }), 'codex', wt)
    expect(run(`/bin/zsh -lc 'claude SecretToken123'`)).toBe('running claude')
    expect(run(`/bin/zsh -lc "API_KEY='alpha ${SECRET} omega' npm test"`)).toBe('running a command')
    expect(run(`/bin/bash -lc "'/opt/x ${SECRET}/bin' y"`)).toBe('running a command')
    expect(run(`/bin/zsh -lc 'git ${SECRET} --all'`)).toBe('running git')
    expect(run(`/bin/zsh -lc 'git diff --stat'`)).toBe('running git diff')
    expect(run(`ssh -c 'aes' ${SECRET}`)).toBe('running ssh')
    expect(run(`claude ${SECRET}`)).toBe('running claude')
  })
  it('never returns agent messages or reasoning', () => {
    expect(activityFromEvent(codexItem({ type: 'agent_message', text: SECRET }, 'item.completed'), 'codex', wt)).toBeUndefined()
    expect(activityFromEvent(codexItem({ type: 'reasoning', text: SECRET }, 'item.completed'), 'codex', wt)).toBeUndefined()
    expect(activityFromEvent(JSON.stringify({ type: 'turn.completed', usage: {} }), 'codex', wt)).toBeUndefined()
  })
})

describe('activityFromEvent: malformed input and bounds', () => {
  it('ignores malformed and non-JSON lines', () => {
    for (const line of ['', 'not json', '{"type":"assistant"', `stderr: ${SECRET}`, 'null', '[]', '{"type":"assistant","message":{"content":"x"}}',
      claudeTool('Edit', { file_path: 42 }), codexItem({ type: 'file_change', changes: 'x' }), codexItem({ type: 'command_execution', command: 7 })])
      for (const host of ['claude', 'codex'] as const) expect(activityFromEvent(line, host, wt)).toBeUndefined()
  })
  it('caps the label and strips control characters', () => {
    const long = `${wt}/${'deep/'.repeat(40)}file.ts`
    const label = activityFromEvent(claudeTool('Edit', { file_path: long }), 'claude', wt)!
    expect(label.length).toBeLessThanOrEqual(ACTIVITY_MAX)
    expect(label).toMatch(/^editing …/)
    expect(label.endsWith('file.ts')).toBe(true)
    expect(activityFromEvent(claudeTool('Read', { file_path: `${wt}/a\u001b[31m\nb.ts` }), 'claude', wt)).toBe('reading a[31mb.ts')
  })
  it('shows a path outside the worktree by its last two segments', () => {
    expect(activityFromEvent(claudeTool('Read', { file_path: '/Users/x/.claude/skills/room/SKILL.md' }), 'claude', wt)).toBe('reading …/room/SKILL.md')
  })
})

describe('WorkerActivityTracker', () => {
  it('reads only bytes appended since the last poll and keeps the latest activity', () => {
    const file = path.join(tmp, 'inc.log')
    fs.writeFileSync(file, claudeTool('Read', { file_path: `${wt}/a.ts` }) + '\n')
    const tracker = new WorkerActivityTracker()
    expect(tracker.poll(file, 'claude', wt, 10_000)?.label).toBe('reading a.ts')
    const read = fs.readSync
    let bytes = 0
    const spy = (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition | null) => { const n = read(fd, buffer, offset, length, position); bytes += n; return n }
    ;(fs as { readSync: unknown }).readSync = spy
    try {
      const text = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: SECRET }] } }) + '\n'
      fs.appendFileSync(file, text)
      // Assistant text is not activity: the earlier label stays.
      expect(tracker.poll(file, 'claude', wt, 20_000)?.label).toBe('reading a.ts')
      expect(bytes).toBe(Buffer.byteLength(text))
      // A partial line waits for its newline.
      const edit = claudeTool('Edit', { file_path: `${wt}/b.ts` })
      fs.appendFileSync(file, edit.slice(0, 20))
      expect(tracker.poll(file, 'claude', wt, 30_000)?.label).toBe('reading a.ts')
      fs.appendFileSync(file, edit.slice(20) + '\n')
      expect(tracker.poll(file, 'claude', wt, 40_000)?.label).toBe('editing b.ts')
    } finally { (fs as { readSync: unknown }).readSync = read }
  })
  it('dates activity by the log write, not by the poll', () => {
    const file = path.join(tmp, 'dated.log')
    fs.writeFileSync(file, claudeTool('Read', { file_path: `${wt}/a.ts` }) + '\n')
    const written = 1_700_000_000_000
    fs.utimesSync(file, written / 1000, written / 1000)
    expect(new WorkerActivityTracker().poll(file, 'claude', wt, written + 20_000)).toEqual({ label: 'reading a.ts', at: written })
  })
  const text = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking aloud' }] } }) + '\n'
  it('does not date a tool event by a later line written in the same poll', () => {
    const file = path.join(tmp, 'aged.log')
    const base = 1_700_000_000_000
    const touch = (at: number) => fs.utimesSync(file, at / 1000, at / 1000)
    fs.writeFileSync(file, JSON.stringify({ type: 'system', subtype: 'init' }) + '\n')
    touch(base)
    const tracker = new WorkerActivityTracker()
    expect(tracker.poll(file, 'claude', wt, base + 10_000)).toBeUndefined()
    // The tool event and newer assistant text arrive between polls: the event is no fresher than the last poll.
    fs.appendFileSync(file, claudeTool('Read', { file_path: `${wt}/a.ts` }) + '\n' + text)
    touch(base + 50_000)
    expect(tracker.poll(file, 'claude', wt, base + 60_000)).toEqual({ label: 'reading a.ts', at: base + 10_000 })
    // More text later does not refresh it.
    fs.appendFileSync(file, text)
    touch(base + 90_000)
    expect(tracker.poll(file, 'claude', wt, base + 100_000)).toEqual({ label: 'reading a.ts', at: base + 10_000 })
    // A tool event that is the last line read takes the log's write time.
    fs.appendFileSync(file, text + claudeTool('Edit', { file_path: `${wt}/b.ts` }) + '\n')
    touch(base + 130_000)
    expect(tracker.poll(file, 'claude', wt, base + 140_000)).toEqual({ label: 'editing b.ts', at: base + 130_000 })
  })
  it('dates an earlier line of a first poll by the run start, and uses an event timestamp when present', () => {
    const file = path.join(tmp, 'first.log')
    // Whole seconds: utimes takes float seconds, which do not round-trip every millisecond.
    const start = Math.floor(Date.now() / 1000) * 1000
    fs.writeFileSync(file, claudeTool('Read', { file_path: `${wt}/a.ts` }) + '\n' + text)
    fs.utimesSync(file, (start + 60_000) / 1000, (start + 60_000) / 1000)
    expect(new WorkerActivityTracker().poll(file, 'claude', wt, start + 120_000, start + 30_000)).toEqual({ label: 'reading a.ts', at: start + 30_000 })
    const stamped = path.join(tmp, 'stamped.log')
    const at = new Date(start + 45_000).toISOString()
    fs.writeFileSync(stamped, JSON.stringify({ type: 'item.started', timestamp: at, item: { type: 'command_execution', command: 'make' } }) + '\n' + JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'x' } }) + '\n')
    fs.utimesSync(stamped, (start + 60_000) / 1000, (start + 60_000) / 1000)
    expect(new WorkerActivityTracker().poll(stamped, 'codex', wt, start + 120_000, start)).toEqual({ label: 'running make', at: start + 45_000 })
    // A timestamp later than the log's last write is clamped to it.
    fs.writeFileSync(stamped, JSON.stringify({ type: 'item.started', timestamp: new Date(start + 600_000).toISOString(), item: { type: 'command_execution', command: 'make' } }) + '\n')
    fs.utimesSync(stamped, (start + 60_000) / 1000, (start + 60_000) / 1000)
    expect(new WorkerActivityTracker().poll(stamped, 'codex', wt, start + 120_000)).toEqual({ label: 'running make', at: start + 60_000 })
  })
  it('reads a bounded tail of a large existing log and restarts after truncation', () => {
    const file = path.join(tmp, 'big.log')
    const filler = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(1000) }] } }) + '\n'
    fs.writeFileSync(file, claudeTool('Read', { file_path: `${wt}/old.ts` }) + '\n' + filler.repeat(600) + claudeTool('Edit', { file_path: `${wt}/new.ts` }) + '\n')
    const tracker = new WorkerActivityTracker({ maxRead: 64 * 1024 })
    expect(tracker.poll(file, 'claude', wt)?.label).toBe('editing new.ts')
    fs.writeFileSync(file, codexItem({ type: 'command_execution', command: "/bin/zsh -lc 'make'" }) + '\n')
    expect(tracker.poll(file, 'codex', wt)?.label).toBe('running make')
  })
  it('returns undefined for a missing or activity-free log', () => {
    const tracker = new WorkerActivityTracker()
    expect(tracker.poll(path.join(tmp, 'absent.log'), 'claude', wt)).toBeUndefined()
    const file = path.join(tmp, 'startup.log')
    fs.writeFileSync(file, JSON.stringify({ type: 'system', subtype: 'init' }) + '\n')
    expect(tracker.poll(file, 'claude', wt)).toBeUndefined()
  })
})

describe('worker log while the host runs', () => {
  it('grows line by line before the host exits, and the tracker sees each step', async () => {
    const script = path.join(tmp, 'fake-host.mjs')
    const lines = [claudeTool('Read', { file_path: `${tmp}/a.ts` }), claudeTool('Edit', { file_path: `${tmp}/b.ts` })]
    fs.writeFileSync(script, `const lines = ${JSON.stringify(lines)}
const sleep = ms => new Promise(r => setTimeout(r, ms))
for (const line of lines) { process.stdout.write(line + '\\n'); await sleep(400) }
await sleep(5000)
`)
    const logFile = path.join(tmp, 'live', 'fake.log')
    const proc = defaultSpawner({ cmd: process.execPath, args: [script], cwd: tmp, env: {}, logFile })
    let exited = false
    proc.onExit(() => { exited = true })
    try {
      await proc.started
      const tracker = new WorkerActivityTracker()
      const until = async (label: string) => {
        const deadline = Date.now() + 4000
        while (Date.now() < deadline && tracker.poll(logFile, 'claude', tmp)?.label !== label) await new Promise(r => setTimeout(r, 50))
        return tracker.poll(logFile, 'claude', tmp)?.label
      }
      expect(await until('reading a.ts')).toBe('reading a.ts')
      expect(exited).toBe(false)
      expect(await until('editing b.ts')).toBe('editing b.ts')
      expect(exited).toBe(false)
      expect(fs.statSync(logFile).size).toBeGreaterThan(0)
    } finally { proc.killForce?.() }
  })
})

describe('workerLine last activity', () => {
  const view: WorkerView = { id: 'w1', tag: 'tax', name: 'ada+tax', lead: 'ada', mode: 'here', host: 'claude', task: 'fix tax', branch: 'room/tax', status: 'running', run: 1, startedAt: 0, fence: 'f' }
  it('adds a third line for a live worker with activity', () => {
    const lines = workerLine({ worker: view, changedCount: 1, now: 60_000, activity: { label: 'editing api/tax.py', at: 40_000 } })
    expect(lines).toHaveLength(3)
    expect(lines[2]).toBe('      editing api/tax.py · 20s ago')
  })
  it('shows nothing extra without activity, or once the worker finished', () => {
    expect(workerLine({ worker: view, changedCount: 1, now: 60_000 })).toHaveLength(2)
    expect(workerLine({ worker: { ...view, status: 'done' }, changedCount: 1, now: 60_000, activity: { label: 'editing a', at: 1 } })).toHaveLength(2)
    expect(workerLine({ worker: view, processGone: true, changedCount: 1, now: 60_000, activity: { label: 'editing a', at: 1 } })).toHaveLength(2)
  })
  it('caps a long label', () => {
    expect(workerLine({ worker: view, changedCount: 0, now: 5_000, activity: { label: 'x'.repeat(300), at: 0 } })[2].length).toBeLessThanOrEqual(6 + 80 + ' · 5s ago'.length)
  })
})
