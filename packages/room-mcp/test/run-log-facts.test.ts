import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearRunLogFactsForTests, runLogFacts, scanRunLog } from '../src/run-log-facts.js'
import { followUpAnswer, missingClaudeSession, resumeAccepted } from '../src/worker-process.js'

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
  expect(missingClaudeSession(file, 'S', start)).toBe(false)
  expect(followUpAnswer(file, 'claude', start)).toBe('final')

  const missing = path.join(dir, 'm.log')
  fs.writeFileSync(missing, line({ type: 'result', session_id: 'S', subtype: 'error_during_execution', is_error: true, num_turns: 0 }))
  expect(missingClaudeSession(missing, 'S', 0)).toBe(true)
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
  expect([...(await scanRunLog(file, 0)).assistantSessions]).toEqual(['A'])
  fs.writeFileSync(file, assistant('B', 'b') + tail + assistant('B', 'more'))
  expect([...(await scanRunLog(file, 0)).assistantSessions]).toEqual(['B'])
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
  expect(ran.facts.assistantSessions.has('S')).toBe(true)
  expect(ran.interleaved).toBeGreaterThan(10)
  const reads = vi.spyOn(fs, 'readSync')
  expect(resumeAccepted(file, 'claude', 'S', 0)).toBe(true)
  expect(reads).not.toHaveBeenCalled()
})

it('an unreadable log yields no evidence', async () => {
  expect(resumeAccepted(path.join(dir, 'missing.log'), 'claude', 'S', 0)).toBe(false)
  expect((await scanRunLog(path.join(dir, 'missing.log'), 0)).assistantSessions.size).toBe(0)
})
