import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RoomDoc, type ContractMsg, type Identity, type Worker } from '@room/shared'
import { gitShow } from '@room/roomd/git'
import { ConflictWatcher } from '../src/conflicts.js'
import { prepareWorktree } from '../src/workers.js'

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

async function world(carried = true) {
  if (carried) put(repo, pricing, carriedText)
  const prepared = await prepareWorktree(repo, 'calc', lead)
  expect(prepared.base).toBeTruthy()
  expect(prepared.base === head).toBe(!carried)
  if (!carried) put(repo, pricing, carriedText)
  const room = new RoomDoc()
  room.setMeta({ repo: 'test', branch: 'main', base: head })
  const record: Worker = {
    id: `${lead}/calc#1`, tag: 'calc', name: worker, host: 'codex', task: 'use pricing',
    dir: prepared.dir, branch: prepared.branch, base: prepared.base, pid: 123, startedAt: 1,
    status: 'running', lead,
  }
  room.setWorker(record)
  const me: Identity = { name: worker, kind: 'agent', owner: lead }
  const watcher = new ConflictWatcher({
    room, me, debounceMs: 0,
    liveText: async (file, person) => {
      const location = path.join(person === lead ? repo : prepared.dir, file)
      return fs.existsSync(location) ? fs.readFileSync(location, 'utf8') : null
    },
    baseText: (sha, file) => gitShow(prepared.dir, sha, file),
    baseFor: person => person === worker ? prepared.base! : head,
    mergeBase: async (a, b) => git(prepared.dir, 'merge-base', a, b),
  })
  watcher.start()
  const publishLead = (text: string | null) => {
    if (text === null) { fs.rmSync(path.join(repo, pricing)); room.markDeleted(lead, pricing) }
    else { put(repo, pricing, text); room.setOverlay(lead, pricing, text) }
    // Against the room base this remains only an add, even when the carried definition changes.
    room.graphs.set(lead, {
      version: 1, base: head, at: Date.now(), status: 'ready', truncated: false,
      paths: [pricing, handler], edges: [],
      observed: text === null ? [] : [{ path: pricing, symbol: 'tier_rate', kind: 'add', detail: 'now `def tier_rate(tier):`' }],
    })
  }
  const useIn = (file: string, text: string, claim = false) => {
    put(prepared.dir, file, text)
    if (claim) room.addClaim({ path: file, from: 1, to: 20, by: worker, byKind: 'agent', intent: 'use pricing' })
    else room.setOverlay(worker, file, text)
  }
  const notices = () => room.messages().filter((message): message is ContractMsg => message.type === 'contract')
  return { room, watcher, publishLead, useIn, notices, dir: prepared.dir }
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

  it('keeps non-carried workers on the existing observed-change rule', async () => {
    const t = await world(false)
    t.useIn(handler, 'from api.pricing import tier_rate\n\ndef price(tier):\n    return tier_rate(tier)\n')
    t.publishLead(changedText)
    await t.watcher.flush()
    expect(t.notices()).toEqual([])
    t.watcher.stop()
  })
})
