import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { RoomDoc, digestPath, manifestKey } from '@room/shared'
import { publishManifest, scanManifest } from '../src/manifest-publish.js'

describe('dual manifest publication', () => {
  it('publishes hashless out-of-area changes, exact deletes and digest-only exclusions', () => {
    const room = new RoomDoc()
    room.ensureRoomSalt()
    const input = { room, name: 'ben', fence: 's1', base: 'abc', level: 'declared' as const, prefixes: ['src/'], complete: true }
    publishManifest(input, [
      { path: 'src/app.ts', change: 'M', hash: 'a', size: 4, baseHash: 'b', text: 'test' },
      { path: 'private/x', change: 'M', hash: 'fivebytes', size: 5, baseHash: 'old' },
      { path: 'private/y', change: 'D', baseHash: 'old' },
      { path: 'secret', change: 'M', excluded: true, hash: 'secret-hash', size: 12 },
    ])
    const entries = room.manifest.get(manifestKey('ben', 's1'))!
    expect(entries.get('private/x')).toMatchObject({ change: 'M', state: 'held', held: 'scope', fence: 's1' })
    expect(entries.get('private/x')).not.toHaveProperty('hash')
    expect(entries.get('private/x')).not.toHaveProperty('size')
    expect(entries.get('private/y')).toMatchObject({ change: 'D', state: 'shared' })
    expect(entries.get('private/y')).not.toHaveProperty('baseHash')
    expect(entries.has('secret')).toBe(false)
    expect(room.manifestHead.get('ben')!.excluded).toEqual([digestPath(room.roomSalt!, 'secret')])
    expect(JSON.stringify(room.manifestHead.get('ben'))).not.toContain('secret')
    expect(room.overlays.get('ben')).toBeUndefined() // step 1 leaves legacy publication to the old writer
  })

  it('keeps revisions stable when only the display timestamp changes', () => {
    const room = new RoomDoc()
    room.ensureRoomSalt()
    const input = { room, name: 'ben', fence: 's1', base: 'abc', level: 'declared' as const, prefixes: [], complete: true }
    publishManifest(input, [{ path: 'x', change: 'M', hash: 'a', size: 1, at: 1 }])
    const first = room.manifestHead.get('ben')!
    publishManifest(input, [{ path: 'x', change: 'M', hash: 'b', size: 1, at: 2 }])
    const second = room.manifestHead.get('ben')!
    expect(second.rev).toBe(first.rev)
    expect(second.semRev).toBe(first.semRev)
    expect(room.manifest.get(manifestKey('ben', 's1'))!.get('x')?.at).toBe(2)
  })

  it('gates intent and non-publisher before deletion or exclusion rules', () => {
    const room = new RoomDoc()
    const common = { room, name: 'ben', fence: 's1', base: 'abc', prefixes: [], complete: true }
    const facts = [{ path: 'gone', change: 'D' as const, baseHash: 'old' }, { path: 'secret', change: 'M' as const, excluded: true }]
    const intent = publishManifest({ ...common, level: 'intent' }, facts)
    expect(intent.coverage).toEqual({ kind: 'none', reason: 'intent' })
    expect(intent.excluded).toEqual([])
    expect(room.manifest.get(manifestKey('ben', 's1'))?.size).toBe(0)
    const secondary = publishManifest({ ...common, level: 'full', publisher: 'alice' }, facts)
    expect(secondary.coverage).toEqual({ kind: 'none', reason: 'not-publisher' })
    expect(secondary.excluded).toEqual([])
    expect(room.manifest.get(manifestKey('ben', 's1'))?.size).toBe(0)
  })

  it('keeps the winner incarnation map when a losing writer publishes its own key', () => {
    const room = new RoomDoc()
    const common = { room, name: 'ben', base: 'abc', level: 'full' as const, prefixes: [], complete: true }
    publishManifest({ ...common, fence: 'winner' }, [{ path: 'x', change: 'D' }])
    publishManifest({ ...common, fence: 'loser' }, [{ path: 'y', change: 'D' }])
    expect(room.manifest.get(manifestKey('ben', 'winner'))?.has('x')).toBe(true)
    expect(room.manifest.get(manifestKey('ben', 'winner'))?.has('y')).toBe(false)
    expect(room.manifest.get(manifestKey('ben', 'loser'))?.has('x')).toBe(false)
  })

  it('recomputes excluded digests when a competing room salt wins', () => {
    const a = new RoomDoc(), b = new RoomDoc()
    a.ensureRoomSalt(); b.ensureRoomSalt()
    const input = { room: a, name: 'ben', fence: 's1', base: 'abc', level: 'full' as const, prefixes: [], complete: true }
    publishManifest(input, [{ path: 'secret', change: 'M', excluded: true }])
    const initialSalt = a.roomSalt!
    const before = a.manifestHead.get('ben')!.excluded[0]
    const au = Y.encodeStateAsUpdate(a.doc), bu = Y.encodeStateAsUpdate(b.doc)
    Y.applyUpdate(a.doc, bu); Y.applyUpdate(b.doc, au)
    publishManifest(input, [{ path: 'secret', change: 'M', excluded: true }])
    expect(a.manifestHead.get('ben')!.excluded).toEqual([digestPath(a.roomSalt!, 'secret')])
    if (a.roomSalt !== initialSalt) expect(a.manifestHead.get('ben')!.excluded[0]).not.toBe(before)
  })

  it('scans a real checkout relative to its base without replicating held content facts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-manifest-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
    try {
      git('init', '-q')
      fs.mkdirSync(path.join(dir, 'src'))
      fs.writeFileSync(path.join(dir, 'src/app'), 'base')
      fs.writeFileSync(path.join(dir, 'private'), 'old')
      fs.writeFileSync(path.join(dir, 'gone'), 'gone')
      git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base')
      const base = git('rev-parse', 'HEAD')
      fs.writeFileSync(path.join(dir, 'src/app'), 'shared')
      fs.writeFileSync(path.join(dir, 'private'), 'five!')
      fs.rmSync(path.join(dir, 'gone'))
      const room = new RoomDoc()
      const input = { room, name: 'ben', fence: 's1', base, level: 'declared' as const, prefixes: ['src/'], complete: true }
      const facts = await scanManifest({ ...input, dir, sizeCap: 1024, totalBudget: 1024, safe: () => true })
      publishManifest(input, facts)
      const entries = room.manifest.get(manifestKey('ben', 's1'))!
      expect(entries.get('private')).toMatchObject({ change: 'M', state: 'held', held: 'scope' })
      expect(entries.get('private')).not.toHaveProperty('hash')
      expect(entries.get('private')).not.toHaveProperty('size')
      expect(entries.get('gone')).toMatchObject({ change: 'D', state: 'shared' })
      expect(entries.get('gone')).not.toHaveProperty('baseHash')
      expect(entries.get('src/app')?.hash).toMatch(/^[a-f0-9]{40}$/)
      expect(room.overlays.get(manifestKey('ben', 's1'))).toBeUndefined()
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
