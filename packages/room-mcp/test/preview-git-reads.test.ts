// rc11 all-Codex rehearsal R4: an eight-way worker preview made up to 363 Git calls, re-reading each path's base
// text once per participant that left it unchanged, though every participant shared one base commit.
import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { RoomDoc, gitBlobHash, manifestKey } from '@room/shared'
import type { HandlerState } from '../src/tools/context.js'
import type { Session } from '../src/session.js'
import { hubSeam } from './fixtures/hub.js'

const reads = vi.hoisted(() => [] as string[])
vi.mock('../src/tools/disk-text.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/tools/disk-text.js')>()
  return { ...actual, readBoundedCheckoutText: (dir: string, object: string, ...rest: unknown[]) => {
    reads.push(object)
    return (actual.readBoundedCheckoutText as (...a: unknown[]) => Promise<string | undefined>)(dir, object, ...rest)
  } }
})
import { handlers } from '../src/tools/files.js'

let root: string | undefined
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined; reads.length = 0 })

it('reads each base file once per preview, however many participants left it unchanged', async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-reads-')))
  const git = (...args: string[]) => execFileSync('git', ['-C', root!, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Alice'); git('config', 'user.email', 'alice@example.test')
  const files = ['a.py', 'b.py', 'c.py', 'd.py']
  for (const f of files) fs.writeFileSync(path.join(root, f), `${f} base\n`)
  git('add', '.'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  const room = new RoomDoc()
  room.ensureRoomSalt()
  room.setMeta({ base, branch: 'main', repo: 'demo' })
  const people = ['ben', 'cy', 'di', 'ed']
  for (const [i, person] of people.entries()) {
    room.participants.set(`${person}\0holder`, { sessionId: `${person}-1`, epoch: 1 })
    room.participants.set(`${person}\0git`, { base, head: base, fence: '1', rev: 1 })
    room.manifestHead.set(person, { base, fence: '1', coverage: { kind: 'all' }, level: 'full', excluded: [], rev: 1, semRev: 1, scannedAt: Date.now(), complete: true })
    const entries = new Y.Map<any>(), texts = new Y.Map<Y.Text>()
    room.manifest.set(manifestKey(person, '1'), entries)
    room.overlays.set(manifestKey(person, '1'), texts)
    // Each changes its own file.
    const changed = `${files[i]} by ${person}\n`
    entries.set(files[i], { change: 'M', state: 'shared', hash: gitBlobHash(changed), size: changed.length, at: 1, fence: '1' })
    texts.set(files[i], new Y.Text(changed))
  }
  const awareness = { getStates: () => new Map(people.map((person, i) => [i + 1, { user: { name: person, kind: 'agent' }, sessionId: `${person}-1`, at: Date.now() }])) }
  const session = { dir: root, room, me: { name: 'alice', kind: 'agent' }, roomName: 'git/x/demo', awareness, ...hubSeam(room) } as unknown as Session
  const state = { S: () => session, rooms: { all: () => [session], holding: () => session },
    others: () => people, presences: () => [], myWorkers: () => [], baseFor: () => base, now: () => Date.now() } as unknown as HandlerState
  const preview = await handlers(state).room_preview_merge({ people })
  for (const f of files) expect(preview).toContain(f)
  expect(preview).not.toContain('PARTIAL')
  const baseReads = reads.filter(object => object.startsWith(`${base}:`))
  expect(baseReads.sort()).toEqual(files.map(f => `${base}:${f}`))
})
