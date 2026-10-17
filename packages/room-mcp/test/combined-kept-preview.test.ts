import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { RoomDoc, manifestHeadOf } from '@room/shared'
import type { Session } from '../src/session.js'
import type { HandlerState } from '../src/tools/context.js'
import { buildCombinedTree } from '../src/tools/combined-tree.js'
import { handlers as collectHandlers } from '../src/tools/collect.js'
import { closeRegistryForDir, localWorkers } from '../src/worker-registry.js'
import { registerWorkers } from './registry-fixture.js'
import { deleteFixture, publishFixture } from './fixtures/manifest.js'
import { prepareWorktree } from '../src/worker-git.js'
import { acknowledgeKeptPublication } from '../src/kept-publication.js'
import { clearFixtureProcesses, fixtureLiveness } from './fixtures/process-liveness.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'

vi.mock('../src/leases.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/leases.js')>()
  return { ...actual, liveness: (identity: Parameters<typeof actual.liveness>[0]) => fixtureLiveness(identity, actual.liveness) }
})
vi.mock('../src/tools/claims.js', () => ({ releaseClaimsOnDone: vi.fn() }))

const tags = ['api', 'backend', 'consumer']
const names = ['lead', ...tags.map(tag => `lead+${tag}`)]
const permutations = <T,>(values: T[]): T[][] => values.length ? values.flatMap((value, index) =>
  permutations(values.filter((_, i) => i !== index)).map(rest => [value, ...rest])) : [[]]
const cases = names.flatMap(caller => permutations(names.filter(name => name !== caller)).map(people => ({ caller, people })))
const roots: string[] = [], rooms: RoomDoc[] = []
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
const put = (dir: string, file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text) }
const source = (tag: string, round: number, leadNote = false) => [leadNote ? '// independent lead note' : `// ${tag} header`, '', '// stable preface', '',
  `export const ${tag}Version = ${round};`, '', round >= 2 ? `// ${tag} own round-${round} note` : '// worker note slot', '', '// stable footer', ''].join('\n')
const testText = (tag: string, round: number) => `// ${tag} test round ${round}\nexport const expected = ${round};\n`
const sharedText = (...edits: [number, string][]) => {
  const slots = Array.from({ length: 12 }, (_, i) => `slot${i + 1}`)
  for (const [line, text] of edits) slots[line - 1] = text
  return slots.join('\n') + '\n'
}

afterEach(async () => {
  for (const root of roots.splice(0)) { await closeRegistryForDir(root); fs.rmSync(root, { recursive: true, force: true }) }
  for (const room of rooms.splice(0)) room.doc.destroy()
  clearFixtureProcesses()
})

async function fixture(options: boolean | { shared?: 'disjoint' | 'repeated'; leadEdit?: 'revision' | 'removal' | 'conflict'; keeps?: number; removeTest?: boolean } = false) {
  const opts = typeof options === 'boolean' ? {} : options
  const genuineConflict = options === true
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-kept-preview-')))
  roots.push(root)
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Lead'); git(root, 'config', 'user.email', 'lead@example.test')
  put(root, '.gitignore', '.room/\n')
  for (const tag of tags) put(root, `src/${tag}.ts`, source(tag, 0))
  if (opts.shared) put(root, 'shared.txt', opts.shared === 'repeated' ? 'c\nc\na\nc\n' : sharedText())
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'base')
  const base = git(root, 'rev-parse', 'HEAD')
  const room = new RoomDoc(); rooms.push(room); room.setMeta({ base, branch: 'main', repo: 'test' })
  const session = (name: string, dir: string) => ({ ...hubSeam(room), policyStore: testPolicyStore(), dir, me: { name, kind: 'agent' }, room,
    local: {}, roomName: 'local/test', awareness: { getStates: () => new Map() }, daemon: { touch() {} } } as unknown as Session)
  const lead = session('lead', root)
  lead.daemon.fence = '1'
  lead.daemon.reconcileGitChanges = async () => {
    const head = git(root, 'rev-parse', 'HEAD')
    const paths = new Set([...git(root, 'diff', '--name-only', '-z', head).split('\0'), ...git(root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0')].filter(Boolean))
    for (const file of paths) {
      if (fs.existsSync(path.join(root, file))) publishFixture(room, 'lead', file, fs.readFileSync(path.join(root, file), 'utf8'), { base: head })
      else deleteFixture(room, 'lead', file, { base: head })
    }
    const published = room.participants.get('lead\0git')!
    room.participants.set('lead\0git', { ...published, head })
  }
  lead.daemon.settle = async () => {}
  const sessions = new Map([['lead', lead]])
  for (const tag of tags) {
    const dir = path.join(root, '.room', 'workers', tag)
    git(root, 'worktree', 'add', '-qb', `room/${tag}`, dir)
    sessions.set(`lead+${tag}`, session(`lead+${tag}`, dir))
    put(dir, `src/${tag}.ts`, source(tag, 1)); put(dir, `tests/${tag}.test.ts`, testText(tag, 1))
    if (opts.shared && tag !== 'consumer') put(dir, 'shared.txt', opts.shared === 'repeated'
      ? tag === 'api' ? 'b\nc\nc\nc\na\nc\n' : 'c\nc\na\na\nc\n'
      : tag === 'api' ? sharedText([1, 'A1']) : sharedText([5, 'B1']))
  }
  await registerWorkers(lead, tags.map(tag => ({ tag, name: `lead+${tag}`, lead: 'lead', dir: sessions.get(`lead+${tag}`)!.dir,
    branch: `room/${tag}`, status: 'done', exitCode: 0, base, host: 'codex', task: tag, pid: 0, startedAt: 1 })))
  const stateFor = (caller: Session) => ({ S: () => caller,
    rooms: { all: () => [caller], holding: () => caller, holdingWorker: () => caller, reserve: () => true, unreserve() {},
      autoRetire: async () => {}, project: async () => {}, hasHandle: () => false, tracking: () => true },
    myWorkers: () => localWorkers(caller.dir), workerAlive: () => false, now: Date.now,
    baseFor: (_s: Session, person: string) => manifestHeadOf(room, person)?.base ?? base,
    ctx: { probe: () => undefined, listCwdProcesses: () => [] }, shareOf: () => 'full',
  } as unknown as HandlerState)
  // Exercise the real keep operation: each private snapshot contains its own
  // round-1 source/new test and the unchanged original files of its siblings.
  expect(await collectHandlers(stateFor(lead)).room_collect({ keep: true })).toContain('kept api')
  for (let round = 2; round <= (opts.keeps ?? 1); round++) {
    for (const tag of tags) {
      const dir = sessions.get(`lead+${tag}`)!.dir
      put(dir, `src/${tag}.ts`, source(tag, round)); put(dir, `tests/${tag}.test.ts`, testText(tag, round))
    }
    expect(await collectHandlers(stateFor(lead)).room_collect({ keep: true })).toContain('kept api')
  }
  const kept = new Map(localWorkers(root).map(worker => [worker.name, worker.base!]))
  put(root, 'docs/NOTES.md', 'docs-only lead commit\n')
  git(root, 'add', '--', 'docs/NOTES.md'); git(root, 'commit', '-qm', 'docs only')
  const round = (opts.keeps ?? 1) + 1
  put(root, 'src/api.ts', source('api', genuineConflict ? 99 : round - 1, true))
  // Pin the reviewer's repeated-line lead input; first-round Git alignment
  // itself need not produce this tree from the two round-1 snapshots.
  if (opts.shared === 'repeated') put(root, 'shared.txt', 'b\nc\nc\nc\na\na\nc\n')
  if (opts.shared === 'disjoint') {
    if (opts.leadEdit === 'removal') fs.rmSync(path.join(root, 'shared.txt'))
    else put(root, 'shared.txt', sharedText([1, 'A1'], [5, opts.leadEdit === 'revision' ? 'lead B revision' : opts.leadEdit === 'conflict' ? 'lead B conflict' : 'B1'], [11, 'independent lead shared note']))
    if (opts.leadEdit === 'revision' || opts.leadEdit === 'removal') {
      git(root, 'add', '--', 'shared.txt'); git(root, 'commit', '-qm', 'lead edits delivered content')
    }
  }
  for (const tag of tags) {
    const name = `lead+${tag}`, dir = sessions.get(name)!.dir
    put(dir, `src/${tag}.ts`, source(tag, round)); put(dir, `tests/${tag}.test.ts`, testText(tag, round))
    if (opts.removeTest && tag === 'backend') fs.rmSync(path.join(dir, `tests/${tag}.test.ts`))
    if (opts.shared && tag !== 'consumer' && opts.leadEdit !== 'removal') put(dir, 'shared.txt', opts.shared === 'repeated'
      ? tag === 'api' ? 'b\nc\nc\nc\na\na\nc\n' : 'c\nc\na\nc\n'
      : tag === 'api' ? sharedText([3, 'A2'])
        : opts.leadEdit === 'revision' ? sharedText([5, 'B1'], [7, 'B2 elsewhere']) : sharedText([5, 'B2']))
    for (const file of [`src/${tag}.ts`, `tests/${tag}.test.ts`, ...(opts.shared && tag !== 'consumer' ? ['shared.txt'] : [])]) {
      if (fs.existsSync(path.join(dir, file))) publishFixture(room, name, file, fs.readFileSync(path.join(dir, file), 'utf8'), { base: kept.get(name)! })
      else deleteFixture(room, name, file, { base: kept.get(name)! })
    }
  }
  for (const tag of tags) for (const file of [`src/${tag}.ts`, `tests/${tag}.test.ts`]) {
    publishFixture(room, 'lead', file, fs.readFileSync(path.join(root, file), 'utf8'), { base: git(root, 'rev-parse', 'HEAD') })
  }
  if (opts.shared) {
    if (fs.existsSync(path.join(root, 'shared.txt'))) publishFixture(room, 'lead', 'shared.txt', fs.readFileSync(path.join(root, 'shared.txt'), 'utf8'), { base: git(root, 'rev-parse', 'HEAD') })
    else deleteFixture(room, 'lead', 'shared.txt', { base: git(root, 'rev-parse', 'HEAD') })
  }
  room.participants.set('lead\0git', { ...room.participants.get('lead\0git')!, head: git(root, 'rev-parse', 'HEAD') })
  const expected = new Map<string, string | null>(tags.flatMap(tag => [[`src/${tag}.ts`, source(tag, round, tag === 'api')],
    [`tests/${tag}.test.ts`, opts.removeTest && tag === 'backend' ? null : testText(tag, round)]]))
  expected.set('docs/NOTES.md', 'docs-only lead commit\n')
  if (opts.shared) expected.set('shared.txt', opts.shared === 'repeated' ? 'b\nc\nc\nc\na\na\nc\n'
    : opts.leadEdit === 'removal' ? null : opts.leadEdit === 'revision'
      ? sharedText([3, 'A2'], [5, 'lead B revision'], [7, 'B2 elsewhere'], [11, 'independent lead shared note'])
      : sharedText([3, 'A2'], [5, 'B2'], [11, 'independent lead shared note']))
  const snapshot = () => Object.fromEntries([...sessions].map(([name, s]) => [name, {
    head: git(s.dir, 'rev-parse', 'HEAD'), index: git(s.dir, 'write-tree'), status: git(s.dir, 'status', '--porcelain'),
    files: Object.fromEntries([...expected.keys()].map(file => [file, fs.existsSync(path.join(s.dir, file)) ? fs.readFileSync(path.join(s.dir, file), 'utf8') : null])),
  }]))
  return { root, room, sessions, stateFor, expected, snapshot, registry: await import('../src/worker-registry.js').then(module => module.registryForDir(root)), preview: (caller: string, people: string[]) => {
    const s = sessions.get(caller)!
    // As in live Room, sibling/lead text is shared in the caller's session;
    // only the lead can read its own workers directly from their worktrees.
    return buildCombinedTree(stateFor(s), s, people.map(person => ({ person, session: s })))
  } }
}

type PreviewFixture = Awaited<ReturnType<typeof fixture>>

/** Only read-only permutation groups share a fixture. Setup stays in the first
 * test body; mutation/provenance cases below keep independent lifecycles. */
function sharedFixture(options: Parameters<typeof fixture>[0], prepare?: (t: PreviewFixture) => void) {
  let pending: Promise<{ t: PreviewFixture; before: ReturnType<PreviewFixture['snapshot']> }> | undefined
  let owned: PreviewFixture | undefined
  afterAll(async () => {
    if (!owned) return
    try { await closeRegistryForDir(owned.root) }
    finally { fs.rmSync(owned.root, { recursive: true, force: true }); owned.room.doc.destroy() }
  })
  return () => pending ??= (async () => {
    const t = await fixture(options)
    prepare?.(t)
    const before = t.snapshot()
    // Transfer successful setup out of per-test cleanup. Failed setup still uses it.
    roots.splice(roots.indexOf(t.root), 1); rooms.splice(rooms.indexOf(t.room), 1)
    owned = t
    return { t, before }
  })()
}

function gitOracle(t: PreviewFixture) {
  // Independent Git oracle: use actual registry collection order and each
  // worker's saved baseline, without calling the preview merge implementation.
  const scratch = path.join(t.root, '.room', 'oracle'); fs.mkdirSync(scratch)
  let folded = fs.readFileSync(path.join(t.root, 'shared.txt'), 'utf8')
  const ordered = localWorkers(t.root).sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0) || a.tag.localeCompare(b.tag))
  for (const worker of ordered) {
    const base = execFileSync('git', ['-C', t.root, 'show', `${worker.base}:shared.txt`], { encoding: 'utf8' })
    fs.writeFileSync(path.join(scratch, 'base'), base); fs.writeFileSync(path.join(scratch, 'ours'), folded)
    fs.writeFileSync(path.join(scratch, 'theirs'), fs.readFileSync(path.join(worker.dir, 'shared.txt')))
    folded = execFileSync('git', ['merge-file', '-p', '--diff3', 'ours', 'base', 'theirs'], { cwd: scratch, encoding: 'utf8' })
  }
  t.expected.set('shared.txt', folded)
}

describe('round-2 permutations', () => {
  const get = sharedFixture(false)
  it.each(cases)('attempt3 kept round-2 preview from $caller with $people preserves all changes', async ({ caller, people }) => {
    const { t, before } = await get()
    const result = await t.preview(caller, people)
    expect(result.complete, result.out.join('\n')).toBe(true)
    expect(result.conflictingPaths.size, result.out.join('\n')).toBe(0)
    expect(result.merged).toEqual(t.expected)
    expect(t.snapshot()).toEqual(before)
  })
})

describe('genuine conflict callers', () => {
  const get = sharedFixture(true)
  it.each(names)('attempt3 genuine lead/worker edit conflict stays visible from %s', async caller => {
    const { t, before } = await get()
    const result = await t.preview(caller, names.filter(name => name !== caller))
    expect(result.conflictingPaths.has('src/api.ts'), result.out.join('\n')).toBe(true)
    expect(t.snapshot()).toEqual(before)
  })
})

describe('disjoint and revert permutations', () => {
  const get = sharedFixture({ shared: 'disjoint' })
  it.each(cases)('same-file disjoint kept hunks and deliberate revert from $caller with $people', async ({ caller, people }) => {
    const { t, before } = await get()
    const result = await t.preview(caller, people)
    expect(result.complete, result.out.join('\n')).toBe(true)
    expect(result.conflictingPaths.size, result.out.join('\n')).toBe(0)
    expect(result.merged).toEqual(t.expected)
    expect(t.snapshot()).toEqual(before)
  })
})

describe('lead revision callers', () => {
  const get = sharedFixture({ shared: 'disjoint', leadEdit: 'revision' })
  it.each(names)('keeps a committed lead revision while the worker edits elsewhere from %s', async caller => {
    const { t, before } = await get()
    const result = await t.preview(caller, names.filter(name => name !== caller))
    expect(result.complete, result.out.join('\n')).toBe(true)
    expect(result.conflictingPaths.size, result.out.join('\n')).toBe(0)
    expect(result.merged).toEqual(t.expected)
    expect(t.snapshot()).toEqual(before)
  })
})

describe('lead removal callers', () => {
  const get = sharedFixture({ shared: 'disjoint', leadEdit: 'removal' })
  it.each(names)('keeps a committed lead removal when every worker left that content alone from %s', async caller => {
    const { t, before } = await get()
    const result = await t.preview(caller, names.filter(name => name !== caller))
    expect(result.complete, result.out.join('\n')).toBe(true)
    expect(result.conflictingPaths.size, result.out.join('\n')).toBe(0)
    expect(result.merged).toEqual(t.expected)
    expect(t.snapshot()).toEqual(before)
  })
})

describe('delivered conflict callers', () => {
  const get = sharedFixture({ shared: 'disjoint', leadEdit: 'conflict' })
  it.each(names)('keeps a genuine conflict on different delivered same-file versions from %s', async caller => {
    const { t, before } = await get()
    const result = await t.preview(caller, names.filter(name => name !== caller))
    expect(result.conflictingPaths.has('shared.txt'), result.out.join('\n')).toBe(true)
    expect(t.snapshot()).toEqual(before)
  })
})

describe('worker deletion callers', () => {
  const get = sharedFixture({ removeTest: true })
  it.each(names)('applies a worker deletion of a previously delivered new test exactly once from %s', async caller => {
    const { t, before } = await get()
    const result = await t.preview(caller, names.filter(name => name !== caller).reverse())
    expect(result.complete, result.out.join('\n')).toBe(true)
    expect(result.conflictingPaths.size, result.out.join('\n')).toBe(0)
    expect(result.merged).toEqual(t.expected)
    expect(t.snapshot()).toEqual(before)
  })
})

describe('multiple keep callers', () => {
  const get = sharedFixture({ keeps: 2 })
  it.each(names)('uses the newest own snapshot after multiple keep rounds from %s', async caller => {
    const { t, before } = await get()
    const result = await t.preview(caller, names.filter(name => name !== caller).reverse())
    expect(result.complete, result.out.join('\n')).toBe(true)
    expect(result.conflictingPaths.size, result.out.join('\n')).toBe(0)
    expect(result.merged).toEqual(t.expected)
    expect(t.snapshot()).toEqual(before)
  })
})

describe('repeated-line permutations', () => {
  const get = sharedFixture({ shared: 'repeated' }, gitOracle)
  it.each(cases)('repeated-line Git alignment uses collection policy from $caller with $people', async ({ caller, people }) => {
    const { t, before } = await get()
    const result = await t.preview(caller, people)
    // Git's alignment is deterministic under the existing collection key. This
    // deliberately does not assert commutativity or preservation of semantic intent.
    expect(result.complete, result.out.join('\n')).toBe(true)
    expect(result.conflictingPaths.size, result.out.join('\n')).toBe(0)
    expect(result.merged).toEqual(t.expected)
    expect(t.snapshot()).toEqual(before)
  })
})

it('real collect matches the independent repeated-line Git oracle and the full preview', async () => {
  const t = await fixture({ shared: 'repeated' })
  gitOracle(t)
  const before = t.snapshot(), result = await t.preview('lead', names.slice(1))
  expect(result.complete, result.out.join('\n')).toBe(true)
  expect(result.conflictingPaths.size, result.out.join('\n')).toBe(0)
  expect(result.merged).toEqual(t.expected)
  expect(t.snapshot()).toEqual(before)
  expect(await collectHandlers(t.stateFor(t.sessions.get('lead')!)).room_collect({ keep: true })).toContain('kept api')
  for (const [file, expected] of t.expected) {
    expect(fs.readFileSync(path.join(t.root, file), 'utf8')).toBe(expected)
  }
})

it('reports unknown delivered provenance for sibling-only different snapshots instead of losing a deliberate revert', async () => {
  const t = await fixture({ shared: 'disjoint' }), before = t.snapshot()
  const result = await t.preview('lead+api', ['lead+backend', 'lead+consumer'])
  expect(result.complete).toBe(false)
  expect(result.gaps.some(gap => gap.path === 'shared.txt' && gap.why.includes('include lead'))).toBe(true)
  expect(result.merged.has('shared.txt')).toBe(false)
  expect(t.snapshot()).toEqual(before)
})

it('refuses a held or partially shared lead anchor without reading its disk or substituting the caller', async () => {
  const t = await fixture(), before = t.snapshot()
  const head = t.room.manifestHead.get('lead')!
  t.room.manifestHead.set('lead', { ...head, level: 'declared', rev: head.rev + 1 })
  const result = await t.preview('lead+api', ['lead+backend', 'lead+consumer', 'lead'])
  expect(result.complete).toBe(false)
  expect(result.gaps.some(gap => gap.person === 'lead' && gap.why.includes('anchor unavailable'))).toBe(true)
  expect(result.merged.has('src/api.ts')).toBe(false)
  expect(t.snapshot()).toEqual(before)
})

it('requires a new post-application acknowledgement after publisher replacement', async () => {
  const t = await fixture(), lead = t.sessions.get('lead')!, head = t.room.manifestHead.get('lead')!
  const holder = t.room.participants.get('lead\0holder')! as { sessionId: string; epoch: number }
  t.room.participants.set('lead\0holder', { ...holder, sessionId: 'replacement', epoch: holder.epoch + 1 })
  lead.daemon.fence = String(holder.epoch + 1)
  await lead.daemon.reconcileGitChanges()
  let result = await t.preview('lead+api', ['lead+backend', 'lead+consumer', 'lead'])
  expect(result.complete).toBe(false)
  expect(result.gaps.some(gap => gap.why.includes('acknowledged post-baseline'))).toBe(true)
  const records = t.registry.list()
  for (const record of records) {
    const proof = await acknowledgeKeptPublication(lead, record.keptPublication, [])
    expect(proof.pending).toBe(false)
    await t.registry.update(record.id, old => ({ ...old, keptPublication: { ...proof, base: record.base }, seq: old.seq + 1 }))
  }
  result = await t.preview('lead+api', ['lead+backend', 'lead+consumer', 'lead'])
  expect(result.complete, result.out.join('\n')).toBe(true)
  expect(result.conflictingPaths.size, result.out.join('\n')).toBe(0)
  expect(result.merged).toEqual(t.expected)
  expect(t.room.manifestHead.get('lead')!.fence).not.toBe(head.fence)
})

it('tracks own-caller record, collection ref and merge-order key changes in snapshot freshness', async () => {
  const t = await fixture(), result = await t.preview('lead+api', ['lead+backend', 'lead+consumer', 'lead'])
  expect(result.isCurrent()).toBe(true)
  const record = t.registry.reservedByTagOrName('lead+api')!
  await t.registry.update(record.id, old => ({ ...old, seq: old.seq + 1 }))
  expect(result.moved()).toContain('lead+api')
  const keySnapshot = await t.preview('lead+api', ['lead+backend', 'lead+consumer', 'lead'])
  const report = t.registry.reports(record.id)[0]
  await t.registry.writeReport(record.id, { ...report, done: { ...report.done!, at: report.done!.at + 1000 } })
  expect(t.registry.read(record.id)!.seq).toBe(record.seq + 1)
  expect(keySnapshot.moved()).toContain('lead+api')
  const next = await t.preview('lead+api', ['lead+backend', 'lead+consumer', 'lead'])
  git(t.root, 'update-ref', `refs/room/collect-head/${record.tag}/${record.id}`, git(t.root, 'rev-parse', 'HEAD'))
  expect(next.moved()).toContain('lead+api')
})

async function carriedFixture(carry = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-carried-preview-'))); roots.push(root)
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Lead'); git(root, 'config', 'user.email', 'lead@example.test')
  put(root, 'shared.txt', sharedText()); put(root, '.gitignore', '.room/\n')
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'base')
  const base = git(root, 'rev-parse', 'HEAD'), room = new RoomDoc(); rooms.push(room); room.setMeta({ base })
  publishFixture(room, 'lead', 'shared.txt', sharedText(), { base })
  room.participants.set('lead\0git', { ...room.participants.get('lead\0git')!, head: base })
  put(root, 'shared.txt', sharedText([2, 'carried input'])); put(root, 'new.txt', 'carried untracked input\n')
  const prepared = await prepareWorktree(root, 'carry', 'lead', [], undefined, 0, carry)
  const session = (name: string, dir: string) => ({ ...hubSeam(room), policyStore: testPolicyStore(), dir, me: { name, kind: 'agent' }, room,
    local: {}, roomName: 'local/test', awareness: { getStates: () => new Map() }, daemon: { touch() {}, fence: '1', settle: async () => {} } } as unknown as Session)
  const lead = session('lead', root), worker = session('lead+carry', prepared.dir)
  const registry = await registerWorkers(lead, [{ tag: 'carry', name: 'lead+carry', lead: 'lead', dir: prepared.dir, branch: prepared.branch,
    status: 'done', base: prepared.base, carriedBase: prepared.carriedBase, carriedUntracked: prepared.carriedUntracked, host: 'codex', task: 'carry', pid: 0, startedAt: 1 }])
  put(worker.dir, 'own.txt', 'worker own comment\n'); publishFixture(room, worker.me.name, 'own.txt', 'worker own comment\n', { base: prepared.base })
  lead.daemon.reconcileGitChanges = async () => {
    for (const p of ['shared.txt', 'new.txt']) publishFixture(room, 'lead', p, fs.readFileSync(path.join(root, p), 'utf8'), { base })
    room.participants.set('lead\0git', { ...room.participants.get('lead\0git')!, head: base })
  }
  const state = { S: () => worker, rooms: { holding: () => worker }, baseFor: (_s: Session, person: string) => manifestHeadOf(room, person)?.base ?? base,
    shareOf: () => 'full' } as unknown as HandlerState
  return { root, room, lead, worker, registry, prepared, preview: () => buildCombinedTree(state, worker, [{ person: 'lead', session: worker }]) }
}

it('rejects a complete stale pre-carry lead frame including unchanged carried untracked input', async () => {
  const t = await carriedFixture(), result = await t.preview()
  expect(result.complete).toBe(false)
  expect(result.gaps.some(g => g.why.includes('acknowledged'))).toBe(true)
})

it('accepts a verified carried publication and requires reacknowledgement after replacement', async () => {
  const t = await carriedFixture(), record = t.registry.reservedByTagOrName('lead+carry')!
  const proof = await acknowledgeKeptPublication(t.lead, undefined, t.prepared.carried!.paths)
  expect(proof.pending).toBe(false)
  await t.registry.update(record.id, old => ({ ...old, keptPublication: { ...proof, base: record.base }, seq: old.seq + 1 }))
  const result = await t.preview()
  expect(result.complete, result.out.join('\n')).toBe(true)
  expect(result.merged.get('shared.txt')).toBe(sharedText([2, 'carried input']))
  expect(result.merged.get('new.txt')).toBe('carried untracked input\n')
  expect(result.merged.get('own.txt')).toBe('worker own comment\n')
  t.room.participants.set('lead\0holder', { ...t.room.participants.get('lead\0holder')!, sessionId: 'replacement' })
  expect((await t.preview()).complete).toBe(false)
})

it('does not require carried-publication acknowledgement for carry=false', async () => {
  const t = await carriedFixture(false), result = await t.preview()
  expect(t.prepared.carried).toBeUndefined()
  expect(result.complete, result.out.join('\n')).toBe(true)
  expect(result.merged.get('shared.txt')).toBe(sharedText())
  expect(result.merged.get('own.txt')).toBe('worker own comment\n')
})

it.each(['missing', 'rewritten'])('refuses real collect when a kept baseline ref is %s without changing lead/worker bytes or indexes', async kind => {
  const t = await fixture(), record = t.registry.reservedByTagOrName('lead+api')!
  const ref = `refs/room/collect-head/${record.tag}/${record.id}`
  if (kind === 'missing') git(t.root, 'update-ref', '-d', ref)
  else git(t.root, 'update-ref', ref, git(t.root, 'rev-parse', 'HEAD'))
  const before = t.snapshot(), refs = git(t.root, 'show-ref')
  const reply = await collectHandlers(t.stateFor(t.sessions.get('lead')!)).room_collect({ keep: true })
  expect(reply).toContain('Nothing written; preview provenance is incomplete')
  expect(t.snapshot()).toEqual(before); expect(git(t.root, 'show-ref')).toBe(refs)
})

it('refuses collect after a plain worker baseline falls off the lead history', async () => {
  const t = await fixture(), record = t.registry.reservedByTagOrName('lead+api')!
  const dir = t.sessions.get('lead+api')!.dir
  git(dir, 'add', 'src/api.ts'); git(dir, 'commit', '-qm', 'private checkpoint before spawn')
  const base = git(dir, 'rev-parse', 'HEAD')
  await t.registry.update(record.id, old => ({ ...old, base, collectedKeep: undefined, carriedBase: undefined, keptPublication: undefined, seq: old.seq + 1 }))
  put(dir, 'src/api.ts', source('api', 3))
  const before = t.snapshot(), refs = git(t.root, 'show-ref')
  const reply = await collectHandlers(t.stateFor(t.sessions.get('lead')!)).room_collect({ tag: 'api', keep: true })
  expect(reply).toContain('Nothing written; preview provenance is incomplete')
  expect(t.snapshot()).toEqual(before); expect(git(t.root, 'show-ref')).toBe(refs)
})

it.each(['missing', 'mismatched'])('does not certify a plain checkpoint from a %s published actual HEAD', async kind => {
  const t = await carriedFixture(false), record = t.registry.reservedByTagOrName('lead+carry')!
  const dir = t.worker.dir
  git(dir, 'add', 'own.txt'); git(dir, 'commit', '-qm', 'checkpoint')
  const base = git(dir, 'rev-parse', 'HEAD')
  await t.registry.update(record.id, old => ({ ...old, base, seq: old.seq + 1 }))
  publishFixture(t.room, t.worker.me.name, 'own.txt', 'changed after checkpoint\n', { base })
  const leadGit = t.room.participants.get('lead\0git')!
  t.room.participants.set('lead\0git', { ...leadGit, head: kind === 'missing' ? undefined : base, ...(kind === 'mismatched' ? { fence: 'wrong' } : {}) })
  expect((await t.preview()).complete).toBe(false)
})

it.each([false, true])('checks the immediate worker-lead publication in a three-generation preview (stale=%s)', async stale => {
  const t = await carriedFixture(), parentRecord = t.registry.reservedByTagOrName('lead+carry')!
  const parentProof = await acknowledgeKeptPublication(t.lead, undefined, t.prepared.carried!.paths)
  await t.registry.update(parentRecord.id, old => ({ ...old, keptPublication: { ...parentProof, base: old.base }, seq: old.seq + 1 }))
  const child = await prepareWorktree(t.worker.dir, 'grand', t.worker.me.name, [])
  await registerWorkers(t.worker, [{ tag: 'grand', name: 'lead+carry+grand', lead: t.worker.me.name, dir: child.dir, branch: child.branch,
    status: 'done', base: child.base, carriedBase: child.carriedBase, carriedUntracked: child.carriedUntracked, host: 'codex', task: 'grand', pid: 0, startedAt: 2 }])
  t.worker.daemon.reconcileGitChanges = async () => {
    for (const p of ['shared.txt', 'new.txt', 'own.txt']) publishFixture(t.room, t.worker.me.name, p, fs.readFileSync(path.join(t.worker.dir, p), 'utf8'), { base: t.prepared.base })
    t.room.participants.set(`${t.worker.me.name}\0git`, { ...t.room.participants.get(`${t.worker.me.name}\0git`)!, head: git(t.worker.dir, 'rev-parse', 'HEAD') })
  }
  const record = t.registry.reservedByTagOrName('lead+carry+grand')!
  const proof = await acknowledgeKeptPublication(t.worker, undefined, child.carried!.paths)
  expect(proof.pending).toBe(false)
  await t.registry.update(record.id, old => ({ ...old, keptPublication: { ...proof, base: old.base }, seq: old.seq + 1 }))
  if (stale) t.room.participants.set(`${t.worker.me.name}\0holder`, { ...t.room.participants.get(`${t.worker.me.name}\0holder`)!, sessionId: 'replacement' })
  put(child.dir, 'grand.txt', 'grand own note\n')
  publishFixture(t.room, record.name, 'grand.txt', 'grand own note\n', { base: child.base })
  const caller = { ...t.worker, dir: child.dir, me: { name: record.name, kind: 'agent' } } as Session
  const state = { S: () => caller, rooms: { holding: () => caller }, shareOf: () => 'full',
    baseFor: (_s: Session, person: string) => manifestHeadOf(t.room, person)!.base } as unknown as HandlerState
  const result = await buildCombinedTree(state, caller, [{ person: 'lead', session: caller }, { person: t.worker.me.name, session: caller }])
  expect(result.complete, result.out.join('\n')).toBe(!stale)
  if (!stale) {
    expect(result.merged.get('shared.txt')).toBe(sharedText([2, 'carried input']))
    expect(result.merged.get('new.txt')).toBe('carried untracked input\n')
    expect(result.merged.get('own.txt')).toBe('worker own comment\n')
    expect(result.merged.get('grand.txt')).toBe('grand own note\n')
  }
})

it('retains the worker and marks unknown freshness when optional ACK metadata is malformed', async () => {
  const t = await fixture(), record = t.registry.reservedByTagOrName('lead+api')!
  fs.writeFileSync(path.join(t.registry.root, 'workers', `${record.id}.json`), JSON.stringify({ ...record, keptPublication: { pending: false, paths: [7], ack: {} } }))
  expect(t.registry.read(record.id)).toMatchObject({ id: record.id, keptPublication: { paths: [], pending: true, overflow: true } })
  expect(localWorkers(t.root).some(worker => worker.id === record.id)).toBe(true)
  expect((await t.preview('lead+api', ['lead+backend', 'lead+consumer', 'lead'])).complete).toBe(false)
})

it('gaps a lead-absent later baseline that reverts an earlier delivery back to the common ancestor', async () => {
  const t = await fixture({ shared: 'disjoint' }), api = t.registry.reservedByTagOrName('lead+api')!, backend = t.registry.reservedByTagOrName('lead+backend')!
  const dir = t.sessions.get('lead+backend')!.dir
  git(dir, 'reset', '-q', '--hard', api.base!)
  put(dir, 'shared.txt', sharedText()); git(dir, 'add', 'shared.txt'); git(dir, 'commit', '-qm', 'later baseline reverts earlier delivery')
  const base = git(dir, 'rev-parse', 'HEAD')
  await t.registry.update(backend.id, old => ({ ...old, base, seq: old.seq + 1 }))
  publishFixture(t.room, backend.name, 'shared.txt', sharedText(), { base })
  const result = await t.preview('lead+api', ['lead+backend', 'lead+consumer'])
  expect(result.complete).toBe(false)
  expect(result.gaps.some(g => g.path === 'shared.txt' && g.why.includes('include lead'))).toBe(true)
})
