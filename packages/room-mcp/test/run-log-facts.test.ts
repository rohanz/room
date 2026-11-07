const missingClaudeLogSession = (file: string, id: string, start: number) => { const f = runLogFacts(file, start).get('claude')!; return f.missingSessions.has(id) && !f.acceptedSessions.has(id) }
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearRunLogFactsForTests, runLogFacts, scanRunLog, runLogIdentity } from '../src/run-log-facts.js'
import { retainedSessionMissing } from '../src/hosts/lifecycle.js'
import { followUpAnswer, resumeAccepted } from '../src/worker-process.js'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-run-log-')); clearRunLogFactsForTests() })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })

const line = (event: object) => `${JSON.stringify(event)}\n`
const assistant = (session: string, text: string) => line({ type: 'assistant', session_id: session, message: { content: [{ type: 'text', text }] } })
/** Tool output that is not host JSON: what makes real worker logs large. */
const noise = (bytes: number) => `${'x'.repeat(1023)}\n`.repeat(Math.ceil(bytes / 1024))

it('derives acceptance, missing-session and answer facts over the whole run, not just its tail', () => {
  const file = path.join(dir, 'w.log')
  const earlier = line({ type: 'assistant', session_id: 'S', message: { content: [{ type: 'text', text: 'from the first run' }] } })
  fs.writeFileSync(file, earlier + assistant('S', 'early') + noise(3 * 1024 * 1024) + line({ type: 'result', session_id: 'S', result: ' final ' }))
  const start = Buffer.byteLength(earlier)
  expect(resumeAccepted(file, 'claude', 'S', start)).toBe(true)
  expect(resumeAccepted(file, 'claude', 'other', start)).toBe(false)
  expect(missingClaudeLogSession(file, 'S', start)).toBe(false)
  expect(followUpAnswer(file, 'claude', start)).toBe('final')

  const missing = path.join(dir, 'm.log')
  fs.writeFileSync(missing, line({ type: 'result', session_id: 'S', subtype: 'error_during_execution', is_error: true, num_turns: 0 }))
  expect(missingClaudeLogSession(missing, 'S', 0)).toBe(true)
  expect(resumeAccepted(missing, 'claude', 'S', 0)).toBe(false)

  const codex = path.join(dir, 'c.log')
  fs.writeFileSync(codex, line({ type: 'thread.started', thread_id: 'T' }) + line({ type: 'turn.started' })
    + line({ type: 'item.completed', item: { type: 'agent_message', text: ' codex answer ' } }))
  expect(resumeAccepted(codex, 'codex', 'T', 0)).toBe(true)
  expect(followUpAnswer(codex, 'codex', 0)).toBe('codex answer')
})

it('rereads nothing for an unchanged log and only the appended bytes plus a bounded prefix check after an append', () => {
  const file = path.join(dir, 'w.log')
  fs.writeFileSync(file, assistant('S', 'one') + noise(512 * 1024))
  const reads = vi.spyOn(fs, 'readSync')
  const bytes = () => reads.mock.results.reduce((sum, r) => sum + (r.value as number), 0)
  expect(followUpAnswer(file, 'claude', 0)).toBe('one')
  const first = bytes()
  expect(first).toBeGreaterThanOrEqual(512 * 1024)
  expect(followUpAnswer(file, 'claude', 0)).toBe('one')
  expect(resumeAccepted(file, 'claude', 'S', 0)).toBe(true)
  expect(bytes()).toBe(first)
  const appended = assistant('S', 'two')
  fs.appendFileSync(file, appended)
  expect(followUpAnswer(file, 'claude', 0)).toBe('two')
  // The appended bytes plus the bounded check of the consumed head and tail (4 KB each), not the whole log.
  expect(bytes() - first).toBe(Buffer.byteLength(appended) + 2 * 4096)
})

it('starts over when the log is replaced', () => {
  const file = path.join(dir, 'w.log')
  fs.writeFileSync(file, assistant('S', 'old answer') + noise(4096))
  expect(followUpAnswer(file, 'claude', 0)).toBe('old answer')
  const replacement = path.join(dir, 'next.log')
  fs.writeFileSync(replacement, assistant('R', 'new'))
  fs.renameSync(replacement, file)
  expect(followUpAnswer(file, 'claude', 0)).toBe('new')
  expect(resumeAccepted(file, 'claude', 'S', 0)).toBe(false)
  // Truncated and rewritten in place, shorter than before.
  fs.writeFileSync(file, assistant('Q', 'q'))
  expect(followUpAnswer(file, 'claude', 0)).toBe('q')
  expect(resumeAccepted(file, 'claude', 'R', 0)).toBe(false)
})

it('starts over when the log is rewritten in place with longer content', async () => {
  const file = path.join(dir, 'w.log')
  fs.writeFileSync(file, assistant('old', 'old answer'))
  expect(resumeAccepted(file, 'claude', 'old', 0)).toBe(true)
  const ino = fs.statSync(file).ino
  fs.writeFileSync(file, assistant('new', 'a longer replacement answer') + noise(2048))
  expect(fs.statSync(file).ino).toBe(ino)
  expect(resumeAccepted(file, 'claude', 'old', 0)).toBe(false)
  expect(resumeAccepted(file, 'claude', 'new', 0)).toBe(true)
  // The asynchronous scan applies the same check; same tail, different head.
  const tail = noise(16 * 1024)
  fs.writeFileSync(file, assistant('A', 'a') + tail)
  expect([...(await scanRunLog(file, 0)).get('claude')!.acceptedSessions]).toEqual(['A'])
  fs.writeFileSync(file, assistant('B', 'b') + tail + assistant('B', 'more'))
  expect([...(await scanRunLog(file, 0)).get('claude')!.acceptedSessions]).toEqual(['B'])
})

it('the asynchronous scan yields to the event loop between chunks and fills the cache', async () => {
  const file = path.join(dir, 'w.log')
  fs.writeFileSync(file, assistant('S', 'early') + noise(2 * 1024 * 1024))
  const ran = await (async () => {
    let interleaved = 0
    const pending = scanRunLog(file, 0)
    let done = false
    void pending.then(() => { done = true })
    while (!done) { await new Promise<void>(resolve => setImmediate(resolve)); interleaved++ }
    return { facts: await pending, interleaved }
  })()
  expect(ran.facts.get('claude')!.acceptedSessions.has('S')).toBe(true)
  expect(ran.interleaved).toBeGreaterThan(10)
  const reads = vi.spyOn(fs, 'readSync')
  expect(resumeAccepted(file, 'claude', 'S', 0)).toBe(true)
  expect(reads).not.toHaveBeenCalled()
})

it('an unreadable log yields no evidence', async () => {
  expect(resumeAccepted(path.join(dir, 'missing.log'), 'claude', 'S', 0)).toBe(false)
  expect((await scanRunLog(path.join(dir, 'missing.log'), 0)).get('claude')!.acceptedSessions.size).toBe(0)
})

it('keeps decoder state across partial appends, partitioned by host and run offset', async () => {
  const file = path.join(dir, 'partial.log')
  const announced = line({ type: 'thread.started', thread_id: 'same-id' })
  fs.writeFileSync(file, announced)
  await scanRunLog(file, 0)
  fs.appendFileSync(file, '{"type":"turn.started"')
  expect(resumeAccepted(file, 'codex', 'same-id', 0)).toBe(false)
  fs.appendFileSync(file, '}\n')
  expect(resumeAccepted(file, 'codex', 'same-id', 0)).toBe(true)
  expect(resumeAccepted(file, 'claude', 'same-id', 0)).toBe(false)
  expect(resumeAccepted(file, 'codex', 'same-id', Buffer.byteLength(announced))).toBe(false)
  fs.appendFileSync(file, assistant('same-id', 'model response'))
  expect(resumeAccepted(file, 'claude', 'same-id', 0)).toBe(true)
  expect(followUpAnswer(file, 'codex', 0)).toBe('')
  expect(followUpAnswer(file, 'claude', 0)).toBe('model response')
})

it('resets decoder state after replacement and bounds remembered session ids per host', () => {
  const file = path.join(dir, 'bounded.log')
  fs.writeFileSync(file, line({ type: 'thread.started', thread_id: 'old' }))
  runLogFacts(file, 0)
  const replacement = path.join(dir, 'replace.log')
  fs.writeFileSync(replacement, line({ type: 'turn.started' }))
  fs.renameSync(replacement, file)
  expect(resumeAccepted(file, 'codex', 'old', 0)).toBe(false)
  fs.writeFileSync(file, Array.from({ length: 70 }, (_, i) => assistant(`s${i}`, '')
    + line({ type: 'turn.started', thread_id: `t${i}` })).join(''))
  const facts = runLogFacts(file, 0)
  expect(facts.get('claude')!.acceptedSessions.size).toBe(64)
  expect(facts.get('codex')!.acceptedSessions.size).toBe(64)
  expect(resumeAccepted(file, 'claude', 's69', 0)).toBe(false)
  expect(resumeAccepted(file, 'codex', 't69', 0)).toBe(false)
})

it('warms the exact durable worker/run cache used by status and compatibility accessors', async () => {
  const file = path.join(dir, 'status.log')
  const record = { id: 'w1', dir, host: 'claude' as const, hostSessionId: 'S' }
  const run = { n: 3, mode: 'resume' as const, logStart: 0 }
  const identity = runLogIdentity(record, run)
  fs.writeFileSync(file, assistant('S', 'answer'))
  await scanRunLog(file, 0, identity)
  const reads = vi.spyOn(fs, 'readSync')
  expect(resumeAccepted(file, record.host, 'S', 0, identity)).toBe(true)
  expect(followUpAnswer(file, record.host, 0, identity)).toBe('answer')
  expect(retainedSessionMissing(record, run, file)).toBe(false)
  expect(reads).not.toHaveBeenCalled()
})
