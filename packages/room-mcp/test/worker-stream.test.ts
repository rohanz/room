import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workerCommand } from '../src/worker-config.js'
import { followUpAnswer, resumeAccepted, workerLogTail } from '../src/worker-process.js'

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

  it('starts a resumed failure tail at this run, even when the prior done is near the end', () => {
    const prior = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done. marked done' } }) + '\n'
    const file = join(dir, 'run.log')
    writeFileSync(file, prior + JSON.stringify({ type: 'turn.failed', error: { message: 'Current run failed' } }) + '\n')
    expect(workerLogTail(file, Buffer.byteLength(prior))).toBe('Current run failed')
  })
})
