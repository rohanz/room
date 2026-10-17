import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { RoomDoc, manifestKey, participantRecord, snapshotMetadata } from '@room/shared'
import { Awareness } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd, type Roomd } from '@room/roomd'
import { policyFromLevel } from '@room/roomd/policy'
import type { Session } from '../src/session.js'
import { acknowledgeKeptPublication, keptPublicationMatches } from '../src/kept-publication.js'
import { publishFixture, deleteFixture } from './fixtures/manifest.js'

const hashReadHook = vi.hoisted(() => ({ after: undefined as undefined | (() => void) }))
vi.mock('@room/roomd/git', async importOriginal => {
  const actual = await importOriginal<typeof import('@room/roomd/git')>()
  return { ...actual, git: async (...args: Parameters<typeof actual.git>) => {
    const result = await actual.git(...args)
    if (args[1][0] === 'hash-object') hashReadHook.after?.()
    return result
  } }
})

const roots: string[] = [], rooms: RoomDoc[] = [], daemons: Roomd[] = []
afterEach(async () => { hashReadHook.after = undefined; for (const daemon of daemons.splice(0)) await daemon.stop(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); for (const room of rooms.splice(0)) room.doc.destroy() })
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-kept-publication-'))); roots.push(dir)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Lead'); git('config', 'user.email', 'lead@example.test')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'before a\n'); fs.writeFileSync(path.join(dir, 'b.txt'), 'before b\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD'), room = new RoomDoc(); rooms.push(room); room.setMeta({ base })
  const write = (p: string, text: string) => fs.writeFileSync(path.join(dir, p), text)
  const publish = (p: string, text?: string) => {
    if (text === undefined) deleteFixture(room, 'lead', p, { base }); else publishFixture(room, 'lead', p, text, { base })
    room.participants.set('lead\0git', { ...room.participants.get('lead\0git')!, head: base })
  }
  const full = async () => { for (const p of ['a.txt', 'b.txt']) publish(p, fs.existsSync(path.join(dir, p)) ? fs.readFileSync(path.join(dir, p), 'utf8') : undefined) }
  const s = { dir, room, me: { name: 'lead' }, awareness: { getStates: () => new Map() },
    daemon: { fence: '1', reconcileGitChanges: full, settle: async () => {} } } as unknown as Session
  return { dir, room, s, write, publish, full }
}

it('acknowledges the post-application scan after an in-flight stale scan, not its later revision alone', async () => {
  const t = fixture(), stale = deferred(), requested = deferred()
  let queue = stale.promise.then(() => t.publish('a.txt', 'before a\n'))
  t.s.daemon.reconcileGitChanges = () => { requested.resolve(); return queue = queue.then(t.full) }
  t.write('a.txt', 'after a\n')
  const pending = acknowledgeKeptPublication(t.s, undefined, ['a.txt'], [{ p: 'a.txt', after: Buffer.from('after a\n') }])
  await requested.promise
  stale.resolve()
  const proof = await pending
  expect(proof.pending).toBe(false)
  expect(keptPublicationMatches(t.s, proof)).toBe(true)
  expect(t.room.text('a.txt', 'lead')).toBe('after a\n')
})

it('does not accept a resolved reconciliation that retained a complete but stale publication', async () => {
  const t = fixture(); await t.full()
  t.write('a.txt', 'after a\n'); t.s.daemon.reconcileGitChanges = async () => {}
  const proof = await acknowledgeKeptPublication(t.s, undefined, ['a.txt'], [{ p: 'a.txt', after: Buffer.from('after a\n') }])
  expect(proof).toEqual({ paths: ['a.txt'], pending: true })
  expect(keptPublicationMatches(t.s, proof)).toBe(false)
})

it('retains the earlier pending barrier across a second keep and clears it only with a verified full scan', async () => {
  const t = fixture(); await t.full()
  t.write('a.txt', 'after a\n'); t.s.daemon.reconcileGitChanges = async () => {}
  const first = await acknowledgeKeptPublication(t.s, undefined, ['a.txt'])
  t.write('b.txt', 'after b\n'); t.s.daemon.reconcileGitChanges = async () => { t.publish('b.txt', 'after b\n') }
  const second = await acknowledgeKeptPublication(t.s, first, ['b.txt'])
  expect(second).toEqual({ paths: ['a.txt', 'b.txt'], pending: true })
  t.s.daemon.reconcileGitChanges = t.full
  const third = await acknowledgeKeptPublication(t.s, second, [])
  expect(third.pending).toBe(false)
  expect(keptPublicationMatches(t.s, third)).toBe(true)
})

it('compares the captured preview generation, not a newer live generation that appeared later', async () => {
  const t = fixture(); await t.full()
  const before = snapshotMetadata(t.room, 'lead', [])!
  t.write('a.txt', 'after a\n')
  const proof = await acknowledgeKeptPublication(t.s, undefined, ['a.txt'])
  expect(keptPublicationMatches(t.s, proof)).toBe(true)
  expect(keptPublicationMatches(t.s, proof, before)).toBe(false)
})

it('requires a new acknowledgement after holder/fence replacement even if the content is identical', async () => {
  const t = fixture(); t.write('a.txt', 'after a\n')
  const first = await acknowledgeKeptPublication(t.s, undefined, ['a.txt'])
  t.room.participants.set('lead\0holder', { ...participantRecord(t.room, 'lead')!.holder!, sessionId: 'replacement', epoch: 2 })
  t.s.daemon.fence = '2'; await t.full()
  expect(keptPublicationMatches(t.s, first)).toBe(false)
  const next = await acknowledgeKeptPublication(t.s, first, [])
  expect(next.pending).toBe(false)
  expect(keptPublicationMatches(t.s, next)).toBe(true)
})

it('keeps timeout, unavailable publisher and unshared content explicit without blocking collection', async () => {
  const t = fixture(); t.s.daemon.reconcileGitChanges = () => new Promise(() => {})
  expect((await acknowledgeKeptPublication(t.s, undefined, ['a.txt'], [], 10)).pending).toBe(true)
  t.s.daemon.reconcileGitChanges = async () => {
    await t.full()
    const head = t.room.manifestHead.get('lead')!
    const entries = t.room.manifest.get(manifestKey('lead', head.fence))!
    entries.set('a.txt', { ...entries.get('a.txt')!, state: 'held', held: 'scope', hash: undefined })
  }
  expect((await acknowledgeKeptPublication(t.s, undefined, ['a.txt'])).pending).toBe(true)
  const head = t.room.manifestHead.get('lead')!
  t.room.manifestHead.set('lead', { ...head, coverage: { kind: 'none', reason: 'not-publisher' }, publisher: 'someone-else' })
  expect((await acknowledgeKeptPublication(t.s, undefined, ['a.txt'])).pending).toBe(true)
})

it('acknowledges legitimate post-delivery removal on retry without treating arbitrary new hashes as proof', async () => {
  const t = fixture(); t.write('a.txt', 'delivery\n')
  const first = await acknowledgeKeptPublication(t.s, undefined, ['a.txt'])
  fs.rmSync(path.join(t.dir, 'a.txt'))
  const next = await acknowledgeKeptPublication(t.s, first, [])
  expect(next.pending).toBe(false)
  expect(t.room.manifest.get(manifestKey('lead', next.ack!.fence))!.get('a.txt')!.change).toBe('D')
})

it('bounds verification metadata and never clears an overflowed pending barrier', async () => {
  const t = fixture()
  const first = await acknowledgeKeptPublication(t.s, undefined, Array.from({ length: 2001 }, (_, i) => `p${i}`))
  expect(first.pending).toBe(true); expect(first.overflow).toBe(true); expect(first.paths.length).toBe(2000)
  expect((await acknowledgeKeptPublication(t.s, first, [])).pending).toBe(true)
})

it('binds a publication acknowledgement to the exact delivered baseline', async () => {
  const t = fixture(); t.write('a.txt', 'delivery\n')
  const proof = await acknowledgeKeptPublication(t.s, undefined, ['a.txt'])
  const base = participantRecord(t.room, 'lead')!.git!.base
  expect(keptPublicationMatches(t.s, { ...proof, base }, undefined, base)).toBe(true)
  expect(keptPublicationMatches(t.s, { ...proof, base }, undefined, 'b'.repeat(40))).toBe(false)
  expect(keptPublicationMatches(t.s, proof, undefined, base)).toBe(false)
})

it('does not reuse a publication generation after the room document is replaced', async () => {
  const t = fixture(); t.write('a.txt', 'delivery\n')
  const proof = await acknowledgeKeptPublication(t.s, undefined, ['a.txt'])
  expect(keptPublicationMatches(t.s, proof)).toBe(true)
  t.room.doc.getMap('meta').set('roomSalt', 'f'.repeat(64))
  expect(keptPublicationMatches(t.s, proof)).toBe(false)
})

it('verifies a held binary delivery by its permitted raw-byte hash', async () => {
  const t = fixture(), bytes = Buffer.from([0xff, 0x00, 0x7f])
  fs.writeFileSync(path.join(t.dir, 'a.txt'), bytes)
  t.s.daemon.reconcileGitChanges = async () => {
    await t.full()
    const entries = t.room.manifest.get(manifestKey('lead', '1'))!
    entries.set('a.txt', { ...entries.get('a.txt')!, state: 'held', held: 'binary', hash: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') })
  }
  const proof = await acknowledgeKeptPublication(t.s, undefined, ['a.txt'], [{ p: 'a.txt', after: bytes }])
  expect(proof.pending).toBe(false)
})

it('uses the publisher raw CRLF hash under autocrlf without accepting a stale absent overlay', async () => {
  const t = fixture()
  execFileSync('git', ['-C', t.dir, 'config', 'core.autocrlf', 'true'])
  const bytes = Buffer.from('before a\r\n'); fs.writeFileSync(path.join(t.dir, 'a.txt'), bytes)
  expect(execFileSync('git', ['-C', t.dir, 'diff', '--name-only'], { encoding: 'utf8' })).toBe('')
  // roomd disk-scan hashes raw bytes and publishes them when they differ from
  // the LF baseline even when Git's filtered diff is clean.
  const proof = await acknowledgeKeptPublication(t.s, undefined, ['a.txt'], [{ p: 'a.txt', after: bytes }])
  expect(proof.pending).toBe(false)
  t.room.manifest.get(manifestKey('lead', '1'))!.delete('a.txt')
  t.s.daemon.reconcileGitChanges = async () => {}
  const changed = Buffer.from('uncommitted change\r\n'); fs.writeFileSync(path.join(t.dir, 'a.txt'), changed)
  expect((await acknowledgeKeptPublication(t.s, undefined, ['a.txt'], [{ p: 'a.txt', after: changed }])).pending).toBe(true)
})

it('briefly coalesces pending retries but recovers in the same holder and revision after the backoff', async () => {
  const t = fixture(); await t.full(); t.write('a.txt', 'after a\n')
  const scan = vi.fn(async () => {}); t.s.daemon.reconcileGitChanges = scan
  const before = performance.now(), clock = vi.spyOn(performance, 'now').mockReturnValue(before)
  try {
    const first = await acknowledgeKeptPublication(t.s, undefined, ['a.txt'])
    expect(first.pending).toBe(true)
    t.s.daemon.reconcileGitChanges = t.full
    expect((await acknowledgeKeptPublication(t.s, first, [])).pending).toBe(true)
    clock.mockReturnValue(before + 1001)
    expect((await acknowledgeKeptPublication(t.s, first, [])).pending).toBe(false)
  } finally { clock.mockRestore() }
})

async function realPublisherFixture() {
  const t = fixture()
  const git = (...args: string[]) => execFileSync('git', ['-C', t.dir, ...args], { encoding: 'utf8' }).trim()
  git('config', 'core.autocrlf', 'true')
  t.write('a.txt', 'committed delivery\n'); git('add', 'a.txt'); git('commit', '-qm', 'commit delivered content')
  const base = git('rev-parse', 'HEAD')
  t.write('a.txt', 'committed delivery\r\n')
  expect(git('diff', '--name-only', base)).toBe('')
  vi.stubEnv('ROOM_MACHINE_ID', 'kept-publication-test')
  const daemon = await startRoomd({ dir: t.dir, name: 'lead', room: 'ws://memory/local/test', policy: policyFromLevel('full'),
    sessionId: 'real-publisher-fixture', lease: () => '1', carried: { name: 'lead', dir: t.dir, base },
    basePollMs: 0, trackedRefreshMs: 60_000, reconcileIntervalMs: 0, log: () => {},
    providerFactory: (_server, _room, doc) => {
      // Transport seam grants the publisher's lease; disk/Git scan and manifest
      // generation are the real daemon implementation. No socket is opened.
      doc.getMap('participants').set('lead\0holder', { sessionId: 'real-publisher-fixture', epoch: 1 })
      return { synced: true, awareness: new Awareness(doc), on() {}, off() {},
        destroy() { this.awareness.destroy() } } as unknown as WebsocketProvider
    },
  })
  daemons.push(daemon)
  ;(daemon as Roomd & { watcher: { suspend(): void } }).watcher.suspend()
  const s = { ...t.s, daemon, room: daemon.roomDoc, awareness: daemon.provider.awareness } as Session
  await daemon.reconcileGitChanges(); await daemon.settle()
  const head = s.room.manifestHead.get('lead')!
  expect(head.complete, JSON.stringify({head,record:participantRecord(s.room,'lead')})).toBe(true)
  expect(s.room.manifest.get(manifestKey('lead', head.fence))?.has('a.txt')).toBe(false)
  return { ...t, room: s.room, s, git, base }
}

it.each(['retry', 'spawn'])('acknowledges Git-clean committed CRLF input absent from the real publisher manifest on %s', async mode => {
  const t = await realPublisherFixture()
  const previous = mode === 'retry' ? { paths: ['a.txt'], pending: true } : undefined
  const proof = await acknowledgeKeptPublication(t.s, previous, mode === 'spawn' ? ['a.txt'] : [])
  expect(proof.pending).toBe(false)
  expect(keptPublicationMatches(t.s, proof)).toBe(true)
  expect(t.room.manifest.get(manifestKey('lead', proof.ack!.fence))!.has('a.txt')).toBe(false)
  expect(fs.readFileSync(path.join(t.dir, 'a.txt'), 'utf8')).toBe('committed delivery\r\n')
})

it('refuses a resolved stale real-publisher scan when absent CRLF content is Git-dirty', async () => {
  const t = await realPublisherFixture(), changed = Buffer.from('uncommitted change\r\n')
  fs.writeFileSync(path.join(t.dir, 'a.txt'), changed)
  t.s.daemon.reconcileGitChanges = async () => {}
  const proof = await acknowledgeKeptPublication(t.s, undefined, ['a.txt'], [{ p: 'a.txt', after: changed }])
  expect(proof.pending).toBe(true)
  expect(keptPublicationMatches(t.s, proof)).toBe(false)
})

it('does not use Git-clean absence to acknowledge fixed after-images that differ from current disk bytes', async () => {
  const t = await realPublisherFixture()
  const proof = await acknowledgeKeptPublication(t.s, undefined, ['a.txt'], [{ p: 'a.txt', after: Buffer.from('missing delivery\r\n') }])
  expect(proof.pending).toBe(true)
})

it('rechecks exact CRLF bytes after filtered hashing before accepting Git-clean absence', async () => {
  const t = await realPublisherFixture()
  const afterHash = vi.fn(() => t.write('a.txt', 'changed after filtered hash\r\n'))
  hashReadHook.after = afterHash
  const proof = await acknowledgeKeptPublication(t.s, undefined, ['a.txt'])
  expect(afterHash).toHaveBeenCalledOnce()
  expect(proof.pending).toBe(true)
  expect(keptPublicationMatches(t.s, proof)).toBe(false)
})
