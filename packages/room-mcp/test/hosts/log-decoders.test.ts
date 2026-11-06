import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createLogDecoder, logDecoderKey } from '../../src/hosts/index.js'
import type { LogContext } from '../../src/hosts/types.js'
import { readBackgroundTasks, scanRunLog } from '../../src/run-log-facts.js'
import { followUpAnswer, hostFailure, unawaitedBackgroundTasks, workerLogTail } from '../../src/worker-process.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const log = (events: (object | string)[]) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-log-decoder-')); dirs.push(dir)
  const file = path.join(dir, 'worker.log')
  fs.writeFileSync(file, events.map(event => typeof event === 'string' ? event : JSON.stringify(event)).join('\n') + '\n')
  return file
}
const context: LogContext = { workerId: 'worker', run: 2, logStart: 100, dir: '/repo', scope: 'whole-run' }

it('isolates cache identities by host, worker, run, directory, offset and scanner scope', () => {
  const key = logDecoderKey('claude', context)
  expect(logDecoderKey('codex', context)).not.toBe(key)
  for (const change of [{ workerId: 'other' }, { run: 3 }, { logStart: 200 }, { dir: '/other' }, { scope: 'activity-window' as const }]) {
    expect(logDecoderKey('claude', { ...context, ...change })).not.toBe(key)
  }
})

it.each(['claude', 'codex'] as const)('%s keeps whole-run evidence out of bounded diagnostics', async host => {
  const file = log(host === 'claude' ? [
    { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'early model text' }] } },
    { type: 'result', is_error: true, result: 'early failure' },
    'x'.repeat(70 * 1024),
  ] : [
    { type: 'turn.started', thread_id: 's' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'early model text' } },
    { type: 'turn.failed', error: { message: 'early failure' } },
    'x'.repeat(70 * 1024),
  ])
  await scanRunLog(file, 0)
  expect(followUpAnswer(file, host, 0)).toBe(host === 'claude' ? 'early failure' : 'early model text')
  expect(hostFailure(file, host, 0)).toBeUndefined()
  expect(workerLogTail(file)).toBe('')
})

it('keeps incomplete background suffix evidence incomplete even after warming the whole run', async () => {
  const file = log([
    { type: 'system', subtype: 'task_started', task_id: 'outside', task_type: 'local_bash', is_backgrounded: true },
    'x'.repeat(16 * 1024 * 1024),
    { type: 'user', tool_use_result: { backgroundTaskId: 'outside' } },
    { type: 'result', result: 'done' },
  ])
  await scanRunLog(file, 0)
  expect(unawaitedBackgroundTasks(file, 0, 'claude')).toBe(0)
  expect(readBackgroundTasks(file, 0, 'codex')).toEqual({ kind: 'unknown' })
  expect(unawaitedBackgroundTasks(file, 0, 'codex')).toBe(0)
})

it('retains host failure precedence, success resets, and historical category carryover', () => {
  const codex = log([
    { type: 'turn.failed', error: { message: 'primary' } },
    { type: 'error', message: 'fallback' },
  ])
  expect(hostFailure(codex, 'codex')).toEqual({ text: 'primary' })
  fs.appendFileSync(codex, JSON.stringify({ type: 'turn.completed' }) + '\n')
  expect(hostFailure(codex, 'codex')).toBeUndefined()
  const claude = log([
    { type: 'assistant', error: 'overloaded', message: { content: [{ type: 'text', text: 'overloaded' }] } },
    { type: 'result', is_error: false },
    { type: 'result', is_error: true, result: 'another failure' },
  ])
  expect(hostFailure(claude, 'claude')).toEqual({ text: 'another failure', transient: 'model capacity' })
})

it.each(['claude', 'codex'] as const)('%s parses activity timestamps only in its activity decoder', host => {
  const decoder = createLogDecoder(host, { ...context, scope: 'activity-window' })
  const event = (timestamp: unknown) => host === 'claude'
    ? { type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/a.ts' } }] } }
    : { type: 'item.started', timestamp, item: { type: 'file_change', changes: [{ path: '/repo/src/a.ts' }] } }
  const label = host === 'claude' ? 'reading src/a.ts' : 'editing src/a.ts'
  for (const timestamp of [1000, '1970-01-01T00:00:01Z']) {
    expect(decoder.push(event(timestamp))).toEqual([{ kind: 'activity', text: label, eventTimeMs: 1000 }])
  }
  for (const timestamp of [undefined, 'invalid', 0, -1, Infinity, NaN]) {
    expect(decoder.push(event(timestamp))).toEqual([{ kind: 'activity', text: label, eventTimeMs: undefined }])
  }
})

it('preserves result precedence and empty-answer fallback without confusing the model tail', () => {
  const file = log([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'assistant' }] } },
    { type: 'result', result: 'preferred' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'later assistant' }] } },
  ])
  expect(followUpAnswer(file, 'claude', 0)).toBe('preferred')
  expect(workerLogTail(file)).toBe('assistant\npreferred\nlater assistant')
  fs.appendFileSync(file, JSON.stringify({ type: 'result', result: '  ' }) + '\n')
  expect(followUpAnswer(file, 'claude', 0)).toBe('later assistant')
})
