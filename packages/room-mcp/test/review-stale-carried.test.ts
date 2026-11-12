import { expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { RoomDoc, gitBlobHash, manifestKey } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import type { Baseline } from '@room/roomd/baseline'
import { ConflictSet, slotKey } from '../src/conflict-set.js'
import type { Session } from '../src/session.js'

it.each(['W', 'L', 'committed', 'missing', 'oversized'])('checks carried baseline scenario %s before the first comparison', async scenario => {
  const dir = mkdtempSync(join(tmpdir(), 'review-stale-carried-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  git('init', '-qb', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@test')
  git('commit', '-qm', 'initial', '--allow-empty')
  const sha = git('rev-parse', 'HEAD'), path = 'carried.txt', base = 'one\ntwo\nthree\n'
  writeFileSync(join(dir, path), scenario === 'oversized' ? 'a'.repeat(512 * 1024 + 1) : base)
  const blob = git('hash-object', '-w', path)
  const baseline: Baseline = { worker: 'W', sha, dir, carriedCommit: false, untracked: new Map([[path, { sha: scenario === 'missing' ? '0'.repeat(40) : blob }]]) }
  const room = new RoomDoc(); room.ensureRoomSalt()
  const states = new Map(), post = vi.fn(async () => ({ ok: true }))
  for (const name of ['W', 'L']) {
    epochPublication(room, name, sha, 1)
    room.participants.set(`${name}\0id`, { name, kind: 'agent' })
    states.set(name, { user: { name, kind: 'agent' }, sessionId: `session-${name}` })
    room.manifestHead.set(name, { base: sha, fence: '1', coverage: { kind: 'all' }, level: 'full', excluded: [], rev: 1, semRev: 1, scannedAt: 1, complete: true })
    const entries = new Y.Map<any>(); room.manifest.set(manifestKey(name, '1'), entries)
    // The worker publisher knows its carried baseline and emits D. The ordinary
    // lead has no carried baseline: deleting its untracked addition leaves no entry.
    if (name !== scenario) {
      const text = base.replace('two', `changed by ${name}`)
      entries.set(path, { change: 'A', state: 'shared', hash: gitBlobHash(text), at: 1, fence: '1' })
      room.setOverlay(manifestKey(name, '1'), path, text)
    } else if (name === 'W') entries.set(path, { change: 'D', state: 'shared', at: 1, fence: '1' })
  }
  if (scenario === 'committed') {
    // The lead has promoted this same carried path into its tracked tree.
    writeFileSync(join(dir, path), base.replace('two', 'changed by L'))
    git('add', path); git('commit', '-qm', 'lead committed carried path')
    const tip = git('rev-parse', 'HEAD')
    room.manifest.get(manifestKey('L', '1'))!.delete(path)
    room.clearOverlay(manifestKey('L', '1'), path)
    room.manifestHead.set('L', { ...room.manifestHead.get('L')!, base: tip })
    room.participants.set('L\0git', { ...room.participants.get('L\0git')!, base: tip, head: tip })
  }
  const session = { room, awareness: { getStates: () => states }, provider: { synced: true, on() {}, off() {} }, me: { name: 'L', kind: 'agent' }, dir, post, lease: { fence: () => '1' } } as unknown as Session
  const set = new ConflictSet(session, 'L', session, () => {}, 0, person => person === 'W' ? { baseline, lead: 'L' } : undefined)
  try {
    await set.reconcile('delete versus modify of carried work')
    expect(room.doc.getMap('conflicts').get(slotKey('L', 'merge', 'W', path))).toMatchObject({ status: ['missing', 'oversized'].includes(scenario) ? 'unknown' : 'conflict' })
    if (!['missing', 'oversized'].includes(scenario)) expect(post.mock.calls.length).toBeGreaterThan(0)
  } finally { set.stop(); room.doc.destroy(); rmSync(dir, { recursive: true, force: true }) }
})
