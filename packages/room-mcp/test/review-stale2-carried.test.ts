import { expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { RoomDoc, gitBlobHash, manifestKey, type ManifestEntry } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import type { Baseline } from '@room/roomd/baseline'
import { ConflictSet, slotKey } from '../src/conflict-set.js'
import type { Session } from '../src/session.js'

it.each(['both-delete', '1999-carried', '2000-carried'] as const)('checks carried candidate control %s', async scenario => {
  const dir = mkdtempSync(join(tmpdir(), 'review-stale2-carried-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  git('init', '-qb', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@test')
  git('commit', '-qm', 'initial', '--allow-empty')
  const sha = git('rev-parse', 'HEAD'), path = 'x', base = 'one\ntwo\nthree\n'
  writeFileSync(join(dir, path), base)
  const blob = git('hash-object', '-w', path)
  const count = scenario === 'both-delete' ? 1 : Number(scenario.split('-')[0])
  const untracked = new Map(Array.from({ length: count }, (_, i) => [i ? `carried-${i}` : path, { sha: blob }]))
  const baseline: Baseline = { worker: 'W', sha, dir, carriedCommit: false, untracked }
  const room = new RoomDoc(); room.ensureRoomSalt()
  const states = new Map(), post = vi.fn(async () => ({ ok: true }))
  for (const name of ['W', 'L']) {
    epochPublication(room, name, sha, 1)
    room.participants.set(`${name}\0id`, { name, kind: 'agent' })
    states.set(name, { user: { name, kind: 'agent' }, sessionId: `session-${name}` })
    room.manifestHead.set(name, { base: sha, fence: '1', coverage: { kind: 'all' }, level: 'full', excluded: [], rev: 1, semRev: 1, scannedAt: 1, complete: true })
    const entries = new Y.Map<ManifestEntry>(); room.manifest.set(manifestKey(name, '1'), entries)
    if (name === 'W') {
      if (scenario === 'both-delete') entries.set(path, { change: 'D', state: 'shared', at: 1, fence: '1' })
      else {
        const text = base.replace('two', 'worker modification')
        entries.set(path, { change: 'M', state: 'shared', hash: gitBlobHash(text), at: 1, fence: '1' })
        room.setOverlay(manifestKey(name, '1'), path, text)
      }
    }
  }
  const session = { room, awareness: { getStates: () => states }, provider: { synced: true, on() {}, off() {} }, me: { name: 'L', kind: 'agent' }, dir, post, lease: { fence: () => '1' } } as unknown as Session
  const set = new ConflictSet(session, 'L', session, () => {}, 0, person => person === 'W' ? { baseline, lead: 'L' } : undefined)
  try {
    const start = performance.now(); await set.reconcile(scenario)
    const slots = room.doc.getMap<{ status: string; why?: string }>('conflicts')
    if (scenario === '2000-carried') expect(slots.get(slotKey('L', 'merge', 'W', '*'))).toMatchObject({ status: 'unknown', why: 'too many changed paths to compare' })
    else expect(slots.get(slotKey('L', 'merge', 'W', path))).toMatchObject({ status: scenario === 'both-delete' ? 'clean' : 'conflict' })
    console.log(JSON.stringify({ scenario, elapsedMs: performance.now() - start, slots: slots.size }))
  } finally { set.stop(); room.doc.destroy(); rmSync(dir, { recursive: true, force: true }) }
})
