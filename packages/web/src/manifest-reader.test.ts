import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc, digestPath, gitBlobHash, manifestKey, type ManifestEntry } from '@room/shared'
import { browserBlobHash, readWebVersion, webChangerLabels, webCoverage } from './manifest-reader.ts'

function roomWith(name = 'Ben') {
  const room = new RoomDoc()
  const fence = '1', base = 'base-1'
  room.participants.set(`${name}\0holder`, { sessionId: 'fixture-session', epoch: 1, pid: 1, startTime: '', executable: '', at: 1 })
  room.participants.set(`${name}\0git`, { branch: 'main', head: base, base, anchored: true, rev: 1, fence })
  room.manifestHead.set(name, { base, fence, level: 'declared', coverage: { kind: 'all' }, excluded: [], rev: 1, semRev: 1, scannedAt: 1, complete: true, textPrefixes: ['src/'] })
  const entries = new Y.Map<ManifestEntry>()
  room.manifest.set(manifestKey(name, fence), entries)
  return { room, entries, name, fence, base }
}

describe('git-less manifest reader', () => {
  it('uses the same Git blob IDs as Node for empty and non-ASCII text', async () => {
    for (const value of ['', 'hello\n', '雪❄️ café\n']) {
      expect(await browserBlobHash(value, 'sha1')).toBe(gitBlobHash(value, 'sha1'))
      expect(await browserBlobHash(value, 'sha256')).toBe(gitBlobHash(value, 'sha256'))
    }
  })
  it('does not turn absent base text into an empty file or an unchanged version', async () => {
    const { room, name } = roomWith()
    try {
      expect(await readWebVersion(room, name, 'src/unchanged.ts', [])).toMatchObject({ kind: 'unknown', why: 'no-base-text' })
    } finally { room.doc.destroy() }
  })

  it('reports hashless declared changes as held and partial', async () => {
    const { room, entries, name, fence } = roomWith()
    try {
      entries.set('config.ts', { change: 'M', state: 'held', held: 'scope', at: 1, fence })
      expect(await readWebVersion(room, name, 'config.ts', [])).toMatchObject({ kind: 'held', why: 'scope' })
      expect(webCoverage(room, name)).toMatchObject({ complete: false, gaps: [{ path: 'config.ts' }] })
      expect(webChangerLabels(room, 'config.ts')).toEqual(['Ben (not shared: outside declared area; text not shared)'])
    } finally { room.doc.destroy() }
  })

  it('reads shared text and its base from the current incarnation', async () => {
    const { room, entries, name, fence, base } = roomWith()
    try {
      const text = 'changed\n'
      entries.set('src/app.ts', { change: 'M', state: 'shared', hash: gitBlobHash(text), at: 1, fence })
      const overlay = new Y.Map<Y.Text>()
      room.overlays.set(manifestKey(name, fence), overlay)
      overlay.set('src/app.ts', new Y.Text(text))
      room.setBaseText(name, base, 'src/app.ts', 'original\n')
      expect(await readWebVersion(room, name, 'src/app.ts', [])).toMatchObject({ kind: 'text', text })
      expect(webCoverage(room, name)).toMatchObject({ complete: true, gaps: [] })
    } finally { room.doc.destroy() }
  })

  it('marks an excluded-only or intent participant partial even with no named files', () => {
    const { room, name } = roomWith()
    try {
      room.manifestHead.set(name, { ...room.manifestHead.get(name)!, excluded: ['digest'] })
      expect(webCoverage(room, name)).toMatchObject({ complete: false, gaps: [{ path: undefined }] })
      room.manifestHead.set(name, { ...room.manifestHead.get(name)!, coverage: { kind: 'none', reason: 'intent' }, excluded: [] })
      expect(webCoverage(room, name)).toMatchObject({ complete: false, gaps: [{ path: undefined }] })
    } finally { room.doc.destroy() }
  })

  it('matches a browser path digest without revealing the excluded path in the manifest', async () => {
    const { room, name } = roomWith()
    try {
      const salt = room.ensureRoomSalt()
      room.manifestHead.set(name, { ...room.manifestHead.get(name)!, excluded: [digestPath(salt, 'secrets/key.txt')] })
      expect(await readWebVersion(room, name, 'secrets/key.txt', [])).toMatchObject({ kind: 'excluded' })
      expect(JSON.stringify(room.manifestHead.get(name))).not.toContain('secrets/key.txt')
    } finally { room.doc.destroy() }
  })
})
