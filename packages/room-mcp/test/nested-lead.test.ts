/**
 * Background batches: the lead as a worker. A human's session spawns one worker whose task is to lead;
 * it spawns grand-workers into worktrees nested under its own (`<lead worktree>/.room/workers/<tag>`).
 * Each test is named after the numbered item reported from a real run on 2026-09-23 (probe).
 * Real git and real worktrees; only the process spawner (and the claims release mock) are stubbed.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { JSDOM } from 'jsdom'
import { RoomDoc, formatMsg, messageEndsWait, messageForMe, shouldWakeOnMsg, type Identity, type NoteMsg, type Worker } from '@room/shared'
import { handlers as collectHandlers } from '../src/tools/collect.js'
import type { HandlerState } from '../src/tools/context.js'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { GraphIndex } from '../src/graph-index.js'
import { prepareWorktree, type SpawnSpec } from '../src/workers.js'
import { createFocusState, participantsPanel } from '../../web/src/panels.ts'
import type { Conn } from '../../web/src/conn.ts'

vi.mock('../src/tools/claims.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/tools/claims.js')>(),
  releaseClaimsOnDone: vi.fn(),
}))

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
const put = (dir: string, p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text) }
const read = (dir: string, p: string) => fs.readFileSync(path.join(dir, p), 'utf8')

const HUMAN = 'rohanz', LEAD = 'rohanz+lead'
let root: string, top: string
let roomEnv: Record<string, string | undefined>

beforeEach(() => {
  roomEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('ROOM_')))
  for (const key of Object.keys(roomEnv)) delete process.env[key]
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-nested-')))
  top = path.join(root, 'top'); fs.mkdirSync(top)
  git(top, 'init', '-q', '-b', 'shop'); git(top, 'config', 'user.name', 'Human'); git(top, 'config', 'user.email', 'h@example.test')
  put(top, 'README.md', 'shop\n'); put(top, 'api/tax.py', 'RATES = {}\n'); put(top, 'api/catalog.py', 'def price_of(name):\n    return 1\n')
  put(top, '.gitignore', '.venv/\n')
  git(top, 'add', '.'); git(top, 'commit', '-qm', 'base')
  // roomd adds this on join; every level shares the clone's info/exclude.
  fs.appendFileSync(path.join(top, '.git', 'info', 'exclude'), '.room/\n')
  // The human's own uncommitted work, as in the live run.
  put(top, 'README.md', 'shop\nLocal note: human WIP\n'); put(top, 'WIP-top.txt', 'untracked wip from the human\n')
})
afterEach(() => {
  vi.unstubAllGlobals()
  for (const key of Object.keys(process.env)) if (key.startsWith('ROOM_')) delete process.env[key]
  Object.assign(process.env, roomEnv)
  fs.rmSync(root, { recursive: true, force: true })
})

/** The shape the live run produced: the human's worker `lead` and its Codex worker `cat`, nested under it. */
async function nestedBatch(opts: { leadStatus?: Worker['status']; catStatus?: Worker['status'] } = {}) {
  const lead = await prepareWorktree(top, 'lead', HUMAN, [], `local/top/shop|${HUMAN}`)
  put(lead.dir, 'api/tax.py', '# Rates reviewed 2026-09\nRATES = {}\n')
  const cat = await prepareWorktree(lead.dir, 'cat', LEAD, [], `local/top/shop|${LEAD}`)
  put(cat.dir, 'api/catalog.py', 'def price_of(name):\n    """Raises KeyError for unknown products."""\n    return 1\n')
  put(lead.dir, '.room/workers/cat.log', 'codex transcript\n')
  const room = new RoomDoc(new Y.Doc())
  room.setMeta({ base: git(top, 'rev-parse', 'HEAD'), branch: 'shop', repo: 'top' })
  const leadW: Worker = { id: `${HUMAN}/lead#1`, tag: 'lead', name: LEAD, lead: HUMAN, host: 'claude', task: 'lead the batch', dir: lead.dir, branch: lead.branch, base: lead.base, pid: -1, startedAt: 1, status: opts.leadStatus ?? 'running', ...(lead.carriedUntracked?.length ? { carriedUntracked: lead.carriedUntracked } : {}) }
  const catW: Worker = { id: `${LEAD}/cat#1`, tag: 'cat', name: 'rohanz+cat', lead: LEAD, host: 'codex', task: 'catalog docstring', dir: cat.dir, branch: cat.branch, base: cat.base, pid: -1, startedAt: 2, status: opts.catStatus ?? 'running', ...(cat.carriedUntracked?.length ? { carriedUntracked: cat.carriedUntracked } : {}) }
  room.setWorker(leadW); room.setWorker(catW)
  return { lead, cat, room, leadW, catW }
}

/** The human's session after a crash: a fresh session in the top clone, with no process handles. */
function humanCollect(room: RoomDoc) {
  const s = { dir: top, local: {}, me: { name: HUMAN, kind: 'agent' }, roomName: 'local/top/shop', room, awareness: { getStates: () => new Map() } }
  const state = {
    S: () => s,
    rooms: { all: () => [s], holding: () => s, holdingWorker: () => s, reserve: () => true, unreserve() {}, retireWorkers: async () => {}, handle: () => undefined },
    workerAlive: () => false,
    dismissWorker: () => 'pid -1 not signalled: it is not alive',
    now: Date.now,
    ctx: { sleep: async () => {} },
  } as unknown as HandlerState
  return collectHandlers(state).room_collect
}

const prunable = () => git(top, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('prunable'))

describe('nested lead: a worker that leads workers', () => {
  it('1: an addressed room_send note from the human ends the lead-worker\'s room_wait and wakes it', () => {
    // Steering the background lead is the point of the feature. room_send(type note, to <lead>) is an fyi note:
    // it lands in the lead's inbox, but a lead blocked in room_wait keeps waiting (no endsWait) and a channel
    // does not wake it (wakes only at interrupt). Live, the lead acted on it only because a question it asked
    // was answered, which ended the wait; the sender's echo ("[fyi] rohanz's agent: ...") does not show the recipient.
    const room = new RoomDoc(new Y.Doc())
    const human: Identity = { name: HUMAN, kind: 'agent', owner: HUMAN }
    const leadMe: Identity = { name: LEAD, kind: 'agent', owner: HUMAN, label: 'lead' }
    const msg = room.post<NoteMsg>(human, { type: 'note', to: LEAD, text: 'also add a comment to api/reports.py' })
    expect(messageForMe(leadMe, msg)).toBe(true) // delivered to the inbox today
    expect({
      endsWait: messageEndsWait(msg, { me: LEAD }),
      wakes: shouldWakeOnMsg(leadMe, msg, [], false).wake,
      showsRecipient: formatMsg(msg).includes(LEAD),
    }).toEqual({ endsWait: true, wakes: true, showsRecipient: true })
  })

  it('2: after the human session dies, the lead-worker\'s finished edits can still be copied out', async () => {
    // Live: room_state says "stopped while no session of yours was running", but the record still says running,
    // so room_collect answers "skipped lead: running" for apply AND copy mode; only discard is left.
    const { room } = await nestedBatch()
    const collect = humanCollect(room)
    const out = await collect({ tag: 'lead', mode: 'copy', paths: ['api/tax.py'] })
    expect(out).toContain('copied api/tax.py')
    expect(read(top, 'api/tax.py')).toBe('# Rates reviewed 2026-09\nRATES = {}\n')
  })

  it('3: discarding a lead-worker names its nested workers instead of calling .room/ an uncopied artifact', async () => {
    // Live: "discard refused; ignored artifacts not covered by a recovery patch: .room/ ... copy what you need
    // (mode=\"copy\")" - but copy refuses the same worker (item 2), and .room/ holds another worker's worktree.
    const { room } = await nestedBatch()
    const out = await humanCollect(room)({ tag: 'lead', discard: true })
    expect(out).not.toContain('ignored artifacts not covered by a recovery patch: .room/')
    expect(out).toContain('cat')
  })

  it('4: force-discarding a lead-worker does not destroy a grand-worker\'s uncollected output or leave git debris', async () => {
    const { room, cat } = await nestedBatch()
    const out = await humanCollect(room)({ tag: 'lead', discard: true, force: true })
    const catEdit = 'Raises KeyError for unknown products'
    const patches = fs.existsSync(path.join(top, '.room', 'discarded')) ? fs.readdirSync(path.join(top, '.room', 'discarded')).map(f => read(path.join(top, '.room', 'discarded'), f)) : []
    const recoverable = (fs.existsSync(path.join(cat.dir, 'api/catalog.py')) && read(cat.dir, 'api/catalog.py').includes(catEdit)) || patches.some(p => p.includes(catEdit))
    expect({ out, recoverable }).toMatchObject({ recoverable: true })
    expect(prunable()).toEqual([])
    // A branch without its worktree is debris unless the worktree survived.
    if (!fs.existsSync(cat.dir)) expect(git(top, 'branch', '--list', 'room/cat')).toBe('')
  })

  it('5: the human\'s session can dispose of grand-workers left behind by its dead lead-worker', async () => {
    // Live: "error: no worker catalog owned by you" for collect and discard; the tag stays reserved for good
    // ("tag catalog is in use by rohanz+lead's worker in this room").
    const { room } = await nestedBatch({ leadStatus: 'done' })
    room.retireParticipant(LEAD, { name: LEAD, tag: 'lead', lead: HUMAN, host: 'claude', task: 'lead', summary: 'discarded', files: [], fileCount: 0, startedAt: 1, finishedAt: 2, retiredAt: 3, outcome: 'dismissed' })
    const out = await humanCollect(room)({ tag: 'cat', discard: true, force: true })
    expect(out).not.toContain('no worker cat owned by you')
    expect(room.workers.has('cat')).toBe(false)
  })

  it('6: grand-workers share the lead-worker\'s compute budget instead of each inheriting all of it', async () => {
    // Live: lead got "3 threads, ~8 GB"; both Codex grand-workers were told "3 threads, ~8 GB" too, because
    // room_spawn copies ROOM_WORKER_THREADS / ROOM_WORKER_MEM_GB from its own environment verbatim.
    process.env.ROOM_WORKER_THREADS = '3'; process.env.ROOM_WORKER_MEM_GB = '8'
    const room = new RoomDoc(new Y.Doc())
    room.setMeta({ repo: 'top', branch: 'shop', base: git(top, 'rev-parse', 'HEAD') })
    const leadMe: Identity = { name: LEAD, kind: 'agent', owner: HUMAN, label: 'lead' }
    let s: Session | null = fakeSession(room, leadMe, top)
    const specs: SpawnSpec[] = []
    const tools = createTools({
      getSession: () => s, setSession: x => { s = x }, cwd: top, maxWorkers: 4,
      spawner: spec => { specs.push(spec); return { pid: 900 + specs.length, onExit: () => {}, kill: () => true } },
      worktree: async (repo, tag) => ({ dir: path.join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }),
    })
    for (const tag of ['ship', 'cat']) expect(await tools.call('room_spawn', { tag, task: 'one docstring', host: 'codex' })).toContain(`spawned ${tag}`)
    const mem = specs.reduce((sum, spec) => sum + Number(spec.env.ROOM_WORKER_MEM_GB), 0)
    const threads = specs.reduce((sum, spec) => sum + Number(spec.env.ROOM_WORKER_THREADS), 0)
    expect(mem).toBeLessThanOrEqual(8)
    expect(threads).toBeLessThanOrEqual(3)
  })

  it('7: room_state counts a dead worker\'s uncommitted edits from its worktree, not from its vanished overlay', async () => {
    // Live, new session after the crash: "lead ... 0 changed files" while its worktree had api/tax.py modified.
    const { room } = await nestedBatch()
    room.workers.delete('cat')
    let s: Session | null = fakeSession(room, { name: HUMAN, kind: 'agent', owner: HUMAN }, top)
    const tools = createTools({ getSession: () => s, setSession: x => { s = x }, cwd: top })
    const out = await tools.call('room_state', { all: true })
    expect(out).toMatch(/lead \(claude[^\n]*\n\s+1 changed file/)
  })

  it('8: the browser shows grand-workers nested under the lead-worker, and the lead-worker once', () => {
    const dom = new JSDOM('<body></body>')
    vi.stubGlobal('document', dom.window.document); vi.stubGlobal('window', dom.window)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const room = new RoomDoc()
    const w = (tag: string, lead: string): Worker => ({ tag, name: `rohanz+${tag}`, lead, host: tag === 'lead' ? 'claude' : 'codex', task: `task ${tag}`, dir: '/tmp/x', branch: `room/${tag}`, pid: 1, startedAt: 1, status: 'running' })
    room.workers.set('lead', w('lead', HUMAN)); room.workers.set('ship', w('ship', LEAD)); room.workers.set('cat', w('cat', LEAD))
    const states = new Map(['rohanz', 'rohanz+lead', 'rohanz+ship', 'rohanz+cat'].map((name, i) => [i + 1, { user: { name, kind: 'agent' } }]))
    const conn = { room, displayRoomName: 'local/top/shop', onStatus: vi.fn(), provider: { awareness: { getStates: () => states, on: vi.fn() } } } as unknown as Conn
    const panel = participantsPanel(conn, createFocusState())
    document.body.append(panel)
    // Live shape: two sibling groups, "rohanz · 1 running" and "rohanz+lead · 2 running", with rohanz+lead's card in both.
    const names = [...panel.querySelectorAll('button.participant .participant-head strong')].map(el => el.textContent)
    expect(names.filter(n => n === LEAD)).toHaveLength(1)
    const humanGroup = [...panel.querySelectorAll('.worker-group')].find(g => g.querySelector('.worker-group-heading')?.textContent?.startsWith(`${HUMAN} ·`))
    expect(humanGroup?.textContent).toContain('rohanz+cat')
    dom.window.close(); room.doc.destroy()
  })
})

function fakeSession(room: RoomDoc, me: Identity, dir: string): Session {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
  const graph = new GraphIndex(room, me.name, dir); graph.start()
  const base = git(dir, 'rev-parse', 'HEAD')
  return {
    graph, room, awareness, me, dir, roomUrl: 'ws://127.0.0.1:1/local%2Ftop%2Fshop', roomName: 'local/top/shop', browserUrl: 'http://x',
    provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: me.name, roomDoc: room, provider: null as never, branch: 'shop', base } as never,
    shareMax: 'full', shareRequested: 'full',
    local: { url: 'ws://127.0.0.1:1', port: 1, owned: true, async stop() {} },
  } as Session
}
