import { expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, gitBlobHash, manifestKey, validParticipantName, type ManifestEntry } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import { ConflictSet } from '../src/conflict-set.js'
import { closeRegistryForDir, WorkerRegistry } from '../src/worker-registry.js'
import type { Session } from '../src/session.js'
import { hubSeam } from './fixtures/hub.js'

it.each(['R+review notes', 'R+' + 'x'.repeat(65), 'R+review-notes'])('keeps checking conflicts with unrelated valid participant %s', async bystander => {
  expect(validParticipantName(bystander)).toBe(true)
  const dir = mkdtempSync(join(tmpdir(), 'room-family-tag-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'review'); git('config', 'user.email', 'review@example.com')
  writeFileSync(join(dir, 'x'), 'base\n'); git('add', 'x'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD'), room = new RoomDoc()
  const awareness = new Awareness(new Y.Doc())
  const me = { name: 'A', kind: 'agent' as const }
  awareness.setLocalState({ user: me, sessionId: 'session-A' })
  room.ensureRoomSalt()
  for (const [name, text] of [['A', 'alpha\n'], ['B', 'beta\n'], [bystander, undefined]] as const) {
    epochPublication(room, name, base, 1)
    room.participants.set(`${name}\0id`, { name, kind: 'agent' })
    const entries = new Y.Map<ManifestEntry>()
    if (text) entries.set('x', { state: 'shared', change: 'M', hash: gitBlobHash(text), fence: '1', at: 1 })
    room.manifest.set(manifestKey(name, '1'), entries)
    if (text) room.setOverlay(manifestKey(name, '1'), 'x', text)
    room.manifestHead.set(name, { base, fence: '1', coverage: { kind: 'all' }, complete: true,
      level: 'full', excluded: [], rev: 1, semRev: 1, scannedAt: 1 })
  }
  const seam = hubSeam(room)
  const session = { ...seam, dir, room, awareness, me, roomName: 'team/review',
    lease: { fence: () => '1' }, daemon: { fence: '1' }, provider: { synced: true } } as unknown as Session
  const set = new ConflictSet(session, 'A', session, () => {}, 0)
  const reads = vi.spyOn(WorkerRegistry.prototype, 'snapshot')
  try {
    await expect(set.reconcile('unrelated ordinary name')).resolves.toBeUndefined()
    expect(room.messages().filter(m => m.type === 'merge-conflict' && m.to === 'A')).toHaveLength(1)
    expect(reads.mock.calls.some(([query]) => query?.tag === bystander.slice(bystander.indexOf('+') + 1))).toBe(bystander === 'R+review-notes')
  } finally {
    reads.mockRestore(); set.stop(); seam.hub.close(); awareness.destroy(); awareness.doc.destroy(); room.doc.destroy()
    await closeRegistryForDir(dir); rmSync(dir, { recursive: true, force: true })
  }
})
