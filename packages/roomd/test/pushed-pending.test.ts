// Wave-2 review M7 (reporooms §B2 steps 5-6, §B4; manifest §5.4): the HEAD transition records the owed
// `pushed` as `git.pushedPending` in its transaction; the post is retried by its deterministic id on
// startup and every poll, and the marker clears only after the hub accepted it.
import { policyFromLevel } from '../src/policy.js'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import { RoomDoc, participantRecord, type Msg, type PushedMsg } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { startRoomd, type Roomd, type RoomdOptions } from '../src/index.js'
import { pollHead } from './poll-head.js'

vi.setConfig({ testTimeout: 30_000 })
beforeAll(() => { vi.stubEnv('CHOKIDAR_USEPOLLING', '1') })
afterAll(() => { vi.unstubAllEnvs() })

const sh = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
const daemons: Roomd[] = []
const roots: string[] = []
afterEach(async () => {
  try { for (const daemon of daemons.splice(0)) await daemon.stop() }
  finally { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) }
})

/** Docs joined through one relay share updates; the relay's own doc outlives any one daemon. */
function relay() {
  const docs = new Set<Y.Doc>()
  const states = new Map<number, unknown>()
  return (doc: Y.Doc): WebsocketProvider => {
    for (const peer of docs) Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer))
    docs.add(doc)
    const forward = (update: Uint8Array, origin: unknown) => { if (origin !== 'relay') for (const peer of docs) if (peer !== doc) Y.applyUpdate(peer, update, 'relay') }
    doc.on('update', forward)
    let local: unknown = null
    return {
      synced: true,
      awareness: { setLocalState(state: unknown) { local = state; if (state) states.set(doc.clientID, state); else states.delete(doc.clientID) }, getLocalState: () => local, getStates: () => states },
      on() {}, off() {}, destroy() { doc.off('update', forward); docs.delete(doc) },
    } as unknown as WebsocketProvider
  }
}

type Hub = 'accept' | 'refuse' | 'hang' | ((accept: () => unknown) => unknown)
async function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-pushed-pending-'))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const dir = path.join(root, 'checkout')
  sh(root, 'init', '--bare', '-q', '-b', 'rehearsal', origin)
  sh(root, 'init', '-q', '-b', 'rehearsal', dir)
  sh(dir, 'config', 'user.email', 'test@example.com')
  sh(dir, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(dir, 'app.txt'), 'first\n')
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'base')
  sh(dir, 'remote', 'add', 'origin', origin)
  sh(dir, 'push', '-q', '-u', 'origin', 'rehearsal')
  sh(dir, 'remote', 'set-head', 'origin', 'rehearsal')
  const connect = relay()
  const server = new Y.Doc()
  connect(server)
  const attempts: string[] = []
  const hub: { mode: Hub } = { mode: 'accept' }
  const start = async (extra: Partial<RoomdOptions> = {}) => {
    let own!: RoomDoc
    const daemon = await startRoomd({ policy: policyFromLevel('full'), dir, room: `ws://memory/${encodeURIComponent('github.com/owner/repo/rehearsal')}`,
      name: 'Alice', kind: 'agent', providerFactory: (_s, _n, doc) => { own = new RoomDoc(doc); return connect(doc) },
      // Stands in for the session's hub post: the result resolves once the hub answered.
      post: (from, body, opts) => {
        if (body.type === 'pushed') attempts.push(opts.id ?? '')
        const accept = () => ({ ok: true, msg: hubAppend(own, from, body, opts.id ? { id: opts.id } : {}) })
        const mode = hub.mode
        return mode === 'accept' ? Promise.resolve(accept()) : mode === 'refuse' ? Promise.resolve({ ok: false, reason: 'unreachable', text: 'not sent: hub unreachable' })
          : mode === 'hang' ? new Promise(() => {}) : mode(accept)
      },
      basePollMs: 60_000, trackedRefreshMs: 60_000, log: () => {}, ...extra })
    daemons.push(daemon)
    return daemon
  }
  const base = sh(dir, 'rev-parse', 'HEAD')
  const commitAndPush = (file: string) => {
    fs.writeFileSync(path.join(dir, file), `${file}\n`)
    sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', file)
    sh(dir, 'push', '-q', 'origin', 'rehearsal')
    return sh(dir, 'rev-parse', 'HEAD')
  }
  return { dir, base, server, attempts, hub, start, commitAndPush }
}
const pending = (daemon: Roomd) => participantRecord(daemon.roomDoc, 'Alice')?.git?.pushedPending
const pushed = (daemon: Roomd) => daemon.roomDoc.messages().filter((m: Msg): m is PushedMsg => m.type === 'pushed')
const idOf = (from: string, to: string) => `pushed:Alice:${from}:${to}`

it('a refused post leaves pushedPending in the record; every poll retries it by id until the hub accepts, then it clears', async () => {
  const w = await world()
  const daemon = await w.start()
  w.hub.mode = 'refuse'
  const local = w.commitAndPush('a.txt')
  await pollHead(daemon)
  expect(participantRecord(daemon.roomDoc, 'Alice')?.git).toMatchObject({ base: local, pushedPending: { fromSha: w.base, toSha: local } })
  await vi.waitFor(() => expect(w.attempts).toEqual([idOf(w.base, local)]))
  await pollHead(daemon)
  await pollHead(daemon)
  await vi.waitFor(() => expect(w.attempts.length).toBeGreaterThanOrEqual(3))
  expect(new Set(w.attempts)).toEqual(new Set([idOf(w.base, local)]))
  expect(pushed(daemon)).toEqual([])
  expect(pending(daemon)).toMatchObject({ fromSha: w.base, toSha: local })

  w.hub.mode = 'accept'
  await pollHead(daemon)
  await vi.waitFor(() => expect(pending(daemon)).toBeUndefined())
  expect(pushed(daemon)).toMatchObject([{ id: idOf(w.base, local), fromSha: w.base, toSha: local, commits: 1, paths: ['a.txt'] }])
  const tried = w.attempts.length
  await pollHead(daemon)
  expect(w.attempts.length).toBe(tried)
})

it('a crash between the transaction and the post: the restarted daemon posts the recorded pending by id, once', async () => {
  const w = await world()
  const first = await w.start()
  w.hub.mode = 'hang'
  const local = w.commitAndPush('a.txt')
  await pollHead(first)
  expect(pending(first)).toMatchObject({ fromSha: w.base, toSha: local })
  await first.stop(); daemons.splice(daemons.indexOf(first), 1)

  w.hub.mode = 'accept'
  const second = await w.start()
  await vi.waitFor(() => expect(pending(second)).toBeUndefined())
  expect(pushed(second).map(m => m.id)).toEqual([idOf(w.base, local)])
  expect(participantRecord(second.roomDoc, 'Alice')?.git).toMatchObject({ base: local })
})

it('a newer transition while a post is in flight: acceptance of the older one never clears the newer range', async () => {
  const w = await world()
  const daemon = await w.start()
  let answer!: () => void
  w.hub.mode = accept => new Promise(resolve => { answer = () => resolve(accept()) })
  const a = w.commitAndPush('a.txt')
  await pollHead(daemon)
  await vi.waitFor(() => expect(w.attempts).toEqual([idOf(w.base, a)]))
  const b = w.commitAndPush('b.txt')
  await pollHead(daemon)
  answer()
  await vi.waitFor(() => expect(pushed(daemon).map(m => m.id)).toEqual([idOf(w.base, a)]))
  // What the accepted post covered is done; what the newer transition added is still owed.
  expect(pending(daemon)).toMatchObject({ fromSha: a, toSha: b })
  w.hub.mode = 'accept'
  await pollHead(daemon)
  await vi.waitFor(() => expect(pending(daemon)).toBeUndefined())
  expect(pushed(daemon).map(m => m.id)).toEqual([idOf(w.base, a), idOf(a, b)])
})
