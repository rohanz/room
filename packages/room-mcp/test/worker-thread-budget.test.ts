import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it, expect } from 'vitest'
import { WorkerRegistry } from '../src/worker-registry.js'
import { workerBudget } from '../src/worker-config.js'
import type { WorkerRecord } from '../src/worker-status.js'

it.each([
  [1, 1, 1, 1], [2, 1, 1, 1], [32, 16, 8, 12],
])('releases exited reservations on %i cores; existing budgets stay fixed', async (cores, first, second, third) => {
  const common = fs.mkdtempSync(path.join(os.tmpdir(), 'room-thread-budget-'))
  const token = { pid: 100, startTime: 'born', executable: 'node', sessionId: 'lead', nonce: 'lead' }
  const dead = new Set<number>()
  const registry = await WorkerRegistry.open(common, { watch: false, identity: token,
    liveness: process => dead.has(process.pid) ? 'dead' : 'alive' })
  const spawn = async (tag: string) => {
    const record: WorkerRecord = { v: 1, id: `w_${tag}`, tag, name: `lead+${tag}`, mode: 'local', room: 'local/threads',
      lead: { participant: 'lead', room: 'local/threads', instance: token }, host: 'codex',
      budget: { threads: 1, memGb: 1, nice: 10 }, share: 'declared', task: 'budget test',
      dir: path.join(common, tag), outside: false, branch: `room/${tag}`, prep: { step: 'plan' },
      capabilities: { resume: true, signal: true, collect: 'delta' }, phase: 'intent',
      runs: [{ n: 1, mode: 'fresh', intentAt: Date.now(), nonce: tag, busFrontier: 0, promptMsgIds: [], launcher: token, logStart: 0 }],
      createdAt: Date.now(), seq: 1 }
    await registry.writeIntent(record, 2, live => {
      const budget = workerBudget({ cores, memBytes: 32 * 1024 ** 3, maxWorkers: 2,
        running: live.length, reservedThreads: live.reduce((sum, worker) => sum + worker.budget.threads, 0) })
      return { threads: budget.threads, memGb: budget.memGb, nice: 10 }
    })
    return (await registry.read(record.id))!
  }
  try {
    const one = await spawn('one'), two = await spawn('two')
    expect([one.budget.threads, two.budget.threads]).toEqual([first, second])
    await registry.command(one.id, { type: 'launch', run: 1, nonce: 'one', phase: 'active',
      launch: { outcome: 'launched', pid: 201, process: { pid: 201, startTime: 'worker', executable: 'codex' } } })
    await registry.writeReport(one.id, { run: 1, nonce: 'one', chain: [], joinedAt: Date.now(),
      done: { at: Date.now(), summary: 'finished', changed: [] } })
    // A done report alone cannot free a live host's budget or worker slot.
    await expect(spawn('three')).rejects.toThrow('worker capacity reached')
    dead.add(201)
    await registry.writeExit(one.id, { run: 1, code: 0, at: Date.now(), witnessed: true })
    expect((await spawn('three')).budget.threads).toBe(third)
    expect((await registry.read(two.id))?.budget.threads).toBe(second)
    if (cores === 1) expect(first + second).toBeGreaterThan(cores) // minimum, never a CPU admission refusal
  } finally { registry.close(); fs.rmSync(common, { recursive: true, force: true }) }
})
