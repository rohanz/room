import { baseVersions } from './shadow-publication-fixture.js'
import './shadow-controlled-fixture.js'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, expect, it, vi, type TestContext } from 'vitest'
import * as Y from 'yjs'
import { gitBlobHash, manifestKey, type ManifestEntry } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import * as disk from '@room/roomd/disk-scan'
import { ConflictShadow, shadowIdle, stopShadow, type ShadowEvent } from '../src/conflict-shadow.js'
import { ShadowGraph } from '../src/shadow-graph.js'
import * as snapshots from '../src/shadow-snapshot.js'
import { registryForDir } from '../src/worker-registry.js'
import { commit, git, put, repo as preparedRepo, world } from './worker-refresh-fixture.js'

type Phase = 'spawn' | 'observe' | 'keep' | 'journal' | 'refresh' | 'retire' | 'leave'
type Kind = 'throw' | 'reject' | 'hang' | 'missing'
type Fault = { phase: Phase; stage: string; kind: Kind }
type Private = {
  graph: ShadowGraph
  now(): number
  closed: boolean
  budget<T>(work: () => Promise<T>, cleanup?: boolean): Promise<T>
  registry: { list(): Promise<unknown> }
  actors: Map<string, { scanned?: number }>
  validateHistory(...args: unknown[]): Promise<void>
  publication(...args: unknown[]): unknown
  readHead(dir: string): Promise<string>
  cleanup?: Promise<void>
}
const proto = ConflictShadow.prototype as unknown as Private
const normalize = (repo: string, value: string) => value.replaceAll(repo, '<repo>').replace(/\b[a-f0-9]{7,64}\b/g, '<oid>').replace(/\bm_[a-z0-9]+\b/g, '<message>')
afterEach(() => vi.restoreAllMocks())

async function pipeline(signal: AbortSignal, fault?: Fault, failAfterSpawn = false, holdFault = false) {
  // Each invocation owns its files, including a replacement baseline after a failed case.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-shadow-fault-')))
  const repo = path.join(root, 'lead')
  fs.cpSync(preparedRepo, repo, { recursive: true })
  const head = git(repo, 'rev-parse', 'HEAD')
  let phase: Phase = 'spawn', shadow: Private | undefined, hit = 0, headReads = 0, baseReads = 0, diskReads = 0, rechecks = 0
  const spies: ReturnType<typeof vi.spyOn>[] = []
  const spyOn: typeof vi.spyOn = (...args: any[]) => {
    const spy = (vi.spyOn as Function)(...args)
    spies.push(spy)
    return spy
  }
  const journalHandles: Awaited<ReturnType<typeof fsp.open>>[] = []
  const replies: Record<string, string> = {}, proofs: Record<string, unknown> = {}
  if (fault) vi.stubEnv('ROOM_CONFLICT_SHADOW', '1')
  let releaseHang: (()=>void)|undefined, hanging=false, verifiedHang=false, reached!:()=>void, diagnostic:Promise<void>|undefined
  const hangReached=new Promise<void>(resolve=>{reached=resolve})
  const t = world({ repo, head }), s = t.leadSession(), actors: { name: string; dir: string; id: string }[] = [{ name: s.me.name, dir: repo, id: '' }]
  // Housekeeping IDs may vary, but input bytes, user history and all lifecycle decisions are identical.
  vi.stubEnv('GIT_AUTHOR_DATE', '2001-02-03T00:00:00Z'); vi.stubEnv('GIT_COMMITTER_DATE', '2001-02-03T00:00:00Z')
  function point<T>(stage: string, work: () => T): T {
    if (!fault || phase !== fault.phase || stage !== fault.stage || hit) return work()
    hit++
    if (holdFault && fault.kind !== 'hang') {
      hanging = true; reached()
      return new Promise<void>(resolve => { releaseHang = () => { hanging = false; resolve() } }).then(() => {
        if (fault.kind === 'throw') throw new Error('injected private failure')
        return Promise.reject(new Error('injected private rejection'))
      }) as T
    }
    if (fault.kind === 'throw') throw new Error('injected private failure')
    if (fault.kind === 'reject') return Promise.reject(new Error('injected private rejection')) as T
    if (fault.kind === 'hang') {
      hanging=true;reached()
      return new Promise<never>((_,reject)=>{releaseHang=()=>{hanging=false;reject(new Error('hang released after operation settled'))}}) as T
    }
    const event = work() as unknown as Extract<ShadowEvent, { kind: 'collection' }>
    expect(event.kind).toBe('collection'); event.workers[0].head = undefined as never
    return event as T
  }
  const enqueue = ConflictShadow.prototype.enqueue
  spyOn(ConflictShadow.prototype, 'enqueue').mockImplementation(function (event, reservation) {
    shadow = this as unknown as Private
    return enqueue.call(this, event && (() => {
      const value = event()
      const stage = value.kind === 'spawn' ? 'spawn closure' : value.kind === 'collection'
        ? fault?.stage === 'collection missing head' ? 'collection missing head' : 'collection closure' : 'refresh closure'
      return point(stage, () => value)
    }), reservation)
  })
  const initialize = ShadowGraph.prototype.init
  spyOn(ShadowGraph.prototype, 'init').mockImplementation(function () { return point('initialization', () => initialize.call(this)) })
  const history = proto.validateHistory
  spyOn(proto, 'validateHistory').mockImplementation(function (...args) { return point('history', () => history.apply(this, args)) })
  const publication = proto.publication
  spyOn(proto, 'publication').mockImplementation(function (...args) { return point('publication', () => publication.apply(this, args)) })
  const readHead = proto.readHead
  spyOn(proto, 'readHead').mockImplementation(function (dir) {
    return point(++headReads === 1 ? 'HEAD before' : 'HEAD after', () => readHead.call(this, dir))
  })
  const capture = snapshots.captureShadow
  spyOn(snapshots, 'captureShadow').mockImplementation((...args) => point('snapshot', async () => {
    const value = await capture(...args), current = value.current
    value.current = () => point(++rechecks === 1 ? 'left byte recheck' : 'right byte recheck', current)
    return value
  }))
  const entries = ShadowGraph.prototype.entries
  spyOn(ShadowGraph.prototype, 'entries').mockImplementation(function (oid) {
    return point(++baseReads === 1 ? 'snapshot base' : 'publication base', () => entries.call(this, oid))
  })
  const readDisk = disk.readDisk
  spyOn(disk, 'readDisk').mockImplementation((...args) => point(++diskReads === 1 ? 'disk read' : 'disk stable check', () => readDisk(...args)))
  const tree = ShadowGraph.prototype.tree
  spyOn(ShadowGraph.prototype, 'tree').mockImplementation(function (...args) { return point('observation tree', () => tree.apply(this, args)) })
  const event = ShadowGraph.prototype.event
  spyOn(ShadowGraph.prototype, 'event').mockImplementation(function (...args) {
    const stage = args[0] === 'delivery' ? 'delivery commit' : args[0] === 'refresh' ? 'refresh commit'
      : args[0] === 'observation' ? 'observation commit' : ''
    return point(stage, () => event.apply(this, args))
  })
  const pin = ShadowGraph.prototype.pin
  spyOn(ShadowGraph.prototype, 'pin').mockImplementation(function (...args) {
    return point(args[1] ? 'observation pin' : 'worker cleanup', () => pin.apply(this, args))
  })
  const command = ShadowGraph.prototype.command
  spyOn(ShadowGraph.prototype, 'command').mockImplementation(function (...args) {
    return point(args[0][0] === 'merge-tree' ? 'merge-tree' : '', () => command.apply(this, args))
  })
  const open = fsp.open
  spyOn(fsp, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (String(args[0]).endsWith('disagreements.jsonl')) {
      journalHandles.push(handle)
      const close = handle.close.bind(handle)
      spyOn(handle, 'close').mockImplementation(() => point('journal close', close))
      const write = handle.write.bind(handle)
      spyOn(handle, 'write').mockImplementation((...parts: unknown[]) => point('journal append', () => (write as Function)(...parts)))
    }
    return handle
  })
  const rm = fsp.rm
  spyOn(fsp, 'rm').mockImplementation((file, options) => String(file) === shadow?.graph.root
    ? point('family cleanup', () => rm(file, options)) : rm(file, options))
  const abort = () => { stopShadow(s); releaseHang?.() }
  signal.addEventListener('abort', abort, { once: true })
  async function owned<T>(work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    const result = await work()
    signal.throwIfAborted()
    return result
  }
  async function operation<T>(name: string, action: () => Promise<T>): Promise<T> {
    const result = await owned(action)
    if (typeof result === 'string') replies[name] = normalize(repo, result)
    if (hanging) {
      // The real lifecycle operation settled while the private fault is STILL pending.
      expect(hanging).toBe(true);verifiedHang=true
      if (fault?.kind === 'hang') stopShadow(s)
      releaseHang!();await diagnostic
    }
    return result
  }
  async function diagnostics() {
    signal.throwIfAborted()
    if(hanging){diagnostic=shadowIdle(s);return}
    if (phase === 'observe' || phase === 'journal') for (const actor of shadow?.actors.values() ?? []) actor.scanned = undefined
    diagnostic=shadowIdle(s)
    if ((fault?.kind === 'hang' || holdFault) && phase === fault?.phase && !verifiedHang) {
      const blocked=await Promise.race([hangReached.then(()=>true),diagnostic.then(()=>false)])
      if (blocked) { expect(hanging).toBe(true); return }
    }
    await diagnostic
    signal.throwIfAborted()
  }
  const versions = baseVersions()
  async function publish(rev: number) {
    const registry = await registryForDir(repo)
    s.room.ensureRoomSalt()
    for (const a of actors) {
      const record = a.id ? await registry.read(a.id) : undefined, base = record?.base ?? git(repo, 'rev-parse', 'HEAD')
      epochPublication(s.room, a.name, base)
      s.room.participants.set(`${a.name}\0id`, { name: a.name, kind: 'agent' })
      s.room.manifestHead.set(a.name, { ...s.room.manifestHead.get(a.name)!, level: 'full', rev, semRev: rev })
      const entries = new Y.Map<ManifestEntry>()
      for (const p of git(a.dir, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(Boolean)) {
        const text = fs.readFileSync(path.join(a.dir, p), 'utf8'), hash = gitBlobHash(text)
        const old = versions(a.dir, base).get(p)
        if (hash !== old) {
          entries.set(p, { change: old ? 'M' : 'A', state: 'shared', hash, at: fs.statSync(path.join(a.dir, p)).mtimeMs, fence: '1' })
          s.room.setOverlay(manifestKey(a.name, '1'), p, text)
        }
      }
      s.room.manifest.set(manifestKey(a.name, '1'), entries)
    }
  }
  try {
    put(repo, 'shared.txt', 'carried draft\n')
    const d = await operation('spawn d', () => t.spawn('d')); actors.push(d); await diagnostics()
    if (failAfterSpawn) throw new Error('deliberate fault-case isolation probe')
    const u = await operation('spawn u', () => t.spawn('u')); actors.push(u); await diagnostics()
    if (fault && fault.phase !== 'spawn') expect([...shadow!.actors.keys()].sort()).toEqual(actors.map(a => a.name).sort())
    spyOn(s.awareness, 'getStates').mockImplementation(() => new Map(actors.map((a, i) =>
      [i, { user: { name: a.name, kind: 'agent' }, sessionId: `session-${a.name}` }])) as never)
    const registry = shadow?.registry
    if (registry) {
      const list = registry.list.bind(registry)
      spyOn(registry, 'list').mockImplementation(() => point('inventory', list))
    }
    phase = 'observe'; headReads = baseReads = diskReads = rechecks = 0
    put(d.dir, 'shared.txt', 'accepted output\n'); put(u.dir, 'shared.txt', 'sibling output\n'); await publish(2); await diagnostics()
    proofs.beforeKeep = { lead: fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8'), index: git(repo, 'show', ':shared.txt') }
    await owned(() => t.finish('d'))
    phase = 'keep'
    expect(await operation('keep', () => t.call('room_collect', { tag: 'd', keep: true }))).toContain('kept d')
    await diagnostics()
    phase = 'journal'; await publish(3)
    // This fixture has no ordinary evaluator. Reach a real journal append through the documented
    // absent-slot window: two conflicting, unchanged observations, sixty stable seconds apart.
    await diagnostics()
    if (shadow) { const later = shadow.now() + 60_001; shadow.now = () => later }
    await diagnostics()
    proofs.kept = { lead: fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8'), worker: fs.readFileSync(path.join(d.dir, 'shared.txt'), 'utf8'), index: git(repo, 'show', ':shared.txt') }
    commit(repo, 'accept output')
    phase = 'refresh'
    expect(await operation('refresh', () => t.call('room_send', { type: 'note', to: d.name, text: 'continue', refresh: true }))).toContain('rebased d')
    await diagnostics()
    proofs.refreshed = { file: fs.readFileSync(path.join(d.dir, 'shared.txt'), 'utf8'), sameHead: git(d.dir, 'rev-parse', 'HEAD') === git(repo, 'rev-parse', 'HEAD'), status: git(d.dir, 'status', '--porcelain') }
    await owned(() => t.finish('d'))
    phase = 'retire'
    await operation('retire', () => t.call('room_collect', { tag: 'd' })); await diagnostics()
    proofs.final = { file: fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8'), index: git(repo, 'show', ':shared.txt'), status: git(repo, 'status', '--porcelain'), workerRemoved: !fs.existsSync(d.dir), launches: [...t.launches].map(([tag, runs]) => [tag, runs.length]) }
    proofs.messages = t.messages().map(m => ({ type: m.type, from: m.from, to: 'to' in m ? m.to : undefined, text: 'text' in m && typeof m.text === 'string' ? normalize(repo, m.text) : undefined }))
    if (fault?.stage === 'journal close') {
      expect(shadow!.closed).toBe(true)
      expect(journalHandles).toHaveLength(1)
      expect(journalHandles.every(handle => handle.fd === -1), 'owned journal handles must be closed after the failure').toBe(true)
    }
    phase = 'leave'; await operation('leave', async () => stopShadow(s))
    await shadow?.cleanup
    if(fault?.kind==='hang'||holdFault&&fault)expect(verifiedHang,'a real operation must settle while its injected private hang is pending').toBe(true)
    if (fault) expect(hit, `${fault.phase}: ${fault.stage} must actually be reached`).toBe(1)
    return { proofs, replies }
  } finally {
    signal.removeEventListener('abort', abort)
    stopShadow(s); releaseHang?.()
    try { await diagnostic; await shadow?.cleanup }
    finally {
      try { await t.close() }
      finally {
        for (const spy of spies.reverse()) spy.mockRestore()
        await fsp.rm(root, { recursive: true, force: true })
      }
    }
  }
}

/** Three representative fault pipelines stay default; the full matrix runs in TEST_SCALE=1. */
export function shadowFailureMatrix(stages: [Phase, string][], missingHead = false, scale = false, defaultKinds?: Kind[]): void {
  const test = scale || defaultKinds ? it : it.skip
  const cases: Fault[] = stages.flatMap(([phase, stage], i) =>
    (defaultKinds ? [defaultKinds[i]] : ['throw', 'reject', 'hang'] as const).map(kind => ({ phase, stage, kind })))
  if (missingHead) cases.push({ phase: 'keep', stage: 'collection missing head', kind: 'missing' })
  let baseline: Awaited<ReturnType<typeof pipeline>> | undefined
  async function run(context: TestContext, fault?: Fault, deliberate = false) {
    const work = pipeline(context.signal, fault, deliberate, !!defaultKinds)
    // A runner timeout aborts the case; finish its owned cleanup before the next case starts.
    context.onTestFinished(async () => { await work.catch(() => {}) }, 120_000)
    return work
  }
  test('records the ordinary spawn → keep → refresh → retire result with the flag unset', async context => {
    baseline = await run(context, undefined, process.env.SHADOW_ISOLATION_PROBE === 'baseline')
  }, 120_000)
  test.for(cases)('isolates $kind at $phase / $stage after the earlier stages have succeeded', async (fault, context) => {
    // A failed baseline never turns unrelated cases into cascading failures.
    baseline ??= await run(context)
    const actual = await run(context, fault, process.env.SHADOW_ISOLATION_PROBE === fault.stage + ':' + fault.kind)
    expect(actual.proofs).toEqual(baseline.proofs)
    expect(actual.replies).toEqual(baseline.replies)
  }, 120_000)
}
