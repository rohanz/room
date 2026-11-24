import './shadow-git-fixture.js'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { manifestKey } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import * as disk from '@room/roomd/disk-scan'
import * as captures from '../src/shadow-snapshot.js'
import { ConflictShadow } from '../src/conflict-shadow.js'
import { registryForDir } from '../src/worker-registry.js'
import { world, repo, git, commit } from './worker-refresh-fixture.js'

class ManualShadow extends ConflictShadow { override enqueue(): void {} }
it.skipIf(process.env.TEST_SCALE !== '1')('measures unchanged observations on the Room source tree', async () => {
  const participants = Number(process.env.SHADOW_PARTICIPANTS ?? '3')
  if (!Number.isInteger(participants) || participants < 2 || participants > 64) throw new Error('invalid fixture participant count')
  // Only fixture hosts are synthetic; this raises admission for nine real Git worktrees.
  vi.stubEnv('ROOM_MAX_WORKERS', String(Math.max(8, participants - 1)))
  const source = git(process.env.SHADOW_STARTUP_SOURCE ?? process.cwd(), 'rev-parse', '--show-toplevel')
  const paths = git(source, 'ls-files', '-z').split('\0').filter(Boolean)
  for (const p of paths) {
    const from = path.join(source, p)
    // Preserve the real tree's size/shape and coverage gaps, including symlinks.
    if (!fs.existsSync(from)) continue
    fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true })
    fs.cpSync(from, path.join(repo, p), { dereference: false })
  }
  commit(repo, 'Room source measurement fixture')
  const t = world(), logs: string[] = [], s = t.leadSession()
  let clock = Date.now()
  const shadow = new ManualShadow(s, line => logs.push(line), () => clock)
  const internal = shadow as any
  const samples: Record<string, unknown>[] = []
  let stages: Record<string, { calls: number; ms: number }> = {}
  let jobs: { stage: string; ms: number }[] = []
  let diskPaths = 0
  const measured = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const start = performance.now()
    try { return await work() } finally {
      const value = stages[name] ??= { calls: 0, ms: 0 }; value.calls++; value.ms += performance.now() - start
    }
  }
  const capture = captures.captureShadow, readDisk = disk.readDisk, command = shadow.graph.command.bind(shadow.graph)
  vi.spyOn(captures, 'captureShadow').mockImplementation((...args) => measured(args[4] ? 'initial capture' : 'observation capture', () => capture(...args)))
  vi.spyOn(disk, 'readDisk').mockImplementation((...args) => {
    diskPaths += args[8]?.paths.length ?? Array.from(args[2]).length
    return measured('disk scan', () => readDisk(...args))
  })
  vi.spyOn(shadow.graph, 'command').mockImplementation((...args) => measured(`private git ${args[0][0]}`, () => command(...args)))
  const compare = vi.spyOn(shadow.graph, 'compare')
  for (const name of ['init', 'event', 'pass', 'headAnchor']) {
    const original = internal[name].bind(shadow)
    vi.spyOn(internal, name).mockImplementation((...args: unknown[]) => measured(name, () => original(...args)))
  }
  const load: ReturnType<typeof spawn>[] = []
  try {
    // Extended measurement mode reveals the full cause after recording the production cutoff.
    if (process.env.SHADOW_STARTUP_UNBOUNDED === '1') {
      Object.defineProperty(shadow.graph, 'deadline', { get: () => Infinity, set: () => {} })
    }
    const budget = internal.budget.bind(shadow)
    vi.spyOn(internal, 'budget').mockImplementation(async (work: unknown, cleanup: unknown) => {
      const start = performance.now()
      try {
        return await (process.env.SHADOW_STARTUP_UNBOUNDED === '1' ? (work as () => Promise<unknown>)() : budget(work, cleanup))
      } finally { if (!cleanup) jobs.push({ stage: internal.stage, ms: performance.now() - start }) }
    })
    await shadow.idle() // same no-worker warmup as the reported session
    stages = {}; jobs = []
    const workers = []
    for (const tag of Array.from({ length: participants - 1 }, (_, n) => `worker-${n + 1}`)) {
      const ticket = shadow.reserve('spawn', shadow.preparation())!
      const worker = await t.spawn(tag)
      const record = (await (await registryForDir(repo)).read(worker.id))!
      ticket.make = () => ({ kind: 'spawn', record, supplied: false, carry: true })
      workers.push(worker)
    }
    const actors = [{ name: s.me.name, dir: repo }, ...workers]
    vi.spyOn(s.awareness, 'getStates').mockImplementation(() => new Map(actors.map((a, i) => [i, { user: { name: a.name, kind: 'agent' }, sessionId: `session-${i}` }])) as never)
    // Synthetic full publications; no host model calls or unrelated live-room writes.
    for (const a of actors) {
      epochPublication(s.room, a.name, git(a.dir, 'rev-parse', 'HEAD'))
      s.room.participants.set(`${a.name}\0id`, { name: a.name, kind: 'agent' })
      s.room.manifestHead.set(a.name, { ...s.room.manifestHead.get(a.name)!, level: 'full' })
      s.room.manifest.set(manifestKey(a.name, s.room.manifestHead.get(a.name)!.fence), new Y.Map())
    }
    if (process.env.SHADOW_STARTUP_LOAD === '1') {
      for (let n = 0; n < 2; n++) {
        const child = spawn(process.execPath, ['-e', 'const end=Date.now()+110000;while(Date.now()<end){Math.sqrt(Math.random())}'], { stdio: 'ignore' })
        load.push(child); await once(child, 'spawn')
      }
    }
    for (let round = 0; round < 3; round++) {
      clock += 6000
      const start = performance.now(), cpu = process.cpuUsage()
      await shadow.idle()
      samples.push({ round, ms: performance.now() - start, cpu: process.cpuUsage(cpu), stages, jobs, diskPaths, actors: internal.actors.size, halted: internal.halted })
      stages = {}; jobs = []; diskPaths = 0
      if (internal.closed || internal.halted) break
      expect(compare).toHaveBeenCalledTimes((round + 1) * participants * (participants - 1) / 2)
    }
    const result = { participants, byteOnly: true, sourceFiles: paths.length, fixtureFiles: git(repo, 'ls-files').split('\n').length, load: load.length, unbounded: process.env.SHADOW_STARTUP_UNBOUNDED === '1', samples, logs }
    console.info('shadow startup measurement', JSON.stringify(result))
    if (process.env.SHADOW_STARTUP_OUTPUT) fs.writeFileSync(process.env.SHADOW_STARTUP_OUTPUT, JSON.stringify(result, null, 2) + '\n')
    expect(samples).not.toHaveLength(0)
    if (process.env.SHADOW_STARTUP_EXPECT_STOP === '1') expect(internal.halted).toBe(true)
    // Whether three participants fit the deadline depends on the machine (about 8.5 s per round on
    // the author's laptop, 18 s on a hosted CI runner). Either outcome is the designed one: every
    // participant followed, or the family stopped once with a reason naming the stage.
    else if (internal.halted) {
      expect(logs.filter(line => line.includes('family stopped for this session'))).toEqual([
        expect.stringMatching(/over budget: private pass deadline exceeded during \S/),
      ])
    } else expect(internal.actors.size).toBe(participants)
  } finally {
    for (const child of load) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue
      const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit
    }
    shadow.stop(); await internal.cleanup
    vi.restoreAllMocks()
  }
}, 450_000)
