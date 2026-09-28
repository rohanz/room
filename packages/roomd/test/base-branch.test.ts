import { policyFromLevel } from '../src/policy.js'
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import { RoomDoc, participantRecord, type Msg, type ParticipantGit, type PushedMsg } from '@room/shared'
import { claimDigest } from '../src/reanchor.js'
import { markManifestIncomplete } from '../src/manifest-publish.js'
import { startRoomd, type Roomd, type RoomdOptions } from '../src/index.js'
import { pollHead } from './poll-head.js'
import { hubAppend } from '@room/shared/testing'

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

/** Docs joined through one hub share updates and one awareness map, as a room server would. */
function hub() {
  const docs = new Set<Y.Doc>()
  const states = new Map<number, unknown>()
  return {
    states,
    connect(doc: Y.Doc): WebsocketProvider {
      for (const peer of docs) Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer))
      docs.add(doc)
      const relay = (update: Uint8Array, origin: unknown) => { if (origin !== 'hub') for (const peer of docs) if (peer !== doc) Y.applyUpdate(peer, update, 'hub') }
      doc.on('update', relay)
      let local: unknown = null
      return {
        synced: true,
        awareness: {
          setLocalState(state: unknown) { local = state; if (state) states.set(doc.clientID, state); else states.delete(doc.clientID) },
          getLocalState: () => local,
          getStates: () => states,
        },
        on() {}, off() {}, destroy() { doc.off('update', relay); docs.delete(doc) },
      } as unknown as WebsocketProvider
    },
  }
}

async function world(options: { local?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-base-'))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const dir = path.join(root, 'checkout')
  sh(root, 'init', '--bare', '-q', '-b', 'rehearsal', origin)
  sh(root, 'init', '-q', '-b', 'rehearsal', dir)
  sh(dir, 'config', 'user.email', 'test@example.com')
  sh(dir, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(dir, 'app.txt'), 'first\nclaimed\nlast\n')
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-qm', 'base')
  sh(dir, 'remote', 'add', 'origin', origin)
  sh(dir, 'push', '-q', '-u', 'origin', 'rehearsal')
  sh(dir, 'remote', 'set-head', 'origin', 'rehearsal')
  const base = sh(dir, 'rev-parse', 'HEAD')
  const room = hub()
  // The server's copy: it outlives any one daemon, so a restart finds the records that survived.
  const server = new Y.Doc()
  room.connect(server)
  const start = async (extra: Partial<RoomdOptions> = {}, at = dir) => {
    // The daemon's automatic posts, standing in for the hub: appended at once to its own doc.
    let own!: RoomDoc
    const daemon = await startRoomd({ policy: policyFromLevel('full'),
      dir: at, room: `ws://memory/${encodeURIComponent(options.local ? 'local/repo' : 'github.com/owner/repo/rehearsal')}`,
      ...(options.local ? { localKey: 'test-local-key' } : {}),
      name: 'Alice', kind: 'agent', providerFactory: (_server, _name, doc) => { own = new RoomDoc(doc); return room.connect(doc) },
      post: (from, body, opts) => hubAppend(own, from, body, opts.id ? { id: opts.id } : {}),
      basePollMs: 60_000, trackedRefreshMs: 60_000, log: () => {}, ...extra,
    })
    daemons.push(daemon)
    return daemon
  }
  const other = (name: string) => {
    const at = path.join(root, name)
    sh(root, 'clone', '-q', origin, at)
    sh(at, 'config', 'user.email', 'test@example.com')
    sh(at, 'config', 'user.name', 'Test')
    return at
  }
  return { root, origin, dir, base, room, server, start, other }
}
const poll = pollHead
const git = (daemon: Roomd, name = daemon.name): ParticipantGit | undefined => participantRecord(daemon.roomDoc, name)?.git
const status = (daemon: Roomd) => (daemon.provider.awareness.getLocalState() as { status: string }).status
const pushed = (daemon: Roomd) => daemon.roomDoc.messages().filter((m: Msg): m is PushedMsg => m.type === 'pushed')
function commit(dir: string, file: string, text: string, message = file): string {
  fs.writeFileSync(path.join(dir, file), text)
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', message)
  return sh(dir, 'rev-parse', 'HEAD')
}

describe('participant git record (reporooms §B2, §B3)', () => {
  it('publishes branch, head, base and anchor at start, and keeps the one-time meta seed for legacy readers', async () => {
    const w = await world()
    const daemon = await w.start({ sessionId: 'host-1' })
    expect(git(daemon)).toEqual({ branch: 'rehearsal', head: w.base, base: w.base, anchored: true, remote: 'origin', upstream: 'origin/rehearsal', ahead: 0, behind: 0, rev: 1, fence: 'host-1' })
    expect(daemon.anchor).toEqual({ base: w.base, anchored: true })
    expect(status(daemon)).toBe('synced with origin/rehearsal')
    expect((daemon.provider.awareness.getLocalState() as { sessionId?: string }).sessionId).toBe('host-1')
    expect(daemon.roomDoc.meta).toMatchObject({ base: w.base, branch: 'rehearsal', seededBy: 'Alice' })
  })

  it('an unpushed commit keeps the anchor; its push moves it and posts one pushed {fromSha, toSha}', async () => {
    const w = await world()
    const daemon = await w.start()
    const local = commit(w.dir, 'a.txt', 'a\n', 'add a')
    await poll(daemon)
    expect(git(daemon)).toMatchObject({ head: local, base: w.base, anchored: true, ahead: 1, rev: 2 })
    expect(status(daemon)).toBe('1 unpushed')
    expect(pushed(daemon)).toEqual([])
    sh(w.dir, 'push', '-q', 'origin', 'rehearsal')
    await poll(daemon)
    await poll(daemon)
    expect(git(daemon)).toMatchObject({ head: local, base: local, ahead: 0, rev: 3 })
    expect(pushed(daemon)).toMatchObject([{
      id: `pushed:Alice:${w.base}:${local}`, from: 'Alice', branch: 'rehearsal', upstream: 'origin/rehearsal',
      fromSha: w.base, toSha: local, commits: 1, paths: ['a.txt'], summary: 'add a',
    }])
    expect(pushed(daemon)[0].to).toBeUndefined()
    expect(daemon.roomDoc.meta.base).toBe(w.base) // the legacy room base is never advanced again
    expect(daemon.roomDoc.messages().filter(m => m.type === 'base')).toEqual([])
  })

  it('a disk change during the HEAD transition re-prepares the publication instead of failing the transition', async () => {
    const w = await world()
    let reads = 0
    const daemon = await w.start({ beforeBaseRead: async p => {
      // Once the transition has read the disk, the file changes before its publication applies.
      if (p === 'wip.txt' && transitioning && ++reads === 1) fs.writeFileSync(path.join(w.dir, 'wip.txt'), 'second\n')
    } })
    let transitioning = false
    fs.writeFileSync(path.join(w.dir, 'wip.txt'), 'first\n')
    const local = commit(w.dir, 'a.txt', 'a\n', 'add a')
    transitioning = true
    await poll(daemon)
    expect(reads).toBe(2) // prepared, found stale, prepared again
    expect(git(daemon)).toMatchObject({ head: local, ahead: 1 })
    expect(daemon.roomDoc.overlayText(daemon.name, 'wip.txt')?.toString()).toBe('second\n')
  })

  it('announces each push of its own commits once, including a partial push while HEAD is further ahead', async () => {
    const w = await world()
    const daemon = await w.start()
    const first = commit(w.dir, 'a.txt', 'a\n')
    const second = commit(w.dir, 'b.txt', 'b\n')
    sh(w.dir, 'push', '-q', 'origin', `${first}:rehearsal`)
    sh(w.dir, 'fetch', '-q', 'origin')
    await poll(daemon)
    await poll(daemon)
    expect(git(daemon)).toMatchObject({ head: second, base: first, ahead: 1 })
    sh(w.dir, 'push', '-q', 'origin', 'rehearsal')
    await poll(daemon)
    await poll(daemon)
    expect(pushed(daemon).map(m => [m.fromSha, m.toSha])).toEqual([[w.base, first], [first, second]])
  })

  it('a pull of others\' commits, a reset and a branch switch post no pushed', async () => {
    const w = await world()
    const daemon = await w.start()
    const bob = w.other('bob')
    const theirs = commit(bob, 'b.txt', 'b\n')
    sh(bob, 'push', '-q', 'origin', 'HEAD:rehearsal')
    sh(w.dir, 'pull', '-q', '--ff-only')
    await poll(daemon)
    expect(git(daemon)).toMatchObject({ head: theirs, base: theirs })
    sh(w.dir, 'reset', '-q', '--hard', w.base)
    await poll(daemon)
    expect(git(daemon)).toMatchObject({ head: w.base, base: w.base, behind: 1 })
    expect(status(daemon)).toMatch(/^behind origin\/rehearsal by 1: /)
    sh(w.dir, 'checkout', '-qb', 'feature')
    const feature = commit(w.dir, 'f.txt', 'f\n')
    sh(w.dir, 'push', '-q', '-u', 'origin', 'feature')
    await poll(daemon)
    expect(git(daemon)).toMatchObject({ branch: 'feature', head: feature, base: feature, upstream: 'origin/feature' })
    expect(pushed(daemon)).toEqual([])
    expect(daemon.roomDoc.messages().filter(m => m.type === 'note')).toEqual([]) // no branch-switch banner
  })

  it('a detached HEAD is display only: branch is empty and nothing is announced', async () => {
    const w = await world()
    const daemon = await w.start()
    sh(w.dir, 'checkout', '-q', '--detach')
    const head = commit(w.dir, 'd.txt', 'd\n')
    sh(w.dir, 'push', '-q', 'origin', 'HEAD:rehearsal')
    sh(w.dir, 'fetch', '-q')
    await poll(daemon)
    expect(git(daemon)).toMatchObject({ branch: '', head })
    expect(status(daemon)).toBe(`detached at ${head.slice(0, 10)}`)
    expect(pushed(daemon)).toEqual([])
  })

  it('diverged clones and a force-pushed reset keep the daemon running; the anchor follows the remote', async () => {
    const w = await world()
    const bob = w.other('bob')
    const shared = commit(bob, 'b.txt', 'b\n'); sh(bob, 'push', '-q', 'origin', 'HEAD:rehearsal')
    sh(w.dir, 'pull', '-q', '--ff-only')
    const mine = commit(w.dir, 'a.txt', 'a\n')
    const daemon = await w.start()
    expect(git(daemon)).toMatchObject({ head: mine, base: shared, anchored: true })
    // Bob force-pushes a reset: the branch goes back to the first commit plus a new one.
    sh(bob, 'reset', '-q', '--hard', w.base)
    commit(bob, 'r.txt', 'r\n')
    sh(bob, 'push', '-q', '--force', 'origin', 'HEAD:rehearsal')
    sh(w.dir, 'fetch', '-q')
    await poll(daemon)
    expect(git(daemon)).toMatchObject({ head: mine, base: w.base, anchored: true, ahead: 2, behind: 1 })
    expect(status(daemon)).toBe('diverged from origin/rehearsal: stop and tell your human')
    // Then an unrelated history replaces the branch: no anchor, and still no stop.
    sh(bob, 'checkout', '-q', '--orphan', 'rewrite')
    commit(bob, 'o.txt', 'o\n')
    sh(bob, 'push', '-q', '--force', 'origin', 'HEAD:rehearsal')
    sh(w.dir, 'fetch', '-q')
    await poll(daemon)
    expect(git(daemon)).toMatchObject({ head: mine, base: mine, anchored: false })
    expect(status(daemon)).toBe('no anchor on origin: teammates cannot compare with you')
    expect(pushed(daemon)).toEqual([])
    expect((daemon as unknown as { stopped: boolean }).stopped).toBe(false)
  })

  it('writes the record and claim moves in one transaction, then posts pushed by id through the hub', async () => {
    const w = await world()
    const daemon = await w.start()
    const claim = daemon.roomDoc.addClaim({ path: 'app.txt', from: 2, to: 2, by: 'Alice', byKind: 'agent', intent: 'edit', claimedHash: claimDigest('first\nclaimed\nlast\n', 2, 2) })
    const moved = commit(w.dir, 'app.txt', 'added\nfirst\nclaimed\nlast\n')
    sh(w.dir, 'push', '-q', 'origin', 'rehearsal')
    const together: boolean[] = []
    daemon.roomDoc.doc.on('afterTransaction', (tr: Y.Transaction) => {
      if (tr.changed.has(daemon.roomDoc.participants)) together.push(tr.changed.has(daemon.roomDoc.claims) && !tr.changed.has(daemon.roomDoc.bus))
    })
    await poll(daemon)
    // The transition's one transaction, then the accepted post clearing pushedPending.
    await vi.waitFor(() => expect(together).toEqual([true, false]))
    expect(daemon.roomDoc.claims.get(claim.id)).toMatchObject({ from: 3, to: 3 })
    expect(git(daemon)).toMatchObject({ head: moved, base: moved })
    expect(git(daemon)?.pushedPending).toBeUndefined()
    expect(pushed(daemon)).toMatchObject([{ id: expect.stringMatching(/^pushed:Alice:/) }])
  })

  it('marks the manifest head incomplete before the transition\'s async work, until the whole transition succeeds', async () => {
    const w = await world()
    const daemon = await w.start()
    expect(daemon.roomDoc.manifestHead.get('Alice')).toMatchObject({ complete: true, base: w.base })
    const next = commit(w.dir, 'a.txt', 'a\n')
    const before = daemon.roomDoc.manifestHead.get('Alice')!
    const internal = daemon as unknown as { reanchorOwnClaims: (...args: unknown[]) => Promise<unknown>; publisher: { prepare(): Promise<unknown>; apply(prepared: unknown, complete: boolean): boolean } }
    const reanchor = internal.reanchorOwnClaims.bind(daemon)
    const during: unknown[] = []
    internal.reanchorOwnClaims = async () => { during.push(daemon.roomDoc.manifestHead.get('Alice')); throw new Error('injected mid-transition failure') }
    await expect(poll(daemon)).rejects.toThrow('injected mid-transition failure')
    expect(during).toMatchObject([{ complete: false }])
    expect((during[0] as { semRev: number }).semRev).toBeGreaterThan(before.semRev)
    // Another publication path (watcher, reshare, salt) must not certify the head while the transition is unfinished.
    await internal.publisher.reconcile('all', false)
    expect(daemon.roomDoc.manifestHead.get('Alice')).toMatchObject({ complete: false, base: w.base })
    expect(git(daemon)).toMatchObject({ head: w.base, rev: 1 })
    internal.reanchorOwnClaims = reanchor
    await poll(daemon)
    expect(git(daemon)).toMatchObject({ head: next, rev: 2 })
    expect(daemon.roomDoc.manifestHead.get('Alice')).toMatchObject({ complete: true, base: w.base })
    // A snapshot already scanning when a transition starts must not certify the head afterwards.
    const inFlight = internal.publisher.prepare() // captures immutable inputs before a transition
    const state = daemon as unknown as { transitionPending: boolean; fence: string; inputs: unknown }
    state.inputs = { ...daemon.inputs }
    state.transitionPending = true // what a transition starting now does before its first await
    markManifestIncomplete(daemon.roomDoc, 'Alice', state.fence)
    expect(internal.publisher.apply(await inFlight, true)).toBe(false)
    expect(daemon.roomDoc.manifestHead.get('Alice')).toMatchObject({ complete: false })
  })

  it('a local room anchors at HEAD: a commit bumps rev once and posts nothing', async () => {
    const w = await world({ local: true })
    const daemon = await w.start()
    const head = commit(w.dir, 'a.txt', 'a\n')
    await poll(daemon)
    await poll(daemon)
    expect(git(daemon)).toMatchObject({ head, base: head, anchored: true, rev: 2 })
    expect(pushed(daemon)).toEqual([])
  })
})

describe('restart: the transition resumes from the surviving record (reporooms §B2, §B4)', () => {
  it('re-anchors own claims from the recorded head', async () => {
    const w = await world()
    const first = await w.start()
    const claim = first.roomDoc.addClaim({ path: 'app.txt', from: 2, to: 2, by: 'Alice', byKind: 'agent', intent: 'edit', claimedHash: claimDigest('first\nclaimed\nlast\n', 2, 2) })
    await first.stop(); daemons.splice(daemons.indexOf(first), 1)
    const head = commit(w.dir, 'app.txt', 'added\nfirst\nclaimed\nlast\n')
    const second = await w.start()
    expect(second.roomDoc.claims.get(claim.id)).toMatchObject({ from: 3, to: 3 })
    expect(git(second)).toMatchObject({ head, rev: 2 })
    expect(second.roomDoc.messages().filter(m => m.type === 'note')).toEqual([])
  })

  it('derives pushed from a surviving record, once, and fabricates none when the record was lost', async () => {
    const w = await world()
    const first = await w.start()
    const local = commit(w.dir, 'a.txt', 'a\n')
    await poll(first)
    const beforePush = Y.encodeStateAsUpdate(w.server)
    await first.stop(); daemons.splice(daemons.indexOf(first), 1)
    sh(w.dir, 'push', '-q', 'origin', 'rehearsal')
    const second = await w.start()
    const id = `pushed:Alice:${w.base}:${local}`
    expect(pushed(second).map(m => m.id)).toEqual([id])
    const notice = pushed(second)[0]
    await second.stop(); daemons.splice(daemons.indexOf(second), 1)

    // A relay crash lost the record's advance but a reader re-synced the notice: the repost is the same ID, seen once.
    const replay = await world()
    Y.applyUpdate(replay.server, beforePush)
    replay.server.getArray<Msg>('bus').push([notice])
    const third = await replay.start({}, w.dir)
    expect(pushed(third).map(m => m.id)).toEqual([id])

    const lost = await world()
    const fourth = await lost.start({}, w.dir)
    expect(git(fourth)).toMatchObject({ base: local, rev: 1 })
    expect(pushed(fourth)).toEqual([])
  })
})

describe('one publisher per checkout (reporooms invariant 11)', () => {
  it('a session publishing under another writes no git record and posts no pushed, but still moves its own claims', async () => {
    vi.stubEnv('ROOM_MACHINE_ID', 'test-machine')
    const w = await world()
    const alice = await w.start()
    const bob = await w.start({ name: 'Bob' })
    expect((bob as unknown as { publishUnder?: string }).publishUnder).toBe('Alice')
    const claim = bob.roomDoc.addClaim({ path: 'app.txt', from: 2, to: 2, by: 'Bob', byKind: 'agent', intent: 'edit', claimedHash: claimDigest('first\nclaimed\nlast\n', 2, 2) })
    const head = commit(w.dir, 'app.txt', 'added\nfirst\nclaimed\nlast\n')
    sh(w.dir, 'push', '-q', 'origin', 'rehearsal')
    await poll(alice)
    await poll(bob)
    expect(git(alice, 'Alice')).toMatchObject({ head, base: head, rev: 2 })
    expect(git(alice, 'Bob')).toBeUndefined()
    expect(pushed(alice).map(m => m.from)).toEqual(['Alice'])
    expect(alice.roomDoc.claims.get(claim.id)).toMatchObject({ from: 3, to: 3 })
  })

  it('a promoted session writes its base facts at once, and a stale record of its own never yields a pushed', async () => {
    vi.stubEnv('ROOM_MACHINE_ID', 'test-machine')
    const w = await world()
    const alice = await w.start()
    const bob = await w.start({ name: 'Bob' })
    await poll(bob)
    expect(git(bob, 'Bob')).toBeUndefined()
    // Alice leaves with no commit or fetch: Bob is promoted and writes his record on the next poll.
    await alice.stop(); daemons.splice(daemons.indexOf(alice), 1)
    await poll(bob)
    expect((bob as unknown as { publishUnder?: string }).publishUnder).toBeUndefined()
    expect(git(bob, 'Bob')).toMatchObject({ head: w.base, base: w.base, anchored: true, rev: 1 })
    // While Bob publishes, a commit is pushed from the checkout: Bob announces it, once.
    const head = commit(w.dir, 'a.txt', 'a\n')
    await poll(bob)
    sh(w.dir, 'push', '-q', 'origin', 'rehearsal')
    await poll(bob)
    expect(pushed(bob).map(m => [m.from, m.fromSha, m.toSha])).toEqual([['Bob', w.base, head]])
    // Alice returns under Bob, then is promoted when Bob leaves: her record from before is stale, not history to announce.
    const back = await w.start()
    expect((back as unknown as { publishUnder?: string }).publishUnder).toBe('Bob')
    await poll(back)
    expect(git(back, 'Alice')).toMatchObject({ head: w.base, rev: 1 })
    await bob.stop(); daemons.splice(daemons.indexOf(bob), 1)
    await poll(back)
    expect((back as unknown as { publishUnder?: string }).publishUnder).toBeUndefined()
    expect(git(back, 'Alice')).toMatchObject({ head, base: head, rev: 2 })
    expect(pushed(back).map(m => m.from)).toEqual(['Bob'])
  })
})
