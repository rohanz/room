import { createTools, fakeSession, lead, pair, reportDone, dir, base } from './workers-fixture.js'
import { holderFence, participantRecord, type Identity } from '@room/shared'
import { setParticipantBase, hubAppend } from '@room/shared/testing'
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { syntheticSessionId, type Session } from '../src/session.js'
import { publishFixture } from './fixtures/manifest.js'
import { fixtureProbe } from './fixtures/process-liveness.js'
import { finishWorker, registerWorkers } from './registry-fixture.js'

/**
 * A lead with six workers mid-batch, reconstructed from the 2026-11-10 coupled benchmark (control run,
 * lead-0.jsonl): the lead's default room_state was ~8 KB per call and hit the compact cap.
 */
const TAGS = ['types-api', 'lua-cancel', 'lua-deadline', 'worker', 'flows', 'tests-docs'] as const
const task = (tag: string) => `You are worker "${tag}" on a timed team task in BullMQ 6.3.14 (TypeScript + Redis Lua). Implement durable job cancellation with deadlines; `
  + 'read the shared contract in docs/cancellation.md first, keep the public API stable, and report through room_done with the tests you ran. '.repeat(2)
const identity = (tag: string): Identity => ({ name: `rohanz+${tag}`, kind: 'agent', owner: 'rohanz', label: tag })
const workerFiles: Record<string, string[]> = {
  'types-api': ['tests/cancellation_api.test.ts'],
  'lua-cancel': ['src/classes/redis-queue-backend.ts', 'src/commands/includes/moveChildBackToParentDependencies.lua', 'src/commands/moveJobsToWait-8.lua', 'src/commands/reprocessJob-7.lua', 'tests/cancel_scripts.test.ts'],
  'lua-deadline': ['src/classes/redis-queue-backend.ts', 'tests/deadline_scripts.test.ts', ...Array.from({ length: 7 }, (_, i) => `src/commands/deadline-${i}.lua`)],
  worker: ['src/classes/worker.ts', 'tests/worker_cancellation.test.ts'],
  flows: ['tests/flow_cancellation.test.ts'],
  'tests-docs': ['docs/gitbook/guide/jobs/deadlines.md', 'docs/gitbook/guide/workers/cancelling-jobs.md', 'tests/deadlines.test.ts', 'tests/durable_cancellation.test.ts'],
}
// The lead's tree carries what it has integrated from its workers, plus its own edits: 55 files, mostly src/.
const carried = [...new Set(Object.values(workerFiles).flat())]
const leadFiles = [...carried, ...Array.from({ length: 55 - carried.length }, (_, i) => i < 26 ? `src/classes/part-${i}.ts` : `tests/case-${i}.test.ts`)]
const summary = (tag: string) => `${tag}: implemented its slice of durable cancellation, committed it, and ran the focused suites: tsc and eslint clean, 28/28 and 63/63 passing.`

async function scenario() {
  const { a } = pair()
  a.setMeta({ repo: 'x' }); setParticipantBase(a, lead.name, base)
  let ls: Session | null = fakeSession(a, lead, true, dir, base)
  const session = ls!
  const tools = createTools({ getSession: () => ls, setSession: s => { ls = s }, cwd: dir, probe: fixtureProbe })
  for (const path of leadFiles) publishFixture(a, lead.name, path, `// ${path}\n`)
  // Worker views carry the lead's daemon fence; the room accepts them while it matches the lead's holder.
  ;(session.daemon as { fence?: string }).fence = holderFence(participantRecord(a, lead.name)?.holder)
  // Launched workers as the registry records them (spawning itself is covered in workers.test.ts).
  await registerWorkers(session, TAGS.map((tag, i) => ({ tag, name: identity(tag).name, lead: lead.name, host: 'claude' as const, model: 'claude-opus-5-5', effort: 'high',
    task: task(tag), dir: join(dir, '.room', 'workers', tag), branch: `room/${tag}`, base, pid: 5301 + i, startedAt: Date.now(), status: 'running' as const, mode: 'here' as const })))
  for (const tag of TAGS) for (const path of workerFiles[tag]) publishFixture(a, identity(tag).name, path, path === 'src/classes/redis-queue-backend.ts' ? 'x\n'.repeat(2500) : `// ${tag} ${path}\n`)
  // The running workers are present: awareness that names each one's holder session.
  const sessionId = syntheticSessionId({ pid: process.pid, startTime: '', executable: '' })
  const awareness = session.awareness as unknown as { states: Map<number, unknown>; meta: Map<number, { clock: number; lastUpdated: number }> }
  TAGS.forEach((tag, i) => {
    if (tag === 'lua-deadline' || tag === 'worker') return
    awareness.states.set(9000 + i, { user: { ...identity(tag), color: '#000' }, sessionId, status: 'idle', lastActive: Date.now(), host: 'claude', model: 'claude-opus-5-5', effort: 'high' })
    awareness.meta.set(9000 + i, { clock: 1, lastUpdated: Date.now() })
  })
  const lua = identity('lua-cancel').name
  for (const [from, to] of [[1129, 1218], [1463, 1706], [1833, 1886], [2415, 2473]]) a.addClaim({ by: lua, byKind: 'agent', path: 'src/classes/redis-queue-backend.ts', from, to, intent: `cancelled outcome decoding for lines ${from}-${to}, removeOnCancel ARGV` })
  a.doc.getMap('conflicts').set('fixture', { kind: 'merge', owner: lead.name, other: lua, path: 'src/interfaces/queue-backend.ts', status: 'open', inputs: '', factId: 'f', settled: 'conflict', epoch: 1, lines: [453] })
  const revision = (n: string) => `REQUIREMENT REVISION 2 (retry-cancelled-v1): ${n} please resume and implement the follow-up. It replaces the earlier "not supported" wording; keep the public API stable and add tests for retrying cancelled jobs.`
  // Earlier traffic the lead has already read: its own interrupts and the workers' replies to it.
  for (const tag of ['tests-docs', 'flows', 'types-api']) hubAppend(a, lead, { type: 'note', to: identity(tag).name, priority: 'interrupt', text: revision(tag) } as never)
  hubAppend(a, identity('types-api'), { type: 'note', to: lead.name, priority: 'notify', text: 'Ack on revision 2, doing test-only. Two src items for you, since my src is frozen: the Postgres stubs and the widened retry state.' } as never)
  hubAppend(a, lead, { type: 'note', to: lua, priority: 'notify', text: 'Lead: FYI I already widened IQueueBackend.retryFinishedJob state to FinishedStatus in the lead tree; do not redo it.' } as never)
  hubAppend(a, { name: 'room', kind: 'agent' }, { type: 'note', to: lead.name, priority: 'notify', text: `your src/interfaces/queue-backend.ts and ${lua}'s now conflict around line 453; coordinate before editing` } as never)
  for (const tag of ['lua-deadline', 'worker'] as const) {
    hubAppend(a, identity(tag), { type: 'note', priority: 'notify', to: lead.name, text: `done: ${summary(tag)}` } as never)
    await finishWorker(session, tag, { status: 'done', summary: summary(tag) })
  }
  await reportDone('tests-docs', summary('tests-docs')) // reported; its process is still running
  await tools.call('room_state', {}) // the lead reads what it is owed
  // New since that read: a peer's preview in the lead's area and a worker's finish notice to the lead.
  hubAppend(a, identity('types-api'), { type: 'note', priority: 'fyi', paths: ['src/classes/redis-queue-backend.ts'], text: `partial preview with ${lua}: src/classes/redis-queue-backend.ts merges cleanly; tsc clean, cancellation_api 12/12.` } as never)
  hubAppend(a, identity('tests-docs'), { type: 'note', priority: 'notify', to: lead.name, text: `done: ${summary('tests-docs')}` } as never)
  return { a, tools, session }
}

const count = (text: string, part: string) => text.split(part).length - 1

describe('room_state for a lead with workers (2026-11-10 benchmark scenario)', () => {
  it('reports who is here, owed inbox, claims, conflicts and worker state in a compact default reply', async () => {
    const t = await scenario()
    try {
      const out = await t.tools.call('room_state', {})
      if (process.env.SHOW_STATE) process.stdout.write(`room_state default reply: ${Buffer.byteLength(out)} bytes\n${out}\n`)
      // Before this change the same scenario rendered 8153 bytes, at the compact cap, with the last worker line omitted.
      expect(Buffer.byteLength(out)).toBeLessThanOrEqual(4400)
      expect(out).not.toContain('omitted:')
      // Who is here and their status; why each worker record is still live.
      expect(out).toContain('participants overlapping your work (7 active):')
      for (const tag of ['flows', 'lua-cancel', 'types-api']) expect(out).toMatch(new RegExp(`\\n  - rohanz\\+${tag}: no task declared; .* · running\\n`))
      expect(out).toMatch(/\n  - rohanz\+lua-deadline: offline; .* · finished/)
      expect(out).toContain('workers (6):')
      for (const tag of ['lua-deadline', 'worker']) expect(out).toMatch(new RegExp(`\\n  - ${tag} \\(claude claude-opus-5-5 · high, done, uncollected for \\d+s, \\d+m\\)\\n.*${tag}: implemented its slice`))
      expect(out).toMatch(/\n  - tests-docs \(claude claude-opus-5-5 · high, running, \d+m\)\n.*tests-docs: implemented its slice/)
      // Owed inbox, open claims, conflicts.
      expect(out).toMatch(/^\[inbox 1\]\n.*rohanz\+tests-docs → rohanz's agent: done: tests-docs/)
      expect(out).toContain('open claims (4):')
      expect(count(out, 'rohanz+lua-cancel · src/classes/redis-queue-backend.ts:')).toBe(4)
      expect(out).toContain('src/interfaces/queue-backend.ts with rohanz+lua-cancel at lines 453')
      // Daemon lifetime detail only under check=true or while the daemon is unreachable.
      expect(out).not.toContain('local daemon:')
      // Files once, on the participant line.
      expect(count(out, 'tests/flow_cancellation.test.ts')).toBe(1)
      expect(count(out, '55 files, mostly src/classes/')).toBe(1)
      expect(out).not.toContain('uncommitted changes')
      // Recent bus: not the caller's own messages, not delivered ones, not this reply's inbox.
      expect(out).toMatch(/recent bus in your areas, not yet shown to you \(1\):\n  - \[m_\w+\] \[fyi\] rohanz\+types-api: partial preview/)
      expect(out).not.toContain('REQUIREMENT REVISION')
      expect(out).not.toContain('Ack on revision 2')
      expect(count(out, 'done: tests-docs')).toBe(1)
      // An own worker's identity and report are on its worker line, once.
      expect(count(out, 'claude-opus-5-5')).toBe(6)
      expect(count(out, 'lua-deadline: implemented its slice')).toBe(1)

      // Everything the default leaves out stays reachable with all=true.
      const all = await t.tools.call('room_state', { all: true })
      // all=true is the last ten messages of every kind, as before: the newest of the lead's interrupts is among them.
      expect(all).toContain('rohanz\'s agent → rohanz+types-api: REQUIREMENT REVISION 2')
      expect(all).toContain('Ack on revision 2')
      expect(all).toContain('done: tests-docs')
      expect(all).toContain('You are worker "flows" on a timed team task')
      expect(all).toMatch(/\n  - rohanz\+lua-deadline · agent of rohanz · lua-deadline · claude · claude-opus-5-5 · high: done: lua-deadline: implemented its slice of durable cancellation, committed it, and ran the focused suites: tsc and eslint clean, 28\/28 and 63\/63 passing\./)
      expect(all).toMatch(/\n  - rohanz\+flows · agent of rohanz · flows · claude · claude-opus-5-5 · high: .*tests\/flow_cancellation\.test\.ts/)
    } finally { await t.tools.shutdown() }
  })
})
