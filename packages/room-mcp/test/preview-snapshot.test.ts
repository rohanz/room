import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { afterEach, expect, it, vi } from 'vitest'
import * as gitModule from '@room/roomd/git'
import { RoomDoc, gitBlobHash, manifestKey } from '@room/shared'
import { handlers } from '../src/tools/files.js'
import type { HandlerState } from '../src/tools/context.js'
import type { Session } from '../src/session.js'
import { hubSeam } from './fixtures/hub.js'

let root: string | undefined
afterEach(() => { vi.restoreAllMocks(); if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined })

function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-snapshot-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root!, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Ana'); git('config', 'user.email', 'ana@example.test')
  fs.writeFileSync(path.join(root, 'ben.txt'), 'base\n')
  fs.writeFileSync(path.join(root, 'chris.txt'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  const room = new RoomDoc(); room.ensureRoomSalt(); room.setMeta({ base, branch: 'main', repo: 'demo' })
  const publish = (person: string, rev: number, content: string) => room.doc.transact(() => {
    room.participants.set(`${person}\0holder`, { sessionId: `${person}-1`, epoch: 1 })
    room.participants.set(`${person}\0git`, { base, head: base, fence: '1', rev })
    room.manifestHead.set(person, { base, fence: '1', coverage: { kind: 'all' }, level: 'full', excluded: [], rev, semRev: rev, scannedAt: Date.now(), complete: true })
    const entries = new Y.Map<any>(), texts = new Y.Map<Y.Text>()
    const rel = `${person}.txt`
    entries.set(rel, { change: 'M', state: 'shared', hash: gitBlobHash(content), size: Buffer.byteLength(content), at: rev, fence: '1' })
    texts.set(rel, new Y.Text(content))
    room.manifest.set(manifestKey(person, '1'), entries)
    room.overlays.set(manifestKey(person, '1'), texts)
  })
  publish('ben', 1, 'snapshot\n'); publish('chris', 7, 'stable\n')
  const session = { dir: root, room, me: { name: 'ana', kind: 'agent' }, roomName: 'local/demo/main',
    awareness: { getStates: () => new Map(['ben', 'chris'].map((name, i) => [i + 1, { user: { name, kind: 'agent' }, sessionId: `${name}-1`, at: Date.now() }])) },
    ...hubSeam(room),
  } as unknown as Session
  let offset = 0
  const state = { S: () => session, rooms: { all: () => [session], holding: () => session },
    others: () => ['ben', 'chris'], presences: () => ['ben', 'chris'].map(name => ({ user: { name, kind: 'agent' } })),
    myWorkers: () => [], baseFor: () => base, now: () => Date.now() + offset,
    ctx: { sleep: async (ms: number) => { offset += ms; await new Promise<void>(resolve => setImmediate(resolve)) } },
  } as unknown as HandlerState
  return { room, session, state, publish, base, preview: handlers(state).room_preview_merge }
}

async function waitForFile(file: string) {
  for (let i = 0; i < 500 && !fs.existsSync(file); i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(fs.existsSync(file), `command did not start: ${file}`).toBe(true)
}

it.each([{ passed: true, label: 'passing' }, { passed: false, label: 'failing' }])('reports a $label snapshot after a peer publishes during the command', async ({ passed }) => {
  const { room, session, preview, publish, base } = fixture()
  const marker = path.join(root!, 'entered'), release = path.join(root!, 'release'), runs = path.join(root!, 'runs')
  const run = `echo run >> '${runs}'; touch '${marker}'; while ! test -e '${release}'; do sleep 0.05; done; test "$(cat ben.txt)" = snapshot && test "$(cat chris.txt)" = stable && echo "1 ${passed ? 'passed' : 'failed'}"${passed ? '' : '; exit 1'}`
  const pending = preview({ people: ['ben', 'chris'], run })
  try {
    await waitForFile(marker)
    publish('ben', 2, 'latest\n')
    // A passing snapshot must also clear evidence left by an earlier passing preview.
    session.lastPreview = { clean: true, complete: true, testsPassed: true }
  } finally { fs.writeFileSync(release, 'go') }
  const reply = await pending
  expect(reply).toContain(`SNAPSHOT result for "${run}" (not the current combined code):`)
  expect(reply).toContain(`snapshot inputs: ana (local working tree, base ${base.slice(0, 10)}), ben (rev 1, base ${base.slice(0, 10)}), chris (rev 7, base ${base.slice(0, 10)})`)
  expect(reply).toContain(`snapshot tests: ${passed ? 'PASSED (exit 0)' : 'FAILED (exit 1)'}`)
  expect(reply).toContain('preview coverage: complete for selected participants')
  expect(reply).toContain(`command completion: finished (exit ${passed ? 0 : 1})`)
  expect(reply).toContain('ben moved since this snapshot was built. A pass is interim evidence for the recorded revisions.')
  expect(reply).toContain(`Re-run room_preview_merge with run="${run}" when your files change, a moved peer can affect this command, a failure needs confirmation, or for the final current preview before room_done.`)
  expect(reply).toContain('The latest combined code was NOT checked')
  expect(reply).not.toContain('chris moved since')
  expect(reply).not.toContain('rev 2')
  expect(fs.readFileSync(runs, 'utf8')).toBe('run\n')
  expect(session.lastPreview).toEqual({ clean: false, complete: false, testsPassed: false, testsCommand: run })
  expect(room.messages().some(m => m.type === 'note' && m.text.startsWith('merge preview with'))).toBe(false)
})

it('names every participant that moved, retaining the revisions actually tested', async () => {
  const { preview, publish } = fixture()
  const marker = path.join(root!, 'entered'), release = path.join(root!, 'release')
  const pending = preview({ people: ['ben', 'chris'], run: `touch '${marker}'; while ! test -e '${release}'; do sleep 0.05; done; echo "1 passed"` })
  try {
    await waitForFile(marker)
    publish('ben', 2, 'latest\n'); publish('chris', 8, 'latest too\n')
  } finally { fs.writeFileSync(release, 'go') }
  const reply = await pending
  expect(reply).toContain('ben (rev 1, base ')
  expect(reply).toContain('chris (rev 7, base ')
  expect(reply).toContain('ben, chris moved since this snapshot was built')
})

it('keeps current passing previews eligible for room_done evidence', async () => {
  const { session, preview } = fixture()
  const run = 'test "$(cat ben.txt)" = snapshot && echo "1 passed"'
  const reply = await preview({ person: 'ben', run })
  expect(reply).toContain('tests: PASSED (exit 0)')
  expect(reply).not.toContain('SNAPSHOT result')
  expect(reply).toContain('snapshot inputs: ana (local working tree, base ')
  expect(reply).toContain('preview coverage: complete for selected participants')
  expect(reply).toMatch(/snapshot inputs sha256: [a-f0-9]{64}/)
  expect(reply).toContain(`command: ${JSON.stringify(run)}`)
  expect(reply).toContain(`environment: ${process.platform}/${process.arch}, Node ${process.version}`)
  expect(reply).toContain('linked dependencies are not fingerprinted')
  expect(reply).toContain('command completion: finished (exit 0)')
  expect(session.lastPreview).toEqual({ clean: true, complete: true, testsPassed: true, partialPassed: false, testsCommand: run })
})

it('reports stable source identities only for matching preview inputs, without caching tests', async () => {
  const { preview, publish } = fixture()
  const run = 'cat ben.txt; echo "1 passed"'
  const identity = (reply: string) => reply.match(/snapshot inputs sha256: ([a-f0-9]{64})/)?.[1]
  const first = identity(await preview({ person: 'ben', run }))
  expect(first).toBeDefined()
  expect(identity(await preview({ person: 'ben', run }))).toBe(first)
  publish('ben', 2, 'changed\n')
  expect(identity(await preview({ person: 'ben', run }))).not.toBe(first)
})

it('keeps a partial tree visibly incomplete even when its command passes', async () => {
  const { preview, room, session } = fixture()
  room.overlays.delete(manifestKey('ben', '1'))
  const reply = await preview({ people: ['ben', 'chris'], run: 'echo "1 passed"' })
  expect(reply).toContain('preview coverage: PARTIAL; combined work not verified')
  expect(reply).toContain('command completion: finished (exit 0)')
  expect(reply).toContain('snapshot inputs sha256:')
  expect(session.lastPreview?.testsPassed).toBe(false)
})

it('still settles and rebuilds when a revision changes during tree construction', async () => {
  const { session, state, preview, publish, base } = fixture()
  let moved = false
  state.baseFor = () => {
    if (!moved) { moved = true; publish('ben', 2, 'latest\n') }
    return base
  }
  const reply = await preview({ person: 'ben', run: 'test "$(cat ben.txt)" = latest && echo "1 passed"' })
  expect(moved).toBe(true)
  expect(reply).toContain('rev 2')
  expect(reply).toContain('tests: PASSED (exit 0)')
  expect(reply).not.toContain('SNAPSHOT result')
  expect(session.lastPreview?.testsPassed).toBe(true)
})

it('keeps construction retries bounded and never runs a command on an unsettled build', async () => {
  const { session, state, preview, publish, base } = fixture()
  let rev = 1, waited = 0
  state.baseFor = () => { publish('ben', ++rev, 'moving\n'); return base }
  state.now = () => waited
  state.ctx!.sleep = async ms => { waited += ms; publish('ben', ++rev, 'moving\n') }
  const marker = path.join(root!, 'must-not-run')
  const reply = await preview({ person: 'ben', run: `touch '${marker}'; echo "1 passed"` })
  expect(reply).toBe('ben moved during the preview; re-run. The combined code was NOT fully checked')
  expect(fs.existsSync(marker)).toBe(false)
  expect(waited).toBe(12_000)
  expect(session.lastPreview).toMatchObject({ clean: false, complete: false, testsPassed: false })
})

it('rebuilds a snapshot that moved after construction before starting the command', async () => {
  const { room, state, preview, publish, base } = fixture()
  const runs = path.join(root!, 'runs')
  // anchorsFor awaits this remote-anchor lookup after buildCombinedTree has captured its inputs.
  room.participants.set('ben\0git', { ...room.participants.get('ben\0git')!, upstream: 'origin/main', ahead: 0 })
  // Give Ben a distinct published commit so anchorsFor actually performs the lookup.
  const peer = execFileSync('git', ['-C', root!, 'commit-tree', `${base}^{tree}`, '-p', base, '-m', 'peer anchor'], { encoding: 'utf8' }).trim()
  room.participants.set('ben\0git', { ...room.participants.get('ben\0git')!, base: peer, head: peer })
  room.manifestHead.set('ben', { ...room.manifestHead.get('ben')!, base: peer })
  state.baseFor = (_session, person) => person === 'ben' ? room.participants.get('ben\0git')!.base as string : base
  const realGit = gitModule.git
  let moved = false
  vi.spyOn(gitModule, 'git').mockImplementation(async (dir, args) => {
    if (!moved && args.includes('refs/remotes/origin/main')) { moved = true; publish('ben', 2, 'latest\n') }
    return realGit(dir, args)
  })
  const reply = await preview({ person: 'ben', run: `echo run >> '${runs}'; test "$(cat ben.txt)" = latest && echo "1 passed"` })
  expect(moved).toBe(true)
  expect(reply).toContain('tests: PASSED (exit 0)')
  expect(reply).not.toContain('SNAPSHOT result')
  expect(fs.readFileSync(runs, 'utf8')).toBe('run\n')
})
