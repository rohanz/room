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
    expect(activityFromEvent(claudeTool('Bash', { command: `API_KEY=${SECRET} /usr/bin/curl -H "Authorization: ${SECRET}" https://x` }), 'claude', wt)).toBe('running curl')
    expect(activityFromEvent(claudeTool('Bash', { command: `git status` }), 'claude', wt)).toBe('running git status')
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
  it('reads a bounded tail of a large existing log and restarts after truncation', () => {
    const file = path.join(tmp, 'big.log')
    const filler = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(1000) }] } }) + '\n'
    fs.writeFileSync(file, claudeTool('Read', { file_path: `${wt}/old.ts` }) + '\n' + filler.repeat(600) + claudeTool('Edit', { file_path: `${wt}/new.ts` }) + '\n')
    const tracker = new WorkerActivityTracker({ maxRead: 64 * 1024 })
    expect(tracker.poll(file, 'claude', wt)?.label).toBe('editing new.ts')
    fs.writeFileSync(file, codexItem({ type: 'command_execution', command: "/bin/zsh -lc 'ls'" }) + '\n')
    expect(tracker.poll(file, 'codex', wt)?.label).toBe('running ls')
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
