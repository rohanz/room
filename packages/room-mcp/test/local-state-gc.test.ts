import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROOM_STALE_MS } from '@room/shared'
import { collectLocalState, GC_RULES, GC_TEMP_AGE_MS } from '../src/local-state-gc.js'
import { withGuard } from '../src/leases.js'

const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR
const now = 1_800_000_000_000
const alive = { startTime: 'fixture-start', executable: 'fixture-node' }
const probe = (pid: number) => pid === 100 ? alive : undefined
const token = (pid: number) => ({ pid, ...alive, sessionId: 's', nonce: `n${pid}` })
function commonDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-gc-'))
  dirs.push(dir)
  return dir
}
const touch = (common: string, rel: string, at: number, content: unknown = {}) => {
  const file = path.join(common, 'room', rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  fs.utimesSync(file, at / 1000, at / 1000)
  return file
}
const left = (common: string) => {
  const out: string[] = []
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { const before = out.length; walk(path.join(dir, e.name), r); if (out.length === before) out.push(`${r}/`) } else out.push(r)
    }
  }
  walk(path.join(common, 'room'), '')
  return out.sort()
}

describe('local state collector', () => {
  it('preserves a live successor of a stale preview publisher guard', () => {
    const c = commonDir(), prefix = 'a'.repeat(64) + '-'
    const guard = touch(c, `preview-evidence/${prefix}publication.guard`, now - 2 * HOUR, token(200))
    const stat = fs.statSync.bind(fs)
    let replaced = false
    vi.spyOn(fs, 'statSync').mockImplementation((...args) => {
      const result = stat(...args)
      if (String(args[0]) === guard && !replaced) {
        replaced = true
        fs.writeFileSync(guard, JSON.stringify(token(100)))
        fs.utimesSync(guard, now / 1000, now / 1000)
      }
      return result
    })
    collectLocalState(c, { now: () => now, probe })
    expect(replaced).toBe(true)
    expect(fs.existsSync(guard)).toBe(true)
    expect(JSON.parse(fs.readFileSync(guard, 'utf8')).pid).toBe(100)
  })
  it('ages out preview evidence and abandoned writes while preserving recent records', () => {
    const c = commonDir()
    touch(c, 'preview-evidence/old.json', now - ROOM_STALE_MS - 1)
    touch(c, 'preview-evidence/recent.json', now - HOUR)
    touch(c, 'preview-evidence/abandoned.tmp', now - GC_TEMP_AGE_MS - 1)
    expect(collectLocalState(c, { now: () => now }).unknown).toEqual([])
    expect(left(c)).toEqual(['preview-evidence/recent.json'])
  })
  it('removes everything the table ages out and keeps every kept, owned or live entry', () => {
    const c = commonDir(), old = now - ROOM_STALE_MS - 1, gone = '/nonexistent/worktree/' + Math.random()
    // keep / owner
    touch(c, 'relay.json', old, { port: 1 }); touch(c, 'hub/incarnation.json', old); touch(c, 'relay/room.ydoc', old, 'bytes'); touch(c, 'relay/migrated-abc.json', old)
    touch(c, 'hub-leases/abc.json', old); touch(c, 'daemon.log', old, 'log'); touch(c, 'daemon.log.1', old, 'log'); touch(c, 'daemon-cutover.json', old)
    touch(c, 'sharing/legacy-baseline.json', old); touch(c, 'registry/workers/w1.json', old); touch(c, 'registry/migration.json', old)
    // ages
    touch(c, 'relay/room.ydoc.1-ab.tmp', now - GC_TEMP_AGE_MS - 1, 'x'); touch(c, 'relay/room.ydoc.2-cd.tmp', now - 60_000, 'x'); touch(c, 'top.roomtmp-p1-s2-n3.tmp', now - 2 * HOUR, 'x')
    touch(c, 'names/dead.json', now - 2 * HOUR, { holder: token(200), worktree: '/w' }); touch(c, 'names/dead-recent.json', now - 10 * 60_000, { holder: token(200) })
    touch(c, 'names/alive.json', now - 2 * HOUR, { holder: token(100) }); touch(c, 'names/unknown.json', now - 2 * HOUR, { holder: token(0) }); touch(c, 'names/garbage.json', now - 2 * HOUR, 'not json')
    touch(c, 'publishers/dead.json', now - 2 * HOUR, { holder: token(200), lastActive: now - 2 * HOUR }); touch(c, 'publishers/dead-active.json', now - 2 * HOUR, { holder: token(200), lastActive: now - 10 * 60_000 })
    touch(c, 'publishers/x.json.guard', now - 2 * HOUR, token(200)); touch(c, 'publishers/y.json.guard', now - 2 * HOUR, token(100))
    touch(c, 'hub/authority.lock', now - 2 * HOUR, token(200))
    touch(c, 'sessions/old/cursor.json', old); touch(c, 'sessions/mixed/cursor.json', old); touch(c, 'sessions/mixed/runtime.json', now - HOUR); touch(c, 'sessions/fresh/cursor.json', now - HOUR)
    touch(c, 'sessions/idle-episode.json', old); touch(c, 'hook-receipts/r1.json', old); touch(c, 'hook-receipts/r2.json', now - HOUR); touch(c, 'hook-receipts/.pruned', old, ''); touch(c, 'hook-receipts/r3.json.1.ab.tmp', now - 2 * HOUR, '')
    touch(c, 'sharing/' + 'a'.repeat(64) + '.json', old, { worktree: gone, updatedAt: old }); touch(c, 'sharing/' + 'b'.repeat(64) + '.json', old, { worktree: c, updatedAt: old }); touch(c, 'sharing/' + 'c'.repeat(64) + '.json', now - HOUR, { worktree: gone, updatedAt: now - HOUR })
    touch(c, 'compat/old.json', now - 31 * DAY); touch(c, 'compat/new.json', now - 29 * DAY)
    touch(c, 'browser/old.html', now - 2 * HOUR, '<html>'); touch(c, 'browser/new.html', now - 60_000, '<html>')
    touch(c, 'profiles/old.cpuprofile', old, '{}'); touch(c, 'profiles/new.cpuprofile', now - HOUR, '{}')
    touch(c, 'registry/quarantine/w.json.bad-1', now - 31 * DAY); touch(c, 'registry/quarantine/w.json.bad-2', now - DAY)
    touch(c, 'storage-gate.json', now - HOUR); touch(c, 'storage-gate/registrations/r.json', now - HOUR); touch(c, 'preflight/x/probe.sqlite', now - HOUR, 'db')
    // unknown
    touch(c, 'mystery.json', old); touch(c, 'mystery-dir/a.json', old); touch(c, 'sessions/stray.json', old)

    const result = collectLocalState(c, { now: () => now, probe })
    expect(result.unknown.sort()).toEqual(['mystery-dir', 'mystery.json', 'sessions/stray.json'])
    expect(left(c)).toEqual([
      'browser/new.html', 'compat/new.json', 'daemon-cutover.json', 'daemon.log', 'daemon.log.1',
      'hook-receipts/r2.json', 'hub-leases/abc.json', 'hub/incarnation.json',
      'mystery-dir/a.json', 'mystery.json',
      'names/alive.json', 'names/dead-recent.json', 'names/garbage.json', 'names/unknown.json',
      'profiles/new.cpuprofile', 'publishers/dead-active.json', 'publishers/y.json.guard',
      'registry/migration.json', 'registry/quarantine/w.json.bad-2', 'registry/workers/w1.json',
      'relay.json', 'relay/migrated-abc.json', 'relay/room.ydoc', 'relay/room.ydoc.2-cd.tmp',
      'sessions/fresh/cursor.json', 'sessions/mixed/cursor.json', 'sessions/mixed/runtime.json', 'sessions/stray.json',
      'sharing/' + 'b'.repeat(64) + '.json', 'sharing/' + 'c'.repeat(64) + '.json', 'sharing/legacy-baseline.json',
    ])
  })

  it('judges without removing in a dry run', () => {
    const c = commonDir()
    touch(c, 'browser/old.html', now - 2 * HOUR, '<html>'); touch(c, 'odd.bin', now, 'x')
    const result = collectLocalState(c, { now: () => now, probe, dryRun: true })
    expect(result.removed.map(p => path.basename(p))).toEqual(['old.html'])
    expect(result.unknown).toEqual(['odd.bin'])
    expect(left(c)).toEqual(['browser/old.html', 'odd.bin'])
  })

  it('tolerates a clone without any Room state directory', () => {
    expect(collectLocalState(commonDir(), { now: () => now, probe })).toEqual({ removed: [], unknown: [] })
  })

  it('documents every rule in docs/reference.md with the same lifetime', () => {
    const doc = fs.readFileSync(path.join(fileURLToPath(new URL('.', import.meta.url)), '../../../docs/reference.md'), 'utf8')
    const table = doc.slice(doc.indexOf('### Local state'), doc.indexOf('\n## ', doc.indexOf('### Local state')))
    const words = { keep: 'keep', owner: 'owner', foreign: 'remove', temp: '1 h', 'dead-holder': 'holder dead', 'session-dir': '7 d', 'orphan-sharing': 'worktree gone' }
    for (const rule of GC_RULES) {
      const row = table.split('\n').find(line => line.includes(`\`${rule.path}\``))
      expect(row, `reference.md Local state table lacks a row for ${rule.path}`).toBeDefined()
      const life = rule.lifetime
      const expected = life.kind === 'age' ? (life.ms % DAY === 0 ? `${life.ms / DAY} d` : `${life.ms / HOUR} h`) : words[life.kind]
      expect(row, `${rule.path}: lifetime ${expected}`).toContain(expected)
      expect(row).toContain(rule.owner)
    }
  })
})
