import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { prepareWorktree } from '../src/worker-git.js'
import { registryForDir } from '../src/worker-registry.js'
import { createTools, realRepo, setupLead } from './workers-fixture.js'
import type { Session } from '../src/session.js'
import { finishFixtureProcess, fixtureProbe, spawnFixtureProcess } from './fixtures/process-liveness.js'

// Keep normal coverage small; use the same test and fixtures for extended,
// pinned-revision comparisons. Never retry a failed preparation in the harness.
const rounds = Math.max(1, Math.min(100, Math.floor(Number(process.env.TEST_PREPARE_ROUNDS) || 2)))
interface Failure { round: number; tag: string; message: string }

it('concurrent real preparations preserve independent clean and carried work', async () => {
  const { repo, git } = realRepo()
  git('config', 'core.filesRefLockTimeout', '100')
  git('config', 'core.packedRefsTimeout', '1000')
  git('pack-refs', '--all')
  fs.writeFileSync(path.join(repo, 'modified.txt'), 'carried tracked work\n')
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'carried untracked work\n')
  const failures: Failure[] = []
  let prepared = 0
  for (const carry of [false, true]) for (let round = 0; round < rounds; round++) {
    const tags = Array.from({ length: 3 }, (_, i) => `prep-${Number(carry)}-${round}-${i}`)
    const results = await Promise.allSettled(tags.map(tag => prepareWorktree(repo, tag, 'rohanz', { carry })))
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') { failures.push({ round, tag: tags[index], message: String(result.reason) }); continue }
      const worktree = result.value
      if (worktree.carryFailed) failures.push({ round, tag: tags[index], message: worktree.carryError ?? 'carry failed without detail' })
      try {
        if (carry && (fs.readFileSync(path.join(worktree.dir, 'modified.txt'), 'utf8') !== 'carried tracked work\n'
          || fs.readFileSync(path.join(worktree.dir, 'untracked.txt'), 'utf8') !== 'carried untracked work\n')) {
          failures.push({ round, tag: tags[index], message: 'carried bytes differ' })
        }
      } catch (error) { failures.push({ round, tag: tags[index], message: `cannot inspect carried output: ${String(error)}` }) }
      prepared++
    }
  }
  process.stdout.write(JSON.stringify({ case: 'concurrent-prepare', rounds, attempted: rounds * 6, prepared, failures }) + '\n')
  expect(failures, JSON.stringify(failures, null, 2)).toEqual([])
  expect(prepared).toBe(rounds * 6)
}, 120_000)

it('concurrent real room_spawn records every refusal and launches exactly its capacity', async () => {
  const { repo, head, git } = realRepo()
  git('config', 'core.filesRefLockTimeout', '100')
  git('config', 'core.packedRefsTimeout', '1000')
  git('pack-refs', '--all')
  const t = setupLead(repo, head), registry = await registryForDir(repo)
  let session: Session | null = t.session
  // The original capacity fixture supplies its own real prepareWorktree callback.
  // Also cover production's default callback, including durable onStep journals.
  const journalled = createTools({
    getSession: () => session, setSession: next => { session = next }, cwd: repo, maxWorkers: 2, probe: fixtureProbe,
    spawner: spec => {
      t.specs.push(spec)
      const pid = 4242 + t.specs.length, callbacks: ((code: number | null) => void)[] = []
      spawnFixtureProcess(pid)
      t.exits.push(code => { finishFixtureProcess(pid); for (const callback of callbacks) callback(code) })
      return { pid, started: Promise.resolve(), onExit: cb => { callbacks.push(cb) }, kill: () => true }
    },
  })
  const failures: Failure[] = []
  let attempted = 0, launched = 0, capacityRefusals = 0
  try {
    for (let round = 0; round < rounds; round++) {
      // Alternate the exact clean capacity-test fixture with production's
      // journalled callback, including tracked carry and untracked pin writes.
      if (round % 2) {
        fs.writeFileSync(path.join(repo, 'modified.txt'), 'carried tracked work\n')
        fs.writeFileSync(path.join(repo, 'untracked.txt'), 'carried untracked work\n')
      } else {
        fs.writeFileSync(path.join(repo, 'modified.txt'), 'before\n')
        fs.rmSync(path.join(repo, 'untracked.txt'), { force: true })
      }
      const tags = ['a', 'b', 'c'].map(tag => `spawn-${round}-${tag}`), before = t.specs.length
      const tools = round % 2 ? journalled : t.leadTools
      attempted += tags.length
      const results = await Promise.allSettled(tags.map(tag => tools.call('room_spawn', { tag, task: 'train' })))
      const replies = results.map(result => result.status === 'fulfilled' ? result.value : `rejected: ${String(result.reason)}`)
      for (const [index, message] of replies.entries()) {
        if (/(^|\n)error: worker capacity reached(?:\n|$)/.test(message)) capacityRefusals++
        else if (!message.split('\n').some(line => line.startsWith(`spawned ${tags[index]}:`))
          || /note: (carry failed|could not carry)/.test(message)) failures.push({ round, tag: tags[index], message })
      }
      const started = t.specs.length - before
      launched += started
      if (started !== 2) failures.push({ round, tag: tags.join(','), message: `launched ${started}/2\n${replies.join('\n---\n')}` })
      for (let i = before; i < t.exits.length; i++) t.exits[i](0)
      try { await vi.waitFor(async () => expect(await registry.occupancy()).toBe(0)) }
      catch (error) { failures.push({ round, tag: tags.join(','), message: `workers did not leave capacity after exit: ${String(error)}` }); break }
    }
  } finally {
    for (const tools of [t.leadTools, journalled]) {
      try { await tools.shutdown() } catch (error) { failures.push({ round: -1, tag: '*', message: `shutdown: ${String(error)}` }) }
    }
  }
  process.stdout.write(JSON.stringify({ case: 'concurrent-spawn', rounds, attempted, launched, capacityRefusals, failures }) + '\n')
  expect(failures, JSON.stringify(failures, null, 2)).toEqual([])
  expect(launched).toBe(rounds * 2)
  expect(capacityRefusals).toBe(rounds)
}, 120_000)
