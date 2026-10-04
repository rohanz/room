import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc, digestPath, gitBlobHash, manifestKey, manifestHeadOf, memorySnapshot, participantRecord, participantsView, type ManifestEntry, type WorkerView } from '@room/shared'
import { browserBlobHash, readWebVersion, webChangerLabels, webCoverage, manifestPeople } from './manifest-reader.ts'
import { epochPublication } from '@room/shared/testing'

function roomWith(name = 'Ben') {
  const room = new RoomDoc()
  room.ensureRoomSalt()
  const fence = '1', base = 'base-1'
  epochPublication(room, name, base, 1, 'fixture-session')
  room.manifestHead.set(name, { base, fence, level: 'declared', coverage: { kind: 'all' }, excluded: [], rev: 1, semRev: 1, scannedAt: 1, complete: true, textPrefixes: ['src/'] })
  const entries = new Y.Map<ManifestEntry>()
  room.manifest.set(manifestKey(name, fence), entries)
  return { room, entries, name, fence, base }
}

describe('git-less manifest reader', () => {
  it('reads cached worker files and base text after restart only while the lead confirms the run', async () => {
    const { room, entries, name, fence, base } = roomWith('lead+worker')
    const view: WorkerView = { id: 'w1', name, tag: 'worker', lead: 'lead', mode: 'here', host: 'codex', task: 'test', branch: 'worker', status: 'done', run: 1, startedAt: 1, finishedAt: 2, fence: '9' }
    room.workerViews.set(view.id, view)
    room.participants.set(`${name}\0holder`, { ...participantRecord(room, name)!.holder, workerId: view.id })
    entries.set('src/file.ts', { change: 'M', state: 'shared', hash: gitBlobHash('after\n'), at: 1, fence })
    entries.set('private.ts', { change: 'M', state: 'held', held: 'scope', at: 1, fence })
    room.setOverlay(manifestKey(name, fence), 'src/file.ts', 'after\n')
    room.setBaseText(name, base, 'src/file.ts', 'before\n')
    const restored = new RoomDoc()
    try {
      Y.applyUpdate(restored.doc, memorySnapshot(room.doc))
      expect(manifestPeople(restored)).not.toContain(name)
      restored.participants.set('lead\0holder', { sessionId: 'lead-session', epoch: 9 })
      restored.workerViews.set(view.id, view)
      expect(manifestPeople(restored)).toContain(name)
      expect(await readWebVersion(restored, name, 'src/file.ts', () => [])).toMatchObject({ kind: 'text', text: 'after\n' })
      expect(manifestHeadOf(restored, name)?.base).toBe(base)
      expect(restored.baseText(name, base, 'src/file.ts')).toBe('before\n')
      expect(webChangerLabels(restored, 'private.ts')).toEqual([`${name} (not shared: outside declared area; text not shared)`])
      expect(webCoverage(restored, name, []).held).toEqual(['private.ts'])
      restored.workerViews.delete(view.id)
      expect(await readWebVersion(restored, name, 'src/file.ts', () => [])).toMatchObject({ kind: 'unknown' })
    } finally { restored.doc.destroy(); room.doc.destroy() }
  })

  it('converts only the selected overlay for repeated one-path reads', async () => {
    const { room, entries, name, fence } = roomWith()
    const overlay = new Y.Map<Y.Text>()
    room.overlays.set(manifestKey(name, fence), overlay)
    for (let i = 0; i < 1000; i++) {
      const path = `src/file-${i}.ts`, text = `value ${i}\n`
      entries.set(path, { change: 'M', state: 'shared', hash: gitBlobHash(text), at: 1, fence })
      overlay.set(path, new Y.Text(text))
    }
    const spy = vi.spyOn(Y.Text.prototype as { toString(): string }, 'toString')
    try {
      for (let i = 0; i < 1000; i++)
        expect(await readWebVersion(room, name, `src/file-${i}.ts`, () => [])).toMatchObject({ kind: 'text' })
      expect(spy).toHaveBeenCalledTimes(1000)
    } finally { spy.mockRestore(); room.doc.destroy() }
  })
  it('computes coverage without converting a thousand overlay texts', () => {
    const { room, entries, name, fence } = roomWith()
    const overlay = new Y.Map<Y.Text>()
    room.overlays.set(manifestKey(name, fence), overlay)
    for (let i = 0; i < 1000; i++) {
      const p = `src/file-${i}.ts`
      entries.set(p, { change: 'M', state: 'shared', at: 1, fence })
      overlay.set(p, new Y.Text('text'))
    }
    const spy = vi.spyOn(Y.Text.prototype as { toString(): string }, 'toString')
    try {
      expect(webCoverage(room, name).shared).toHaveLength(1000)
      expect(spy).toHaveBeenCalledTimes(0)
    } finally { spy.mockRestore(); room.doc.destroy() }
  })
  it('uses the same Git blob IDs as Node for empty and non-ASCII text', async () => {
    for (const value of ['', 'hello\n', '雪❄️ café\n']) {
      expect(await browserBlobHash(value, 'sha1')).toBe(gitBlobHash(value, 'sha1'))
      expect(await browserBlobHash(value, 'sha256')).toBe(gitBlobHash(value, 'sha256'))
    }
  })
  it('does not turn absent base text into an empty file or an unchanged version', async () => {
    const { room, name } = roomWith()
    try {
      expect(await readWebVersion(room, name, 'src/unchanged.ts', () => [])).toMatchObject({ kind: 'unknown', why: 'no-base-text' })
    } finally { room.doc.destroy() }
  })

  it('reports hashless declared changes as held and partial', async () => {
    const { room, entries, name, fence } = roomWith()
    try {
      entries.set('config.ts', { change: 'M', state: 'held', held: 'scope', at: 1, fence })
      expect(await readWebVersion(room, name, 'config.ts', () => [])).toMatchObject({ kind: 'held', why: 'scope' })
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
      expect(await readWebVersion(room, name, 'src/app.ts', () => [])).toMatchObject({ kind: 'text', text })
      expect(webCoverage(room, name)).toMatchObject({ complete: true, gaps: [] })
    } finally { room.doc.destroy() }
  })

  it('rejects a projected read when its lead changes epoch during the browser digest', async () => {
    const { room, entries, name, fence } = roomWith('worker')
    const text = 'changed\n'
    entries.set('src/app.ts', { change: 'M', state: 'shared', hash: gitBlobHash(text), at: 1, fence })
    room.overlays.set(manifestKey(name, fence), new Y.Map<Y.Text>([['src/app.ts', new Y.Text(text)]]))
    room.participants.set('lead\0holder', { sessionId: 'lead-session', epoch: 1 })
    room.manifestHead.set(name, { ...room.manifestHead.get(name)!, projectedBy: 'lead', projectedFrom: 'worker-id' })
    const awareness = { getStates: () => new Map([[1, { user: { name: 'lead', kind: 'agent' }, sessionId: 'lead-session', at: Date.now() }]]) }
    const view = () => participantsView(room, awareness as never, Date.now())
    const original = crypto.subtle.digest.bind(crypto.subtle)
    let moved = false
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
      if (!moved) { moved = true; room.participants.set('lead\0holder', { sessionId: 'new-lead', epoch: 2 }) }
      return original(...args)
    })
    try { expect(await readWebVersion(room, name, 'src/app.ts', view)).toMatchObject({ kind: 'unknown' }) }
    finally { spy.mockRestore(); room.doc.destroy() }
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

  it('names the publisher for a healthy non-publisher without reporting an update', () => {
    const { room, name } = roomWith()
    try {
      room.participants.delete(`${name}\0git`)
      room.manifestHead.set(name, { ...room.manifestHead.get(name)!, coverage: { kind: 'none', reason: 'not-publisher' }, publisher: 'Ada' })
      const gaps = webCoverage(room, name).gaps.map(gap => gap.why)
      expect(gaps).toEqual([expect.stringContaining('Ada')])
      expect(gaps.join(' ')).not.toContain('updating')
    } finally { room.doc.destroy() }
  })

  it('matches a browser path digest without revealing the excluded path in the manifest', async () => {
    const { room, name } = roomWith()
    try {
      const salt = room.ensureRoomSalt()
      room.manifestHead.set(name, { ...room.manifestHead.get(name)!, excluded: [digestPath(salt, 'secrets/key.txt')] })
      expect(await readWebVersion(room, name, 'secrets/key.txt', () => [])).toMatchObject({ kind: 'excluded' })
      expect(JSON.stringify(room.manifestHead.get(name))).not.toContain('secrets/key.txt')
    } finally { room.doc.destroy() }
  })
  it.each([undefined, 'malformed'])('keeps browser coverage incomplete with invalid room salt %s', async salt => {
    const { room, name } = roomWith()
    try {
      if (salt === undefined) room.metaMap.delete('roomSalt')
      else room.metaMap.set('roomSalt', salt)
      expect(await readWebVersion(room, name, 'secret.txt', () => [])).toMatchObject({ kind: 'unknown', why: 'updating' })
      expect(webCoverage(room, name)).toMatchObject({ complete: false, gaps: [expect.objectContaining({ why: expect.stringContaining('room salt') })] })
    } finally { room.doc.destroy() }
  })
})
