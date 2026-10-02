// rc11 all-Codex rehearsal R1: a team-room worker on room/<tag> in a single-branch clone has no remote-tracking
// ref to anchor to (no upstream, no <remote>/room/<tag>, no <remote>/HEAD). Its base fell back to HEAD, unanchored,
// so its manifest never completed ("updating after a commit") and a commit emptied its overlay.
import { manifestKey, participantRecord } from '@room/shared'
import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import { policyFromLevel } from '../src/policy.js'
import { startRoomd, type Roomd } from '../src/index.js'
import { pollHead } from './poll-head.js'

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
const provider = (doc: Y.Doc) => {
  let local: unknown = null
  return { synced: true, awareness: { setLocalState(value: unknown) { local = value }, getLocalState: () => local, getStates: () => new Map([[doc.clientID, local]]) }, on() {}, off() {}, destroy() {} } as unknown as WebsocketProvider
}
let root: string | undefined
let daemon: Roomd | undefined
afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** A lead clone on r17 tracking origin/r17 (no origin/HEAD, as `git clone --single-branch`), and a worker worktree on room/w. */
function singleBranchClone(withRemoteHead = false) {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-worker-anchor-')))
  const lead = path.join(root, 'lead')
  fs.mkdirSync(lead)
  git(lead, 'init', '-q', '-b', 'r17')
  git(lead, 'config', 'user.email', 'test@example.com'); git(lead, 'config', 'user.name', 'Test')
  git(lead, 'remote', 'add', 'origin', 'https://github.com/acme/app.git')
  fs.writeFileSync(path.join(lead, 'app.txt'), 'one\ntwo\nthree\n')
  git(lead, 'add', '-A'); git(lead, 'commit', '-qm', 'base')
  const base = git(lead, 'rev-parse', 'HEAD')
  git(lead, 'update-ref', 'refs/remotes/origin/r17', base)
  git(lead, 'config', 'branch.r17.remote', 'origin'); git(lead, 'config', 'branch.r17.merge', 'refs/heads/r17')
  if (withRemoteHead) {
    // An older default branch: its merge-base with the worker is behind the worker's spawn base.
    git(lead, 'update-ref', 'refs/remotes/origin/main', base)
    git(lead, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  }
  const worker = path.join(lead, '.room', 'workers', 'w')
  git(lead, 'worktree', 'add', '-q', '-b', 'room/w', worker, base)
  return { lead, worker, base }
}

async function startWorker(worker: string, base: string) {
  daemon = await startRoomd({ policy: policyFromLevel('full'), dir: worker, room: 'ws://memory/github.com%2Facme%2Fapp', name: 'ana+w',
    providerFactory: (_s, _n, doc) => provider(doc), basePollMs: 60_000, trackedRefreshMs: 60_000, reconcileIntervalMs: 0, log: () => {},
    carried: { name: 'ana+w', dir: worker, base } })
  return daemon
}

const head = (d: Roomd) => d.roomDoc.manifestHead.get('ana+w')!
const entries = (d: Roomd) => [...d.roomDoc.manifest.get(manifestKey('ana+w', head(d).fence))?.keys() ?? []].sort()

it('a team-room worker with no remote anchor publishes a complete manifest against its spawn base', async () => {
  const { worker, base } = singleBranchClone()
  const d = await startWorker(worker, base)
  expect(head(d)).toMatchObject({ base, complete: true, coverage: { kind: 'all' } })
  expect(participantRecord(d.roomDoc, 'ana+w')?.git).toMatchObject({ base, anchored: true })
})

it('a worker commit keeps its committed change in its overlay and the manifest complete', async () => {
  const { worker, base } = singleBranchClone()
  const d = await startWorker(worker, base)
  fs.writeFileSync(path.join(worker, 'app.txt'), 'one\nTWO\nthree\n')
  git(worker, 'commit', '-qam', 'worker change')
  fs.writeFileSync(path.join(worker, 'new.txt'), 'uncommitted\n')
  await pollHead(d)
  await d.reconcileGitChanges()
  expect(head(d)).toMatchObject({ base, complete: true, coverage: { kind: 'all' } })
  expect(entries(d)).toEqual(['app.txt', 'new.txt'])
  expect(d.roomDoc.overlayText(manifestKey('ana+w', head(d).fence), 'app.txt')?.toString()).toBe('one\nTWO\nthree\n')
})

it('a worker spawned on an unpushed carry commit anchors to the newest remote commit under it', async () => {
  const { lead, worker, base } = singleBranchClone()
  // Room's carry commit holds the lead's uncommitted edits: it is on no remote, so teammates elsewhere cannot fetch it.
  git(worker, 'commit', '-q', '--allow-empty', '-m', 'room: carried-in uncommitted work from ana')
  const carry = git(worker, 'rev-parse', 'HEAD')
  expect(git(lead, 'branch', '-r', '--contains', carry)).toBe('')
  const d = await startWorker(worker, carry)
  expect(head(d)).toMatchObject({ base, complete: true })
  expect(participantRecord(d.roomDoc, 'ana+w')?.git).toMatchObject({ base, anchored: true })
})

it('a worker spawned on an unpushed commit after the remote moved on anchors to their shared ancestor', async () => {
  const { lead, worker, base } = singleBranchClone()
  // origin/r17 gained a commit the lead fetched but did not merge; the lead committed locally and spawned.
  git(lead, 'commit', '-q', '--allow-empty', '-m', 'pushed by someone else')
  git(lead, 'update-ref', 'refs/remotes/origin/r17', 'HEAD')
  git(lead, 'reset', '-q', '--hard', base)
  git(worker, 'commit', '-q', '--allow-empty', '-m', 'unpushed lead commit')
  const spawnBase = git(worker, 'rev-parse', 'HEAD')
  const d = await startWorker(worker, spawnBase)
  expect(head(d)).toMatchObject({ base, complete: true })
})

it('a worker whose remote anchor is older than its spawn base uses the spawn base', async () => {
  const { lead, worker } = singleBranchClone(true)
  // The lead moved on (pushed to origin/r17 only) before spawning: the default branch is behind the spawn base.
  fs.writeFileSync(path.join(lead, 'lead.txt'), 'lead work\n')
  git(lead, 'add', '-A'); git(lead, 'commit', '-qm', 'lead work')
  const spawnBase = git(lead, 'rev-parse', 'HEAD')
  git(lead, 'update-ref', 'refs/remotes/origin/r17', spawnBase)
  git(worker, 'reset', '-q', '--hard', spawnBase)
  const d = await startWorker(worker, spawnBase)
  expect(head(d)).toMatchObject({ base: spawnBase, complete: true })
  expect(entries(d)).toEqual([])
})
