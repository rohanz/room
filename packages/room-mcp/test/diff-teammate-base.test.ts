import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc, type Worker } from '@room/shared'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'

const gitShowFailure = vi.hoisted(() => ({ error: undefined as Error | undefined }))
vi.mock('@room/roomd/git', async importOriginal => {
  const original = await importOriginal<typeof import('@room/roomd/git')>()
  return { ...original, gitShow: async (...args: Parameters<typeof original.gitShow>) => {
    if (gitShowFailure.error) throw gitShowFailure.error
    return original.gitShow(...args)
  } }
})

const dirs: string[] = []
afterEach(() => {
  gitShowFailure.error = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function flaskChanges() {
  const dir = mkdtempSync(join(tmpdir(), 'room-diff-base-'))
  dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Ana')
  git('config', 'user.email', 'ana@example.test')
  const original = 'Changelog\n=========\n\nExisting release notes.\n'
  const anaEntry = 'Ana: fixed autoescaping.\n'
  const benEntry = 'Ben: fixed request validation.\n'
  writeFileSync(join(dir, 'CHANGES.rst'), original)
  git('add', 'CHANGES.rst')
  git('commit', '-qm', 'base')
  const oldBase = git('rev-parse', 'HEAD')
  writeFileSync(join(dir, 'CHANGES.rst'), original + anaEntry)
  git('commit', '-qam', 'Ana changelog entry')
  const readerBase = git('rev-parse', 'HEAD')

  const room = new RoomDoc(new Y.Doc())
  room.setMeta({ repo: 'flask', branch: 'main', base: readerBase })
  room.setBaseOf('Ana', readerBase)
  room.setBaseOf('Ben', oldBase)
  room.setOverlay('Ben', 'CHANGES.rst', original + benEntry)
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { name: 'Ana', kind: 'agent', color: '#000' }, status: 'idle' })
  const session = {
    room, awareness, me: { name: 'Ana', kind: 'agent' }, dir,
    roomUrl: 'ws://x/r', roomName: 'r', browserUrl: 'http://x',
    provider: { synced: true, awareness },
    daemon: { touch() {}, async stop() {}, dir, name: 'Ana', roomDoc: room, base: readerBase },
  } as unknown as Session
  const tools = createTools({ getSession: () => session, setSession: () => {}, cwd: dir })
  return { tools, dir, git, oldBase, readerBase, anaEntry, benEntry, awareness, room }
}

it.each([
  ['one file', { path: 'CHANGES.rst' }],
  ['all diffs', {}],
])('room_read diff of Ben after Ana commits shows only Ben’s change (%s)', async (_name, options) => {
  const t = flaskChanges()
  try {
    const diff = await t.tools.call('room_read', { person: 'Ben', diff: true, ...options })
    expect(diff).toContain(`+${t.benEntry}`)
    expect(diff).not.toContain(`-${t.anaEntry}`)
    expect(diff).toContain(`Ben is on base ${t.oldBase.slice(0, 10)}`)
    expect(diff).toContain(`you are on ${t.readerBase.slice(0, 10)}`)
  } finally {
    await t.tools.shutdown()
    t.awareness.destroy()
    t.room.doc.destroy()
  }
})

it('a teammate overlay still asks for fetch when its base is absent locally', async () => {
  const t = flaskChanges()
  try {
    t.room.setBaseOf('Ben', 'c0ffee0000000000000000000000000000000000')
    const diff = await t.tools.call('room_read', { person: 'Ben', path: 'CHANGES.rst', diff: true })
    expect(diff).toMatch(/error: Ben's HEAD c0ffee0000 is not in this clone/)
    expect(diff).toContain('run git fetch, then retry')
  } finally {
    await t.tools.shutdown()
    t.awareness.destroy()
    t.room.doc.destroy()
  }
})

it.each(['git show timed out after 30000ms', 'git show failed: permission denied'])(
  'a git failure with a present teammate base is reported unchanged (%s)', async message => {
    const t = flaskChanges()
    try {
      gitShowFailure.error = new Error(message)
      const diff = await t.tools.call('room_read', { person: 'Ben', path: 'CHANGES.rst', diff: true })
      expect(diff).toContain(message)
      expect(diff).not.toContain('git fetch')
      expect(diff).not.toContain("Ben's HEAD")
    } finally {
      await t.tools.shutdown()
      t.awareness.destroy()
      t.room.doc.destroy()
    }
  }
)

it('a connected carried worker diff contains only the worker edit and no misleading base note', async () => {
  const t = flaskChanges()
  const name = 'Ana+w'
  const carriedEntry = 'Ana: carried uncommitted wording.\n'
  const workerEntry = 'Worker: revised validation note.\n'
  const carriedText = `Changelog\n=========\n\nExisting release notes.\n${t.anaEntry}${carriedEntry}`
  const peer = new Awareness(new Y.Doc())
  try {
    t.git('checkout', '-qb', 'room/w')
    writeFileSync(join(t.dir, 'CHANGES.rst'), carriedText)
    t.git('commit', '-qam', 'carried lead work')
    const carriedBase = t.git('rev-parse', 'HEAD')
    t.git('checkout', '-q', 'main')
    t.room.setWorker({ id: 'Ana/w#1', tag: 'w', name, host: 'codex', task: 'edit changelog', dir: t.dir,
      branch: 'room/w', pid: 1, startedAt: 0, status: 'running', lead: 'Ana', base: carriedBase, carriedBase } as Worker)
    t.room.setBaseOf(name, t.readerBase)
    t.room.setOverlay(name, 'CHANGES.rst', carriedText + workerEntry)
    peer.setLocalState({ user: { name, kind: 'agent', color: '#000' }, status: 'idle' })
    applyAwarenessUpdate(t.awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')

    for (const args of [{ path: 'CHANGES.rst' }, {}]) {
      const diff = await t.tools.call('room_read', { person: name, diff: true, ...args })
      expect(diff).toContain(`+${workerEntry}`)
      expect(diff).not.toContain(`+${carriedEntry}`)
      expect(diff).not.toContain(`-${carriedEntry}`)
      expect(diff).not.toContain('commits only one of you has')
      expect(diff).not.toContain('note: Ana+w is on base')
    }
  } finally {
    peer.destroy(); peer.doc.destroy()
    await t.tools.shutdown()
    t.awareness.destroy()
    t.room.doc.destroy()
  }
})
