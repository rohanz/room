import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workerCommand } from '../src/worker-config.js'
import { followUpAnswer, resumeAccepted, unawaitedBackgroundTasks, workerLogTail } from '../src/worker-process.js'

const dir = mkdtempSync(join(tmpdir(), 'room-worker-stream-'))
afterEach(() => rmSync(join(dir, 'run.log'), { force: true }))
const log = (events: object[], stderr = '') => {
  const file = join(dir, 'run.log')
  writeFileSync(file, [...events.map(event => JSON.stringify(event)), stderr].filter(Boolean).join('\n') + '\n')
  return file
}
const sid = 'session-123'
const recorded = (name: string) => join(import.meta.dirname, 'fixtures', 'claude-2.1.283', name)

describe('Claude stream-json worker runs', () => {
  it.each([
    ['resume-missing.jsonl', false],
    ['resume-startup-only.jsonl', false],
    ['resume-accepted.jsonl', true],
    ['resume-other-session.jsonl', false],
  ] as const)('applies the Claude 2.1.283 %s acceptance fixture', (fixture, accepted) => {
    expect(resumeAccepted(recorded(fixture), 'claude', sid, 0)).toBe(accepted)
  })

  it.each([false, true])('passes stream-json and verbose on resume=%s', resume => {
    const args = workerCommand('claude', undefined, 'prompt', undefined, undefined,
      { resume, sessionId: sid }).args
    expect(args).toContain('--output-format')
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json')
    expect(args).toContain('--verbose')
  })

  it('accepts only an assistant event from the retained session after the log start', () => {
    const prefix = JSON.stringify({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: 'old' }] } }) + '\n'
    const file = join(dir, 'run.log')
    writeFileSync(file, prefix + [
      { type: 'system', subtype: 'hook_started', session_id: sid },
      { type: 'system', subtype: 'init', session_id: sid },
      { type: 'assistant', session_id: 'other', message: { content: [{ type: 'text', text: 'wrong' }] } },
      { type: 'result', subtype: 'success', session_id: sid, result: 'done' },
    ].map(event => JSON.stringify(event)).join('\n') + '\n')
    expect(resumeAccepted(file, 'claude', sid, prefix.length)).toBe(false)
    writeFileSync(file, JSON.stringify({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: 'accepted' }] } }) + '\n', { flag: 'a' })
    expect(resumeAccepted(file, 'claude', sid, prefix.length)).toBe(true)
  })

  it('does not accept a missing session or startup-only log, regardless of exit code', () => {
    const missing = log([{ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, session_id: sid, result: 'No conversation found' }])
    expect(resumeAccepted(missing, 'claude', sid, 0)).toBe(false)
    const startup = log([{ type: 'system', subtype: 'hook_started', session_id: sid }, { type: 'system', subtype: 'init', session_id: sid }])
    expect(resumeAccepted(startup, 'claude', sid, 0)).toBe(false)
  })

  it('uses turn.started with the retained Codex thread, never process startup', () => {
    const file = log([{ type: 'thread.started', thread_id: sid }])
    expect(resumeAccepted(file, 'codex', sid, 0)).toBe(false)
    writeFileSync(file, JSON.stringify({ type: 'turn.started', thread_id: sid }) + '\n', { flag: 'a' })
    expect(resumeAccepted(file, 'codex', sid, 0)).toBe(true)
  })

  it('renders assistant and result text instead of raw events', () => {
    const file = log([
      { type: 'system', subtype: 'init', session_id: sid },
      { type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: 'Working.' }] } },
      { type: 'result', subtype: 'success', session_id: sid, result: 'Finished.' },
    ])
    expect(followUpAnswer(file, 'claude', 0)).toBe('Finished.')
    expect(workerLogTail(file)).toBe('Working.\nFinished.')
    writeFileSync(file, '{"type":"assistant"\n', { flag: 'a' })
    expect(workerLogTail(file)).toBe('Working.\nFinished.')
  })

  // Claude Code 2.1.286 `claude -p --output-format stream-json --verbose` task events, in log order.
  const bg = (id: string) => [
    { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: id, task_type: 'local_bash', description: 'sleep 40; echo done' }] },
    { type: 'system', subtype: 'task_started', task_id: id, tool_use_id: `toolu_${id}`, description: 'sleep 40; echo done', is_backgrounded: true, task_type: 'local_bash' },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${id}` }] }, tool_use_result: { backgroundTaskId: id } },
  ]
  const finished = (id: string, status = 'completed') => [
    { type: 'system', subtype: 'task_updated', task_id: id, patch: { status, end_time: 2 } },
    { type: 'system', subtype: 'task_notification', task_id: id, tool_use_id: `toolu_${id}`, status, output_file: '/tmp/x', summary: 'sleep 40; echo done' },
  ]
  const foreground = (id: string) => [
    { type: 'system', subtype: 'task_started', task_id: id, tool_use_id: `toolu_${id}`, description: 'npm test', task_type: 'local_bash' },
    { type: 'system', subtype: 'task_notification', task_id: id, tool_use_id: `toolu_${id}`, status: 'completed', output_file: '/tmp/y', summary: 'npm test' },
  ]
  const text = { type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: 'started' }] } }
  const end = { type: 'result', subtype: 'success', result: 'started', stop_reason: 'end_turn', session_id: sid }
  const killedAtExit = (id: string) => [
    { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
    { type: 'system', subtype: 'task_updated', task_id: id, patch: { status: 'killed', end_time: 3 } },
    { type: 'system', subtype: 'task_notification', task_id: id, tool_use_id: `toolu_${id}`, status: 'stopped', output_file: '/tmp/x', summary: 'sleep 40; echo done' },
  ]

  it('counts background shell tasks still running when the turn ended', () => {
    expect(unawaitedBackgroundTasks(log([...bg('b4z'), text, end, ...killedAtExit('b4z')]), 0, 'claude')).toBe(1)
    expect(unawaitedBackgroundTasks(log([...bg('a'), ...bg('b'), text, end]), 0, 'claude')).toBe(2)
  })

  it('counts nothing for awaited, stopped, foreground, or absent tasks', () => {
    expect(unawaitedBackgroundTasks(log([...bg('b4z'), ...finished('b4z'), ...foreground('f1'), text, end]), 0, 'claude')).toBe(0)
    expect(unawaitedBackgroundTasks(log([...bg('b4z'), ...finished('b4z', 'killed'), text, end]), 0, 'claude')).toBe(0)
    expect(unawaitedBackgroundTasks(log([...foreground('f1'), { type: 'system', subtype: 'task_started', task_id: 'f2', description: 'npm test', task_type: 'local_bash' }, text, end]), 0, 'claude')).toBe(0)
    expect(unawaitedBackgroundTasks(log([text, end]), 0, 'claude')).toBe(0)
    expect(unawaitedBackgroundTasks(log([{ type: 'system', subtype: 'task_started', task_id: 's', is_backgrounded: true, task_type: 'local_agent' }, text, end]), 0, 'claude')).toBe(0)
    expect(unawaitedBackgroundTasks(join(dir, 'missing.log'), 0, 'claude')).toBe(0)
  })

  it('judges by the last result and counts a task that never terminated', () => {
    // An earlier turn's result does not make a task finished later in the run unawaited.
    expect(unawaitedBackgroundTasks(log([...bg('b'), text, end, ...finished('b'), text, end]), 0, 'claude')).toBe(0)
    expect(unawaitedBackgroundTasks(log([...bg('b'), text]), 0, 'claude')).toBe(1)
  })

  it('reads only this run and never reads Codex logs as task evidence', () => {
    const file = log([...bg('old'), text, end])
    expect(unawaitedBackgroundTasks(file, statSync(file).size, 'claude')).toBe(0)
    expect(unawaitedBackgroundTasks(file, 0, 'codex')).toBe(0)
  })

  it('starts a resumed failure tail at this run, even when the prior done is near the end', () => {
    const prior = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done. marked done' } }) + '\n'
    const file = join(dir, 'run.log')
    writeFileSync(file, prior + JSON.stringify({ type: 'turn.failed', error: { message: 'Current run failed' } }) + '\n')
    expect(workerLogTail(file, Buffer.byteLength(prior))).toBe('Current run failed')
  })
})
