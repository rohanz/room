import { afterAll, describe, expect, it } from 'vitest'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostFailure, hostFailureLine } from '../src/worker-process.js'

const dir = mkdtempSync(join(tmpdir(), 'room-worker-failure-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const fixture = (name: string) => join(import.meta.dirname, 'fixtures', name)
let n = 0
const log = (lines: (object | string)[]) => {
  const file = join(dir, `run-${++n}.log`)
  writeFileSync(file, lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n')
  return file
}
const CAPACITY = 'Selected model is at capacity. Please try a different model.'

describe('hostFailure', () => {
  // Trimmed from a real `codex exec --json` worker log (rehearsal 2026-10-02, issue5.log): stderr banner first.
  it('prefers Codex turn.failed over the stderr banner and flags model capacity as transient', () => {
    const file = fixture('codex-exec/model-capacity.jsonl')
    expect(readFileSync(file, 'utf8').split('\n')[0]).toBe('Reading additional input from stdin...')
    expect(hostFailure(file, 'codex')).toEqual({ text: CAPACITY, transient: 'model capacity' })
  })

  it('takes a Codex error event when no turn.failed follows, and ignores a failed tool call', () => {
    const file = log(['Reading additional input from stdin...',
      { type: 'item.completed', item: { type: 'mcp_tool_call', error: { message: 'tool exploded' }, status: 'failed' } },
      { type: 'error', message: 'stream disconnected before completion: rate limit exceeded (429)' }])
    expect(hostFailure(file, 'codex')).toEqual({ text: 'stream disconnected before completion: rate limit exceeded (429)', transient: 'rate limit' })
    expect(hostFailure(log(['Reading additional input from stdin...',
      { type: 'item.completed', item: { type: 'mcp_tool_call', error: { message: 'tool exploded' } } }]), 'codex')).toBeUndefined()
  })

  // Recorded: `claude -p --output-format stream-json --verbose --model claude-nonexistent-0 hi` on Claude Code 2.1.287.
  it('reads the error result of a real Claude 2.1.287 run, which is not transient', () => {
    expect(hostFailure(fixture('claude-2.1.287/model-not-found.jsonl'), 'claude')).toEqual({
      text: "There's an issue with the selected model (claude-nonexistent-0). It may not exist or you may not have access to it. Run --model to pick a different model.",
    })
  })

  // Constructed from the documented shapes (headless.md api_retry, agent-sdk SDKResultMessage, errors.md 529 text).
  it('flags a Claude 529 overload as transient model capacity', () => {
    expect(hostFailure(fixture('claude-2.1.287/overloaded.constructed.jsonl'), 'claude')).toEqual({
      text: expect.stringMatching(/^API Error: Repeated 529 Overloaded errors\./), transient: 'model capacity',
    })
  })

  it('flags a Claude 429 throttle as a rate limit, but not a spend limit', () => {
    const throttle = log([{ type: 'assistant', error: 'rate_limit', is_api_error_message: true, message: { content: [{ type: 'text', text: 'Server is temporarily limiting requests' }] } },
      { type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'Server is temporarily limiting requests' }])
    expect(hostFailure(throttle, 'claude')).toEqual({ text: 'Server is temporarily limiting requests', transient: 'rate limit' })
    const spend = log([{ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: "You've hit your monthly spend limit" }])
    expect(hostFailure(spend, 'claude')).toEqual({ text: "You've hit your monthly spend limit" })
  })

  it('names a Claude error subtype by its errors, or by the subtype when there are none', () => {
    expect(hostFailure(log([{ type: 'result', subtype: 'error_max_budget_usd', is_error: true, errors: ['Reached maximum budget ($5)'] }]), 'claude'))
      .toEqual({ text: 'Reached maximum budget ($5)' })
    expect(hostFailure(log([{ type: 'result', subtype: 'error_max_turns', is_error: true, errors: [] }]), 'claude'))
      .toEqual({ text: 'error_max_turns' })
  })

  it('falls back to an API error assistant message when the run ended before its result', () => {
    const file = log([{ type: 'assistant', error: 'overloaded', is_api_error_message: true, message: { content: [{ type: 'text', text: 'Opus is experiencing high load' }] } }])
    expect(hostFailure(file, 'claude')).toEqual({ text: 'Opus is experiencing high load', transient: 'model capacity' })
  })

  it('returns nothing for a successful result, a stderr-only log or a missing log', () => {
    expect(hostFailure(log([{ type: 'result', subtype: 'success', is_error: false, result: 'done' }]), 'claude')).toBeUndefined()
    expect(hostFailure(log(['Error: spawn codex ENOENT']), 'codex')).toBeUndefined()
    expect(hostFailure(join(dir, 'missing.log'), 'codex')).toBeUndefined()
  })

  it("reads only the current run, and finds the error at the end of a large log", () => {
    const earlier = JSON.stringify({ type: 'turn.failed', error: { message: 'old failure' } }) + '\n'
    const file = log([])
    writeFileSync(file, earlier + 'x'.repeat(2 * 1024 * 1024) + '\n' + JSON.stringify({ type: 'turn.completed' }) + '\n')
    expect(hostFailure(file, 'codex', earlier.length)).toBeUndefined()
    writeFileSync(file, JSON.stringify({ type: 'turn.failed', error: { message: CAPACITY } }) + '\n', { flag: 'a' })
    expect(hostFailure(file, 'codex', earlier.length)).toEqual({ text: CAPACITY, transient: 'model capacity' })
    const copy = join(dir, 'copy.log'); copyFileSync(fixture('codex-exec/model-capacity.jsonl'), copy)
    expect(hostFailure(copy, 'codex', readFileSync(copy).length)).toBeUndefined()
  })
})

describe('hostFailureLine', () => {
  it('says a transient failure can be retried, by resume where the session is kept', () => {
    expect(hostFailureLine({ text: CAPACITY, transient: 'model capacity' }, 'codex', false))
      .toBe(`codex: ${CAPACITY} (transient model capacity: respawn it with dir= its worktree to retry and keep its edits)`)
    expect(hostFailureLine({ text: 'Server is temporarily limiting requests', transient: 'rate limit' }, 'claude', true))
      .toBe('claude: Server is temporarily limiting requests (transient rate limit: room_send it to resume, or respawn it, to retry)')
  })

  it('reports a permanent error as is, on one line and bounded', () => {
    expect(hostFailureLine({ text: 'bad\n  model' }, 'claude', true)).toBe('claude: bad model')
    expect(hostFailureLine({ text: 'x'.repeat(1000) }, 'codex', false).length).toBeLessThanOrEqual(320)
  })
})
