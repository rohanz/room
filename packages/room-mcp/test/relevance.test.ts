// Read-time relevance (ledger "The one selection function"): replaces roomd's markIntegratedBaseNotices.
import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BaseMsg, NoteMsg, PushedMsg } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { Ledger } from '../src/ledger.js'
import { createRelevance } from '../src/relevance.js'
import { memorySession } from './fixtures/session.js'
import { visiblePeer } from './fixtures/visible.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim()

it('a pushed or base notice already in HEAD is not owed and gets no receipt; one not in HEAD is owed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-relevance-')); dirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'commit', '--allow-empty', '-qm', 'one')
  const integrated = git(dir, 'rev-parse', 'HEAD')
  const s = memorySession({ name: 'Pat', kind: 'agent' }, dir)
  visiblePeer(s.room, 'Ben')
  s.room.setOverlay('Pat', 'a.txt', 'work in progress\n')
  const ledger = new Ledger({ sessionId: () => 'session', route: () => ({}), relevant: createRelevance() })
  ledger.bind(s)
  const ben = { name: 'Ben', kind: 'agent' as const }
  const pushedIn = hubAppend<PushedMsg>(s.room, ben, { type: 'pushed', branch: 'main', upstream: 'origin/main', fromSha: '0'.repeat(40), toSha: integrated, commits: 1, paths: [], summary: 'one' })
  const baseIn = hubAppend<BaseMsg>(s.room, ben, { type: 'base', base: integrated, prev: '0'.repeat(40), commits: 1, paths: [], summary: 'one' })
  const missing = 'f'.repeat(40)
  const pushedOut = hubAppend<PushedMsg>(s.room, ben, { type: 'pushed', branch: 'main', upstream: 'origin/main', fromSha: integrated, toSha: missing, commits: 1, paths: [], summary: 'two' })
  const owed = ledger.candidates(s).map(m => m.id)
  expect(owed).not.toContain(pushedIn.id)
  expect(owed).not.toContain(baseIn.id)
  expect(owed).toContain(pushedOut.id)
  expect(s.room.seen('Pat').size).toBe(0)
})

it('the ancestry answer follows the observed HEAD: a reset before B owes it again, and moving forward hides it at once (S1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-relevance-')); dirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'commit', '--allow-empty', '-qm', 'A')
  const a = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'commit', '--allow-empty', '-qm', 'B')
  const b = git(dir, 'rev-parse', 'HEAD')
  const s = memorySession({ name: 'Pat', kind: 'agent' }, dir)
  visiblePeer(s.room, 'Ben')
  const daemon = s.daemon as { base: string }
  daemon.base = b
  const ledger = new Ledger({ sessionId: () => 'session', route: () => ({}), relevant: createRelevance() })
  ledger.bind(s)
  const notice = hubAppend<PushedMsg>(s.room, { name: 'Ben', kind: 'agent' }, { type: 'pushed', branch: 'main', upstream: 'origin/main', fromSha: a, toSha: b, commits: 1, paths: [], summary: 'B' })
  expect(ledger.candidates(s).map(m => m.id)).not.toContain(notice.id)
  git(dir, 'reset', '-q', '--hard', a); daemon.base = a
  expect(ledger.candidates(s).map(m => m.id)).toContain(notice.id)
  git(dir, 'reset', '-q', '--hard', b); daemon.base = b
  expect(ledger.candidates(s).map(m => m.id)).not.toContain(notice.id)
  expect(s.room.seen('Pat').size).toBe(0)
})

it('rechecks B after a reset to A when the daemon never observed B (S1 re-review)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-relevance-')); dirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'commit', '--allow-empty', '-qm', 'A')
  const a = git(dir, 'rev-parse', 'HEAD')
  const s = memorySession({ name: 'Pat', kind: 'agent' }, dir)
  visiblePeer(s.room, 'Ben')
  ;(s.daemon as { base: string }).base = a
  const ledger = new Ledger({ sessionId: () => 'session', route: () => ({}), relevant: createRelevance() })
  ledger.bind(s)
  git(dir, 'commit', '--allow-empty', '-qm', 'B')
  const b = git(dir, 'rev-parse', 'HEAD')
  const notice = hubAppend<PushedMsg>(s.room, { name: 'Ben', kind: 'agent' }, { type: 'pushed', branch: 'main', upstream: 'origin/main', fromSha: a, toSha: b, commits: 1, paths: [], summary: 'B' })
  expect(ledger.candidates(s).map(m => m.id)).not.toContain(notice.id)
  git(dir, 'reset', '-q', '--hard', a)
  expect(ledger.candidates(s).map(m => m.id)).toContain(notice.id)
  git(dir, 'reset', '-q', '--hard', b)
  expect(ledger.candidates(s).map(m => m.id)).not.toContain(notice.id)
})

it('a Room 0.16 "you switched to B" branch note already in a bus is never owed, on any branch (rc7)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-relevance-')); dirs.push(dir)
  const s = memorySession({ name: 'Pat', kind: 'agent' }, dir)
  const ledger = new Ledger({ sessionId: () => 'session', route: () => ({}), relevant: createRelevance() })
  ledger.bind(s)
  const room = { name: 'room', kind: 'bot' as const }
  const text = "you switched to main; the room is for other; commits here are not the room's base until they are pushed to other"
  const notes = Array.from({ length: 13 }, () => hubAppend<NoteMsg>(s.room, room, { type: 'note', to: 'Pat', priority: 'notify', text }))
  // A local migration before rc7 could replace Room's name with an ambiguous-name placeholder.
  const placeholder = hubAppend<NoteMsg>(s.room, { name: '?0123456789abcdef', kind: 'bot' }, { type: 'note', to: 'Pat', priority: 'notify', text })
  const forged = hubAppend<NoteMsg>(s.room, { name: 'Ben', kind: 'agent' }, { type: 'note', to: 'Pat', priority: 'notify', text })
  const release = hubAppend<NoteMsg>(s.room, room, { type: 'note', to: 'Pat', priority: 'notify', text: 'released your claim on a.py:1-2: that code changed in abcdef0123' })
  for (const branch of ['main', 'other']) {
    ;(s.daemon as { branch: string }).branch = branch
    const owed = ledger.candidates(s).map(m => m.id)
    for (const note of [...notes, placeholder]) expect(owed).not.toContain(note.id)
    expect(owed).toContain(forged.id)
    expect(owed).toContain(release.id)
  }
  expect(s.room.seen('Pat').size).toBe(0)
})
