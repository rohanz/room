import { clearFixture, deleteFixture, publishFixture, setFixtureLocalRoot } from './fixtures/manifest.js'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomDoc, digestPath, manifestKey } from '@room/shared'
import { setParticipantBase } from '@room/shared/testing'
import { GraphIndex } from '../src/graph-index.js'
import { gitShow } from '@room/roomd/git'
import * as Y from 'yjs'

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition not met before timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

let dir: string, base: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-graph-events-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  writeFileSync(join(dir, 'utils.py'), 'def validate_token(t):\n    return t\n')
  git('add', '.'); git('commit', '-qm', 'init'); base = git('rev-parse', 'HEAD').trim()
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  execFileSync('git', ['-C', dir, 'reset', '--hard', 'HEAD'], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, 'clean', '-fd'], { stdio: 'pipe' })
})

describe('GraphIndex overlay events', () => {
  it('N1 republishes provenance after a body-only edit and a non-source revision, including recovery from incomplete coverage', async () => {
    const room = new RoomDoc()
    room.setMeta({ base }); setFixtureLocalRoot(room, 'Rohan', dir)
    writeFileSync(join(dir, 'utils.py'), 'def validate_token(t):\n    return t\n')
    publishFixture(room, 'Rohan', 'utils.py', 'def validate_token(t):\n    return t\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    try {
      gi.start(); await gi.whenIdle()
      await eventually(() => room.graphs.get('Rohan')?.status === 'ready' && room.graphs.get('Rohan')?.sourceRev === room.manifestHead.get('Rohan')?.rev)
      const original = room.graphs.get('Rohan')!
      writeFileSync(join(dir, 'utils.py'), 'def validate_token(t):\n    return t + 1\n')
      publishFixture(room, 'Rohan', 'utils.py', 'def validate_token(t):\n    return t + 1\n')
      await gi.whenIdle()
      await eventually(() => room.graphs.get('Rohan')?.status === 'ready' && room.graphs.get('Rohan')?.sourceRev === room.manifestHead.get('Rohan')?.rev)
      expect(room.graphs.get('Rohan')?.edges).toEqual(original.edges)
      publishFixture(room, 'Rohan', 'README.md', 'documentation changed\n')
      await gi.whenIdle()
      await eventually(() => room.graphs.get('Rohan')?.status === 'ready' && room.graphs.get('Rohan')?.sourceRev === room.manifestHead.get('Rohan')?.rev)
      expect(room.graphs.get('Rohan')?.paths).toEqual(original.paths)
      const head = room.manifestHead.get('Rohan')!
      room.manifestHead.set('Rohan', { ...head, rev: head.rev + 1, complete: false })
      await gi.whenIdle()
      const restored = room.manifestHead.get('Rohan')!
      room.manifestHead.set('Rohan', { ...restored, rev: restored.rev + 1, complete: true })
      await gi.whenIdle()
      await eventually(() => room.graphs.get('Rohan')?.status === 'ready' && room.graphs.get('Rohan')?.sourceRev === room.manifestHead.get('Rohan')?.rev)
      expect(room.graphs.get('Rohan')?.paths).toEqual(original.paths)
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('M2 withdraws a signature synchronously when its path becomes excluded', async () => {
    const room = new RoomDoc()
    room.setMeta({ base }); setFixtureLocalRoot(room, 'Rohan', dir)
    writeFileSync(join(dir, 'utils.py'), 'def validate_token(t, secret_customer):\n    return t\n')
    publishFixture(room, 'Rohan', 'utils.py', 'def validate_token(t, secret_customer):\n    return t\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0 })
    try {
      gi.start(); await gi.whenIdle()
      await eventually(() => JSON.stringify(room.graphs.get('Rohan')).includes('secret_customer'))
      const head = room.manifestHead.get('Rohan')!, key = manifestKey('Rohan', head.fence)
      room.doc.transact(() => {
        room.manifest.get(key)!.delete('utils.py')
        room.clearOverlay(key, 'utils.py')
        room.manifestHead.set('Rohan', { ...head, excluded: [digestPath(room.ensureRoomSalt(), 'utils.py')], rev: head.rev + 1, semRev: head.semRev + 1 })
      })
      expect(JSON.stringify(room.graphs.get('Rohan'))).not.toContain('secret_customer')
      expect(room.graphs.get('Rohan')?.paths).not.toContain('utils.py')
      await gi.whenIdle()
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(room.graphs.get('Rohan')?.paths).not.toContain('utils.py')
    } finally { gi.stop(); room.doc.destroy() }
  })
  it('M2 withdraws an already published signature on a holder-only replacement', async () => {
    const room = new RoomDoc()
    room.setMeta({ base }); setFixtureLocalRoot(room, 'Rohan', dir)
    publishFixture(room, 'Rohan', 'utils.py', 'def validate_token(t, secret_customer):\n    return t\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0 })
    try {
      gi.start(); await gi.whenIdle()
      await eventually(() => JSON.stringify(room.graphs.get('Rohan')).includes('secret_customer'))
      const holder = room.participants.get('Rohan\u0000holder')!
      room.participants.set('Rohan\u0000holder', { ...holder, epoch: holder.epoch + 1, sessionId: 'replacement' })
      expect(JSON.stringify(room.graphs.get('Rohan'))).not.toContain('secret_customer')
      const fresh = new RoomDoc()
      Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(room.doc))
      expect(JSON.stringify(fresh.graphs.get('Rohan'))).not.toContain('secret_customer')
      fresh.doc.destroy()
    } finally { gi.stop(); room.doc.destroy() }
  })

  it.each(['full', 'declared'] as const)('publishes a fenced %s deletion observation to fresh readers', async level => {
    const repo = mkdtempSync(join(tmpdir(), 'room-delete-graph-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString()
    const room = new RoomDoc()
    try {
      git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
      writeFileSync(join(repo, 'api.py'), 'def call(a):\n    return a\n')
      git('add', '.'); git('commit', '-qm', 'base')
      const commit = git('rev-parse', 'HEAD').trim()
      room.setMeta({ base: commit }); setFixtureLocalRoot(room, 'B', repo)
      publishFixture(room, 'B', 'api.py', 'def call(a):\n    return a\n', { base: commit })
      publishFixture(room, 'A', 'consumer.py', 'from api import call\ncall(1)\n', { base: commit })
      if (level === 'declared') {
        const head = room.manifestHead.get('B')!
        room.manifestHead.set('B', { ...head, level, textPrefixes: ['api.py'], rev: head.rev + 1 })
      }
      const gi = new GraphIndex(room, 'B', repo, undefined, { random: () => 0, minPublishMs: 0 })
      try {
        gi.start(); await gi.whenIdle()
        await eventually(() => room.graphs.get('B')?.status === 'ready' && room.graphs.get('B')!.edges.some(e => e.source === 'api.py' && e.target === 'consumer.py'))
        deleteFixture(room, 'B', 'api.py', { base: commit })
        if (level === 'declared') {
          const head = room.manifestHead.get('B')!
          room.manifestHead.set('B', { ...head, level, textPrefixes: ['api.py'], rev: head.rev + 1 })
        }
        await gi.whenIdle()
        await eventually(() => room.graphs.get('B')?.status === 'ready' && room.graphs.get('B')?.sourceRev === room.manifestHead.get('B')?.rev)
        const fresh = new RoomDoc()
        try {
          Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(room.doc))
          const graph = fresh.graphs.get('B')!
          expect(graph.paths).not.toContain('api.py')
          expect(graph.observed).toContainEqual(expect.objectContaining({ path: 'api.py', symbol: 'call', kind: 'delete' }))
        } finally { fresh.doc.destroy() }
      } finally { gi.stop() }
    } finally { room.doc.destroy(); rmSync(repo, { recursive: true, force: true }) }
  })

  it.each(['outside declared area', 'invalid entry fence'] as const)('withholds symbol detail for a deletion with %s', async reason => {
    const room = new RoomDoc()
    room.setMeta({ base }); setFixtureLocalRoot(room, 'Rohan', dir)
    publishFixture(room, 'Rohan', 'utils.py', 'def validate_token(t):\n    return t\n')
    const head = room.manifestHead.get('Rohan')!
    room.manifestHead.set('Rohan', { ...head, level: reason === 'outside declared area' ? 'declared' : 'full',
      textPrefixes: reason === 'outside declared area' ? [] : undefined, rev: head.rev + 1 })
    deleteFixture(room, 'Rohan', 'utils.py')
    const narrowed = room.manifestHead.get('Rohan')!
    if (reason === 'invalid entry fence') {
      const entries = room.manifest.get(manifestKey('Rohan', narrowed.fence))!
      entries.set('utils.py', { ...entries.get('utils.py')!, fence: 'wrong' })
    } else {
      const entries = room.manifest.get(manifestKey('Rohan', narrowed.fence))!
      entries.set('utils.py', { ...entries.get('utils.py')!, state: 'held', held: 'scope' })
      room.manifestHead.set('Rohan', { ...narrowed, level: 'declared', textPrefixes: [], rev: narrowed.rev + 1 })
    }
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    try {
      gi.start(); await gi.whenIdle()
      await eventually(() => room.graphs.get('Rohan')?.status === 'ready')
      const fresh = new RoomDoc()
      try {
        Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(room.doc))
        expect(JSON.stringify(fresh.graphs.get('Rohan'))).not.toContain('validate_token')
      } finally { fresh.doc.destroy() }
    } finally { gi.stop(); room.doc.destroy() }
  })

  it.each(['holder', 'git'] as const)('withdraws a peer-sourced edge synchronously on a %s-only fence change', async field => {
    const room = graphRoom()
    publishFixture(room, 'Kieran', 'remote.py', 'def remote_only():\n    pass\n')
    publishFixture(room, 'Rohan', 'consumer.py', 'from remote import remote_only\nremote_only()\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    try {
      gi.start(); await gi.whenIdle()
      await eventually(() => room.graphs.get('Rohan')?.status === 'ready' && room.graphs.get('Rohan')!.edges.some(e => e.source === 'remote.py'))
      await new Promise(resolve => setTimeout(resolve, 200))
      if (field === 'holder') {
        const holder = room.participants.get('Kieran\u0000holder')!
        room.participants.set('Kieran\u0000holder', { ...holder, epoch: holder.epoch + 1, sessionId: 'replacement' })
      } else {
        const git = room.participants.get('Kieran\u0000git')!
        room.participants.set('Kieran\u0000git', { ...git, fence: 'replacement' })
      }
      const fresh = new RoomDoc()
      try {
        Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(room.doc))
        expect(fresh.graphs.get('Rohan')?.edges.some(e => e.source === 'remote.py')).toBe(false)
      } finally { fresh.doc.destroy() }
    } finally { gi.stop(); room.doc.destroy() }
  })

  it.each(['grant', 'completeness'] as const)('restores a peer edge and ready status after %s head-only withdrawal', async kind => {
    const room = graphRoom()
    publishFixture(room, 'Kieran', 'remote.py', 'def remote_only():\n    pass\n')
    publishFixture(room, 'Rohan', 'consumer.py', 'from remote import remote_only\nremote_only()\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    try {
      gi.start(); await gi.whenIdle()
      await eventually(() => room.graphs.get('Rohan')?.status === 'ready' && room.graphs.get('Rohan')!.edges.some(e => e.source === 'remote.py'))
      await new Promise(resolve => setTimeout(resolve, 200))
      const head = room.manifestHead.get('Kieran')!
      room.manifestHead.set('Kieran', kind === 'grant'
        ? { ...head, level: 'declared', textPrefixes: [], rev: head.rev + 1, semRev: head.semRev + 1 }
        : { ...head, complete: false, rev: head.rev + 1, semRev: head.semRev + 1 })
      expect(room.graphs.get('Rohan')?.edges.some(e => e.source === 'remote.py')).toBe(false)
      const withdrawn = room.manifestHead.get('Kieran')!
      room.manifestHead.set('Kieran', { ...withdrawn, level: 'full', complete: true, rev: withdrawn.rev + 1, semRev: withdrawn.semRev + 1 })
      await gi.whenIdle()
      await eventually(() => room.graphs.get('Rohan')?.status === 'ready' && room.graphs.get('Rohan')!.edges.some(e => e.source === 'remote.py'))
      const fresh = new RoomDoc()
      try {
        Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(room.doc))
        expect(fresh.graphs.get('Rohan')?.edges.some(e => e.source === 'remote.py')).toBe(true)
      } finally { fresh.doc.destroy() }
    } finally { gi.stop(); room.doc.destroy() }
  })

  it.each([{ name: 'default throttle', minPublishMs: undefined }, { name: 'zero throttle', minPublishMs: 0 }])(
    'N2 does not republish a head-only excluded base path with $name', async ({ minPublishMs }) => {
      const room = new RoomDoc()
      room.setMeta({ base }); setFixtureLocalRoot(room, 'Rohan', dir)
      publishFixture(room, 'Rohan', 'utils.py', 'def validate_token(t):\n    return t\n')
      const initialHead = room.manifestHead.get('Rohan')!, key = manifestKey('Rohan', initialHead.fence)
      room.manifest.get(key)!.delete('utils.py')
      room.clearOverlay(key, 'utils.py')
      const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, ...(minPublishMs === undefined ? {} : { minPublishMs }) })
      try {
        gi.start(); await gi.whenIdle()
        await eventually(() => room.graphs.get('Rohan')?.status === 'ready' && room.graphs.get('Rohan')!.paths.includes('utils.py'))
        writeFileSync(join(dir, 'utils.py'), 'def validate_token(secret_customer):\n    return secret_customer\n')
        const head = room.manifestHead.get('Rohan')!
        room.manifestHead.set('Rohan', { ...head, excluded: [digestPath(room.ensureRoomSalt(), 'utils.py')], rev: head.rev + 1, semRev: head.semRev + 1 })
        expect(room.manifest.get(key)!.has('utils.py')).toBe(false)
        expect(room.graphs.get('Rohan')?.paths).not.toContain('utils.py')
        await gi.whenIdle()
        await new Promise(resolve => setTimeout(resolve, minPublishMs === 0 ? 200 : 20_150))
        expect(room.graphs.get('Rohan')?.paths).not.toContain('utils.py')
        expect(JSON.stringify(room.graphs.get('Rohan'))).not.toContain('secret_customer')
      } finally { gi.stop(); room.doc.destroy() }
    }, 25_000)
  it('M1 rejects a published signature when its holder epoch changes during the base read', async () => {
    const room = new RoomDoc()
    room.setMeta({ base }); setFixtureLocalRoot(room, 'Rohan', dir)
    publishFixture(room, 'Rohan', 'utils.py', 'def validate_token(t):\n    return t\n')
    let block = false, entered!: () => void, release!: () => void
    const inside = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const read: typeof gitShow = async (root, sha, file) => {
      if (block && file === 'utils.py') { block = false; entered(); await gate }
      return gitShow(root, sha, file)
    }
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0, read })
    try {
      gi.start(); await gi.whenIdle()
      block = true
      publishFixture(room, 'Rohan', 'utils.py', 'def validate_token(t, secret_customer):\n    return t\n')
      await inside
      const holder = room.participants.get('Rohan\u0000holder')!
      room.participants.set('Rohan\u0000holder', { ...holder, epoch: 2, sessionId: 'replacement' })
      release()
      await gi.whenIdle()
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(JSON.stringify(room.graphs.get('Rohan'))).not.toContain('secret_customer')
    } finally { release(); gi.stop(); room.doc.destroy() }
  })
  it('keeps held own contracts out of the replicated graph and withdraws them when sharing narrows', async () => {
    const room = new RoomDoc()
    room.setMeta({ base }); setFixtureLocalRoot(room, 'Rohan', dir)
    writeFileSync(join(dir, 'utils.py'), 'def validate_token(t, secret_customer):\n    return t\n')
    publishFixture(room, 'Rohan', 'utils.py', 'def validate_token(t, secret_customer):\n    return t\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    try {
      gi.start(); await gi.whenIdle()
      await eventually(() => JSON.stringify(room.graphs.get('Rohan')).includes('secret_customer'))
      const head = room.manifestHead.get('Rohan')!
      const key = manifestKey('Rohan', head.fence)
      room.doc.transact(() => {
        room.manifest.get(key)!.set('utils.py', { change: 'M', state: 'held', held: 'scope', at: Date.now(), fence: head.fence })
        room.clearOverlay(key, 'utils.py')
        room.manifestHead.set('Rohan', { ...head, level: 'declared', textPrefixes: [], rev: head.rev + 1, semRev: head.semRev + 1 })
      })
      await gi.whenIdle()
      await eventually(() => !JSON.stringify(room.graphs.get('Rohan')).includes('secret_customer'))
      expect(gi.graph.definersOf('validate_token')).toEqual(['utils.py'])
    } finally { gi.stop(); room.doc.destroy() }
  })
  it('withdraws an out-of-area signature synchronously under the default publication throttle', async () => {
    const room = new RoomDoc()
    room.setMeta({ base }); setFixtureLocalRoot(room, 'Rohan', dir)
    writeFileSync(join(dir, 'utils.py'), 'def validate_token(t, secret_customer):\n    return t\n')
    publishFixture(room, 'Rohan', 'utils.py', 'def validate_token(t, secret_customer):\n    return t\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0 })
    try {
      gi.start(); await gi.whenIdle()
      await eventually(() => JSON.stringify(room.graphs.get('Rohan')).includes('secret_customer'))
      const head = room.manifestHead.get('Rohan')!, key = manifestKey('Rohan', head.fence)
      room.doc.transact(() => {
        room.manifest.get(key)!.set('utils.py', { change: 'M', state: 'held', held: 'scope', at: Date.now(), fence: head.fence })
        room.clearOverlay(key, 'utils.py')
        room.manifestHead.set('Rohan', { ...head, level: 'declared', textPrefixes: [], rev: head.rev + 1, semRev: head.semRev + 1 })
      })
      expect(JSON.stringify(room.graphs.get('Rohan'))).not.toContain('secret_customer')
      const lateReader = new RoomDoc()
      Y.applyUpdate(lateReader.doc, Y.encodeStateAsUpdate(room.doc))
      expect(JSON.stringify(lateReader.graphs.get('Rohan'))).not.toContain('secret_customer')
      lateReader.doc.destroy()
    } finally { gi.stop(); room.doc.destroy() }
  })
  it.each([
    { name: 'narrowed grant and wrong fence, zero throttle', narrowed: true, wrongFence: true, minPublishMs: 0 },
    { name: 'narrowed grant and wrong fence, default throttle', narrowed: true, wrongFence: true, minPublishMs: undefined },
    { name: 'narrowed grant only', narrowed: true, wrongFence: false, minPublishMs: 0 },
    { name: 'wrong fence only', narrowed: false, wrongFence: true, minPublishMs: 0 },
  ])('does not publish disk-only definitions after $name', async ({ narrowed, wrongFence, minPublishMs }) => {
    const repo = mkdtempSync(join(tmpdir(), 'room-private-graph-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString()
    const room = new RoomDoc()
    try {
      git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
      writeFileSync(join(repo, 'api.py'), 'def call():\n    pass\n')
      writeFileSync(join(repo, 'aux.py'), 'def other():\n    pass\n')
      git('add', '.'); git('commit', '-qm', 'base')
      const commit = git('rev-parse', 'HEAD').trim()
      room.setMeta({ base: commit }); setFixtureLocalRoot(room, 'B', repo)
      publishFixture(room, 'B', 'api.py', 'def call(value):\n    return value\n', { base: commit })
      publishFixture(room, 'B', 'aux.py', 'def other(value):\n    return value\n', { base: commit })
      publishFixture(room, 'A', 'consumer.py', 'from aux import other, private_only\nother(1)\nprivate_only()\n', { base: commit })
      const gi = new GraphIndex(room, 'B', repo, undefined, { random: () => 0, ...(minPublishMs === undefined ? {} : { minPublishMs }) })
      try {
        gi.start(); await gi.whenIdle()
        await eventually(() => room.graphs.get('B')?.status === 'ready' && room.graphs.get('B')?.edges.some(edge => edge.source === 'aux.py' && edge.target === 'consumer.py'))
        expect(room.graphs.get('B')?.edges.some(edge => edge.symbols.includes('private_only'))).toBe(false)
        writeFileSync(join(repo, 'aux.py'), 'def other(value):\n    return value\n\ndef private_only():\n    pass\n')
        const head = room.manifestHead.get('B')!, key = manifestKey('B', head.fence)
        room.doc.transact(() => {
          const old = room.manifest.get(key)!.get('aux.py')!
          room.manifest.get(key)!.set('aux.py', wrongFence ? { ...old, fence: 'wrong' } : { change: 'M', state: 'held', held: 'scope', at: Date.now(), fence: head.fence })
          if (!wrongFence) room.clearOverlay(key, 'aux.py')
          room.manifestHead.set('B', { ...head, level: narrowed ? 'declared' : 'full', textPrefixes: narrowed ? ['api.py'] : undefined, rev: head.rev + 1, semRev: head.semRev + 1 })
        })
        expect(room.graphs.get('B')?.paths).not.toContain('aux.py')
        const revision = room.manifestHead.get('B')!.rev
        await gi.whenIdle()
        const deadline = Date.now() + (minPublishMs === undefined ? 23_000 : 3_000)
        while (!(room.graphs.get('B')?.status === 'ready' && room.graphs.get('B')?.sourceRev === revision)) {
          if (Date.now() >= deadline) throw new Error('graph did not publish the new revision')
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        const fresh = new RoomDoc()
        try {
          Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(room.doc))
          const graph = fresh.graphs.get('B')!
          expect(graph.paths).not.toContain('aux.py')
          expect(graph.edges.some(edge => edge.source === 'aux.py' || edge.target === 'aux.py' || edge.symbols.includes('private_only'))).toBe(false)
          expect(graph.observed?.some(change => change.path === 'aux.py' || change.symbol === 'private_only')).toBe(false)
        } finally { fresh.doc.destroy() }
      } finally { gi.stop() }
    } finally { room.doc.destroy(); rmSync(repo, { recursive: true, force: true }) }
  }, 26_000)
  it('marks held remote changes as contract coverage gaps', async () => {
    const room = graphRoom()
    publishFixture(room, 'Kieran', 'hidden.py', 'def secret(x):\n    return x\n')
    const head = room.manifestHead.get('Kieran')!
    const key = manifestKey('Kieran', head.fence)
    room.doc.transact(() => {
      room.manifest.get(key)!.set('hidden.py', { change: 'A', state: 'held', held: 'scope', at: Date.now(), fence: head.fence })
      room.clearOverlay(key, 'hidden.py')
      room.manifestHead.set('Kieran', { ...head, rev: head.rev + 1, semRev: head.semRev + 1 })
    })
    const logs: string[] = []
    const gi = new GraphIndex(room, 'Rohan', dir, line => logs.push(line), { random: () => 0, minPublishMs: 0 })
    try {
      gi.start(); await gi.whenIdle()
      expect(gi.graph.has('hidden.py')).toBe(false)
      expect(room.graphs.get('Rohan')?.status).toBe('error')
      expect(logs.join('\n')).toContain('hidden.py changed by Kieran; contract not visible')
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('continues past an unchanged participant to a later changed version', async () => {
    const room = graphRoom()
    publishFixture(room, 'Ada', 'other.py', 'def other():\n    pass\n')
    publishFixture(room, 'Kieran', 'utils.py', 'def replacement():\n    pass\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    try {
      gi.start(); await gi.whenIdle()
      expect(gi.graph.definersOf('replacement')).toEqual(['utils.py'])
      expect(gi.graph.definersOf('validate_token')).toEqual([])
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('replacing one person map refreshes only its changed overlay, not 40 unrelated changed files', async () => {
    const room = graphRoom()
    for (let i = 0; i < 40; i++) publishFixture(room, 'Rohan', `mod${i}.py`, `def f${i}():\n    return ${i}\n`)
    publishFixture(room, 'Kieran', 'utils.py', 'def old_name():\n    pass\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    try {
      gi.start(); await gi.whenIdle()
      const refresh = vi.spyOn(gi, 'refresh')
      publishFixture(room, 'Kieran', 'utils.py', 'def new_name():\n    pass\n')
      await gi.whenIdle()
      expect(refresh.mock.calls.map(call => call[0])).toEqual(['utils.py'])
      expect(gi.graph.definersOf('new_name')).toEqual(['utils.py'])
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('initial refresh covers every changed source file', async () => {
    const room = graphRoom()
    for (let i = 0; i < 16; i++) publishFixture(room, 'Rohan', `mod${i}.py`, `def f${i}():\n    pass\n`)
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    try {
      const refresh = vi.spyOn(gi, 'refresh')
      gi.start(); await gi.whenIdle()
      expect(new Set(refresh.mock.calls.map(call => call[0]))).toEqual(new Set(['utils.py', ...Array.from({ length: 16 }, (_, i) => `mod${i}.py`)]))
      expect(gi.graph.size).toBe(17)
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('limits initial refresh to eight active file reads', async () => {
    const room = graphRoom()
    for (let i = 0; i < 16; i++) publishFixture(room, 'Rohan', `mod${i}.py`, `def f${i}():\n    pass\n`)
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    const target = gi as unknown as { textFor(path: string): Promise<string | undefined> }
    const original = target.textFor.bind(gi)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let active = 0, peak = 0, started = 0
    vi.spyOn(target, 'textFor').mockImplementation(async path => {
      started++; active++; peak = Math.max(peak, active)
      await gate
      active--
      return original(path)
    })
    try {
      gi.start()
      await eventually(() => started === 8)
      expect(peak).toBe(8)
      expect(started).toBe(8)
      release(); await gi.whenIdle()
      expect(started).toBe(17)
    } finally { release(); gi.stop(); room.doc.destroy() }
  })

  it('limits incremental refresh to eight active file reads', async () => {
    const room = graphRoom()
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    gi.start(); await gi.whenIdle()
    const target = gi as unknown as { textFor(path: string): Promise<string | undefined> }
    const original = target.textFor.bind(gi)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let active = 0, peak = 0, started = 0
    vi.spyOn(target, 'textFor').mockImplementation(async path => {
      started++; active++; peak = Math.max(peak, active)
      await gate
      active--
      return original(path)
    })
    try {
      room.doc.transact(() => {
        for (let i = 0; i < 16; i++) publishFixture(room, 'Rohan', `mod${i}.py`, `def f${i}():\n    pass\n`)
      })
      await eventually(() => started >= 8)
      expect(peak).toBeLessThanOrEqual(8)
      release(); await gi.whenIdle()
      expect(started).toBe(16)
    } finally { release(); gi.stop(); room.doc.destroy() }
  })

  // A lead with hundreds of changed files sat near 100% CPU while workers edited: every overlay
  // event re-parsed (and git-showed) every changed path of every participant.
  it('an edit refreshes only the path it touched, and a path leaving the changed set is refreshed', async () => {
    const room = graphRoom()
    for (let i = 0; i < 40; i++) publishFixture(room, 'Rohan', `mod${i}.py`, `def f${i}():\n    return ${i}\n`)
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    gi.start(); await gi.whenIdle()
    expect(gi.graph.size).toBe(41)
    const refresh = vi.spyOn(gi, 'refresh')

    publishFixture(room, 'Kieran', 'utils.py', 'def verify_token(t):\n    return t\n')
    await gi.whenIdle()
    expect(refresh.mock.calls.map(c => c[0])).toEqual(['utils.py'])

    refresh.mockClear()
    publishFixture(room, 'Rohan', 'mod3.py', 'def g3():\n    return 3\n')
    await gi.whenIdle()
    expect(refresh.mock.calls.map(c => c[0])).toEqual(['mod3.py'])

    refresh.mockClear()
    clearFixture(room, 'Rohan', 'mod7.py')
    await gi.whenIdle()
    expect(refresh.mock.calls.map(c => c[0])).toEqual(['mod7.py'])
    expect(gi.graph.size).toBe(40) // mod7.py was only an overlay: gone, not stale

    refresh.mockClear()
    deleteFixture(room, 'Kieran', 'mod9.py')
    await gi.whenIdle()
    expect(refresh.mock.calls.map(c => c[0])).toEqual(['mod9.py'])
    gi.stop(); room.doc.destroy()
  })

  it('a participant dropping all their work still refreshes each of their paths', async () => {
    const room = graphRoom()
    publishFixture(room, 'Kieran', 'utils.py', 'def verify_token(t):\n    return t\n')
    publishFixture(room, 'Kieran', 'extra.py', 'def extra():\n    return 1\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    gi.start(); await gi.whenIdle()
    expect(gi.graph.usersOf('validate_token')).toEqual([])
    expect(gi.graph.size).toBe(2)
    room.doc.transact(() => {
      const fence = room.manifestHead.get('Kieran')?.fence
      if (fence) room.manifest.delete(`Kieran\u0000${fence}`)
      room.manifestHead.delete('Kieran')
    })
    await gi.whenIdle()
    expect(gi.graph.size).toBe(1)
    const text = await (gi as unknown as { textFor(p: string): Promise<string | undefined> }).textFor('utils.py')
    expect(text).toContain('validate_token')
    gi.stop(); room.doc.destroy()
  })
})

function graphRoom(): RoomDoc {
  const room = new RoomDoc()
  room.setMeta({ repo: 'github.com/example/graph' })
  setParticipantBase(room, 'Rohan', base)
  setFixtureLocalRoot(room, 'Rohan', dir)
  return room
}
