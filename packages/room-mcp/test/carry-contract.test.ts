import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RoomDoc, SymbolGraph, type ContractMsg, type Identity, type Worker } from '@room/shared'
import { ensureLanguages, parseFile } from '../src/parse/engine.js'
import { gitShow } from '@room/roomd/git'
import { ConflictWatcher } from '../src/conflicts.js'
import { referencesSymbol } from '../src/graph-index.js'

const lead = 'rohanz', worker = 'rohanz+calc', pricing = 'api/pricing.py', handler = 'api/handler.py'
const carriedText = 'def tier_rate(tier):\n    return 0.1\n'
const changedText = 'def tier_rate(tier, year):\n    return 0.1\n'
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
const put = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), text)
}

let root: string, repo: string, head: string
let workerId: string | undefined
let baseReads = 0
beforeEach(() => {
  workerId = process.env.ROOM_WORKER_ID
  delete process.env.ROOM_WORKER_ID
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-carry-contract-')))
  repo = path.join(root, 'lead'); fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', lead); git(repo, 'config', 'user.email', 'lead@example.test')
  put(repo, '.gitignore', '.room/\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base'); head = git(repo, 'rev-parse', 'HEAD')
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  if (workerId === undefined) delete process.env.ROOM_WORKER_ID
  else process.env.ROOM_WORKER_ID = workerId
})

/**
 * Spawn the way carry does, without depending on its implementation: tracked WIP in a carried
 * commit (Worker.carriedBase), untracked files copied with their blobs stored.
 */
async function world(carried: 'tracked' | 'untracked' | false = 'tracked', graph?: SymbolGraph, provider = pricing, providerText = carriedText) {
  if (carried === 'tracked') {
    put(repo, provider, provider === pricing ? 'def tier_rate():\n    return 0\n' : ''); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'pricing'); head = git(repo, 'rev-parse', 'HEAD')
  }
  if (carried) put(repo, provider, providerText)
  const dir = path.join(root, 'calc')
  git(repo, 'worktree', 'add', '-q', '-b', 'room/calc', dir, head)
  if (carried) put(dir, provider, providerText)
  if (carried === 'tracked') git(dir, 'commit', '-qam', 'room: carried-in uncommitted work')
  const base = git(dir, 'rev-parse', 'HEAD')
  if (!carried) put(repo, provider, providerText)
  const room = new RoomDoc()
  room.setMeta({ repo: 'test', branch: 'main', base: head })
  const record = {
    id: `${lead}/calc#1`, tag: 'calc', name: worker, host: 'codex', task: 'use pricing',
    dir, branch: 'room/calc', base, pid: 123, startedAt: 1, status: 'running', lead,
    ...(carried === 'tracked' ? { carriedBase: base } : {}),
    ...(carried === 'untracked' ? { carriedUntracked: [{ path: provider, sha: git(repo, 'hash-object', '-w', `--path=${provider}`, provider) }] } : {}),
  } as Worker
  room.setWorker(record)
  const me: Identity = { name: worker, kind: 'agent', owner: lead }
  const watcher = new ConflictWatcher({
    room, me, debounceMs: 0,
    liveText: async (file, person) => {
      const location = path.join(person === lead ? repo : dir, file)
      return fs.existsSync(location) ? fs.readFileSync(location, 'utf8') : null
    },
    baseText: (sha, file) => { baseReads++; return gitShow(dir, sha, file) },
    baseFor: person => person === worker ? base : head,
    mergeBase: async (a, b) => git(dir, 'merge-base', a, b),
    graph: () => graph,
  })
  watcher.start()
  const publishLead = (text: string | null) => {
    if (text === null) { fs.rmSync(path.join(repo, provider)); room.markDeleted(lead, provider) }
    else { put(repo, provider, text); room.setOverlay(lead, provider, text) }
    // Against the room base this remains only an add, even when the carried definition changes.
    room.graphs.set(lead, {
      version: 1, base: head, at: Date.now(), status: 'ready', truncated: false,
      paths: [provider, handler], edges: [],
      observed: text === null ? [] : [{ path: provider, symbol: 'tier_rate', kind: 'add', detail: 'now `def tier_rate(tier):`' }],
    })
  }
  const useIn = (file: string, text: string, claim = false) => {
    put(dir, file, text)
    if (claim) room.addClaim({ path: file, from: 1, to: 20, by: worker, byKind: 'agent', intent: 'use pricing' })
    else room.setOverlay(worker, file, text)
  }
  const notices = () => room.messages().filter((message): message is ContractMsg => message.type === 'contract')
  return { room, watcher, publishLead, useIn, notices, dir }
}

describe('carried definition contract notices', () => {
  it('reports a signature change against the carried commit once, with the lead, path, symbol, and signatures', async () => {
    const t = await world()
    t.useIn(handler, 'from api.pricing import tier_rate\n\ndef price(tier):\n    return tier_rate(tier)\n')
    t.publishLead(changedText)
    await t.watcher.flush()
    expect(t.notices()).toMatchObject([{ to: worker, path: pricing, symbol: 'tier_rate', priority: 'notify',
      text: 'rohanz changed the signature of tier_rate() in api/pricing.py (was `def tier_rate(tier):` now `def tier_rate(tier, year):`); api/handler.py uses it' }])
    t.publishLead(changedText); await t.watcher.flush()
    expect(t.notices()).toHaveLength(1)
    t.watcher.stop()
  })

  it('reports the old symbol when the lead renames a carried definition', async () => {
    const t = await world()
    t.useIn(handler, 'from api.pricing import tier_rate\n\ndef price(tier):\n    return tier_rate(tier)\n')
    t.publishLead('def annual_rate(tier):\n    return 0.1\n')
    await t.watcher.flush()
    expect(t.notices().map(message => message.text)).toEqual([
      'rohanz deleted tier_rate() in api/pricing.py (was `def tier_rate(tier):`); api/handler.py uses it',
    ])
    t.watcher.stop()
  })

  it('reports a carried definition removed from the lead file', async () => {
    const t = await world()
    t.useIn(handler, 'from api.pricing import tier_rate\n\ndef price(tier):\n    return tier_rate(tier)\n')
    t.publishLead(null)
    await t.watcher.flush()
    expect(t.notices().map(message => message.text)).toEqual([
      'rohanz deleted tier_rate() in api/pricing.py (was `def tier_rate(tier):`); api/handler.py uses it',
    ])
    t.watcher.stop()
  })

  it('finds a call in the same file that was carried', async () => {
    const t = await world()
    t.useIn(pricing, carriedText + '\ndef price(tier):\n    return tier_rate(tier)\n')
    t.publishLead(changedText)
    await t.watcher.flush()
    expect(t.notices()).toMatchObject([{ path: pricing, symbol: 'tier_rate',
      text: expect.stringContaining('; api/pricing.py uses it') }])
    t.watcher.stop()
  })

  it('finds a call in another worker file when that file is claimed', async () => {
    const t = await world()
    t.useIn(handler, 'from api.pricing import tier_rate\n\ndef price(tier):\n    return tier_rate(tier)\n', true)
    t.publishLead(changedText)
    await t.watcher.flush()
    expect(t.notices()).toMatchObject([{ text: expect.stringContaining('; api/handler.py uses it') }])
    t.watcher.stop()
  })

  it('does not report a body-only lead edit', async () => {
    const t = await world()
    t.useIn(handler, 'from api.pricing import tier_rate\n\ndef price(tier):\n    return tier_rate(tier)\n')
    t.publishLead(carriedText.replace('0.1', '0.2'))
    await t.watcher.flush()
    expect(t.notices()).toEqual([])
    t.watcher.stop()
  })

  it('finds same-file calls of arrow functions and methods', async () => {
    expect(await referencesSymbol('a.ts', 'export const rate = (x: number) => x;\nexport function use() { return rate(1); }\n', 'rate')).toBe(true)
    expect(await referencesSymbol('a.java', 'class A { int rate(int x) { return x; } int use() { return rate(1); } }', 'A.rate')).toBe(true)
    expect(await referencesSymbol('a.ts', 'class A { rate(x: number) { return x; } use() { return this.rate(1); } }', 'A.rate')).toBe(true)
    expect(await referencesSymbol('a.py', 'def rate(x):\n    return x\n\ndef use():\n    return rate(1)\n', 'rate')).toBe(true)
    expect(await referencesSymbol('a.ts', 'export const rate = (x: number) => x;\nexport function use() { return 1; }\n', 'rate')).toBe(false)
    expect(await referencesSymbol('a.py', 'def rate(x):\n    return x\n', 'rate')).toBe(false)
  })

  it('narrows a carried definition by the consumer\'s imports', async () => {
    const provider = 'src/pricing.ts', other = 'src/other.ts', use = 'src/use.ts'
    const otherText = 'export function tier_rate(tier: number) { return 0.3 }\n'
    put(repo, other, otherText); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'other'); head = git(repo, 'rev-parse', 'HEAD')
    const graph = new SymbolGraph((file, text) => { const parsed = parseFile(file, text)!; return { ...parsed, defs: parsed.defs.map(definition => definition.name) } })
    await ensureLanguages([other]); graph.set(other, otherText)
    const t = await world('tracked', graph, provider, 'export function tier_rate(tier: number) { return 0.1 }\n')
    t.useIn(use, 'import { tier_rate } from "./other";\nexport const price = (tier: number) => tier_rate(tier);\n')
    t.publishLead('export function tier_rate(tier: number, year: number) { return 0.1 }\n')
    await t.watcher.flush()
    expect(t.notices()).toEqual([])
    t.useIn(use, 'import { tier_rate } from "./pricing";\nexport const price = (tier: number) => tier_rate(tier);\n')
    await t.watcher.flush()
    expect(t.notices()).toMatchObject([{ text: expect.stringContaining('; src/use.ts uses it') }])
    t.watcher.stop()
  })

  it('reports a carried definition the lead reverts to HEAD', async () => {
    const t = await world()
    t.useIn(handler, 'from api.pricing import tier_rate\n\ndef price(tier):\n    return tier_rate(tier)\n')
    t.room.setOverlay(lead, pricing, carriedText)
    await t.watcher.flush()
    expect(t.notices()).toEqual([])
    git(repo, 'checkout', '--', pricing); t.room.clearOverlay(lead, pricing)
    await t.watcher.flush()
    expect(t.notices().map(message => message.text)).toEqual([
      'rohanz changed the signature of tier_rate() in api/pricing.py (was `def tier_rate(tier):` now `def tier_rate():`); api/handler.py uses it',
    ])
    t.watcher.stop()
  })

  it('reports a change to a carried untracked definition', async () => {
    const t = await world('untracked')
    t.useIn(handler, 'from api.pricing import tier_rate\n\ndef price(tier):\n    return tier_rate(tier)\n')
    t.publishLead(changedText)
    await t.watcher.flush()
    expect(t.notices()).toMatchObject([{ path: pricing, symbol: 'tier_rate', text: expect.stringContaining('now `def tier_rate(tier, year):`') }])
    t.watcher.stop()
  })

  it('bounds the work: a burst of unrelated overlay events costs no reparse', async () => {
    const t = await world()
    t.useIn(handler, 'from api.pricing import tier_rate\n\ndef price(tier):\n    return tier_rate(tier)\n')
    t.publishLead(changedText)
    await t.watcher.flush()
    const reads = baseReads
    for (let i = 0; i < 20; i++) t.room.setOverlay('someone', 'docs.md', `edit ${i}\n`)
    await t.watcher.flush()
    expect(baseReads).toBe(reads)
    expect(t.notices()).toHaveLength(1)
    t.watcher.stop()
  })

  it('keeps non-carried workers on the existing observed-change rule', async () => {
    const t = await world(false)
    t.useIn(handler, 'from api.pricing import tier_rate\n\ndef price(tier):\n    return tier_rate(tier)\n')
    t.publishLead(changedText)
    await t.watcher.flush()
    expect(t.notices()).toEqual([])
    t.watcher.stop()
  })
})
