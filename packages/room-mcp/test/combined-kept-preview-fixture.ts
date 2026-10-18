import { RoomDoc, manifestHeadOf } from '@room/shared'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, expect, vi } from 'vitest'
import type { Session } from '../src/session.js'
import { handlers as collectHandlers } from '../src/tools/collect.js'
import { buildCombinedTree } from '../src/tools/combined-tree.js'
import type { HandlerState } from '../src/tools/context.js'
import { closeRegistryForDir, localWorkers } from '../src/worker-registry.js'
import { hubSeam } from './fixtures/hub.js'
import { deleteFixture, publishFixture } from './fixtures/manifest.js'
import { clearFixtureProcesses, fixtureLiveness } from './fixtures/process-liveness.js'
import { testPolicyStore } from './policy-fixture.js'
import { registerWorkers } from './registry-fixture.js'

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

export { cases, fixture, git, gitOracle, names, put, rooms, roots, sharedFixture, sharedText, source }
