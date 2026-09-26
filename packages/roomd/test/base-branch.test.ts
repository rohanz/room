import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import { messageForMe, shouldWakeOnMsg } from '@room/shared'
import { startRoomd, type Roomd } from '../src/index.js'

vi.setConfig({ testTimeout: 30_000 })
beforeAll(() => { vi.stubEnv('CHOKIDAR_USEPOLLING', '1') })
afterAll(() => { vi.unstubAllEnvs() })

const sh = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
const daemons: Roomd[] = []
const roots: string[] = []
afterEach(async () => {
  try { for (const daemon of daemons.splice(0)) await daemon.stop() }
  finally { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) }
})

function provider(doc: Y.Doc): WebsocketProvider {
  let local: unknown = null
  const states = new Map<number, unknown>()
  return {
    synced: true,
    awareness: {
      setLocalState(state: unknown) { local = state; if (state) states.set(doc.clientID, state); else states.delete(doc.clientID) },
      getLocalState: () => local,
      getStates: () => states,
    },
    on() {}, off() {}, destroy() {},
  } as unknown as WebsocketProvider
}

async function setup(local = false): Promise<{ dir: string; base: string; poll: () => Promise<void> ; daemon: Roomd }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-base-'))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const dir = path.join(root, 'checkout')
  sh(root, 'init', '--bare', '-q', origin)
  sh(root, 'init', '-q', '-b', 'rehearsal', dir)
  sh(dir, 'config', 'user.email', 'test@example.com')
  sh(dir, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(dir, 'app.txt'), 'base\n')
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-qm', 'base')
  sh(dir, 'remote', 'add', 'origin', origin)
  sh(dir, 'push', '-q', '-u', 'origin', 'rehearsal')
  const base = sh(dir, 'rev-parse', 'HEAD')
  const daemon = await startRoomd({
    dir, room: `ws://memory/${encodeURIComponent(local ? 'local/repo/rehearsal' : 'github.com/owner/repo/rehearsal')}`,
    ...(local ? { localKey: 'test-local-key' } : {}),
    name: 'Alice', kind: 'agent', providerFactory: (_server, _name, doc) => provider(doc),
    basePollMs: 60_000, trackedRefreshMs: 60_000, log: () => {},
  })
  daemons.push(daemon)
  return { dir, base, daemon, poll: () => (daemon as unknown as { pollHead(): Promise<void> }).pollHead() }
}

describe('room branch base tracking', () => {
  it.each(['missing origin', 'missing tracking branch'] as const)('advances a local commit with %s', async missing => {
    const { dir, base, daemon, poll } = await setup(true)
    if (missing === 'missing origin') sh(dir, 'remote', 'remove', 'origin')
    else sh(dir, 'update-ref', '-d', 'refs/remotes/origin/rehearsal')
    sh(dir, 'commit', '--allow-empty', '-qm', 'local change')
    const local = sh(dir, 'rev-parse', 'HEAD')
    await poll()
    expect(daemon.roomDoc.meta.base).toBe(local)
    expect(daemon.roomDoc.messages().filter(m => m.type === 'base')).toMatchObject([
      { prev: base, base: local, commits: 1 },
    ])
    expect((daemon.provider.awareness.getLocalState() as { status: string }).status).toBe('committed locally')
  })

  it('keeps a team-room base unchanged for a commit with no remote branch', async () => {
    const { dir, base, daemon, poll } = await setup()
    sh(dir, 'update-ref', '-d', 'refs/remotes/origin/rehearsal')
    sh(dir, 'commit', '--allow-empty', '-qm', 'local only')
    await poll()
    expect(daemon.roomDoc.meta.base).toBe(base)
    expect(daemon.roomDoc.messages().filter(m => m.type === 'base')).toHaveLength(0)
    expect((daemon.provider.awareness.getLocalState() as { status: string }).status).toBe('committed locally')
  })

  it('does not announce or advance a detached HEAD, then advances when back on the pushed room branch', async () => {
    const { dir, base, daemon, poll } = await setup()
    sh(dir, 'checkout', '--detach', '-q')
    sh(dir, 'commit', '--allow-empty', '-qm', 'rebased change')
    const rebased = sh(dir, 'rev-parse', 'HEAD')
    sh(dir, 'push', '-q', 'origin', 'HEAD:rehearsal')
    await poll()
    await poll()
    expect(daemon.roomDoc.meta.base).toBe(base)
    expect(daemon.roomDoc.messages().filter(m => m.type === 'base')).toHaveLength(0)
    expect(daemon.roomDoc.messages().filter(m => m.type === 'note' && m.to === 'Alice')).toHaveLength(0)

    sh(dir, 'checkout', '-q', 'rehearsal')
    sh(dir, 'merge', '-q', '--ff-only', rebased)
    await poll()
    await poll()
    expect(daemon.roomDoc.meta.base).toBe(rebased)
    expect(daemon.roomDoc.messages().filter(m => m.type === 'base')).toHaveLength(1)
    expect(daemon.roomDoc.messages().filter(m => m.type === 'note' && m.to === 'Alice')).toHaveLength(0)
  })

  it('notices a branch switch even when HEAD stays at the same commit', async () => {
    const { dir, base, daemon, poll } = await setup()
    sh(dir, 'checkout', '-qb', 'feature')
    await poll()
    await poll()
    expect(daemon.roomDoc.meta.base).toBe(base)
    expect(daemon.roomDoc.messages().filter(m => m.type === 'note' && m.to === 'Alice')).toHaveLength(1)
    expect((daemon.provider.awareness.getLocalState() as { status: string }).status).toContain('you switched to feature')
  })

  it('ignores a pushed feature branch, tells only its own agent once, then advances once after a room-branch push', async () => {
    const { dir, base, daemon, poll } = await setup()
    sh(dir, 'checkout', '-qb', 'feature')
    sh(dir, 'commit', '--allow-empty', '-qm', 'feature change')
    const feature = sh(dir, 'rev-parse', 'HEAD')
    sh(dir, 'push', '-q', '-u', 'origin', 'feature')
    await poll()
    await poll()
    expect(daemon.roomDoc.meta.base).toBe(base)
    expect(daemon.roomDoc.messages().filter(m => m.type === 'base')).toHaveLength(0)
    const notices = daemon.roomDoc.messages().filter(m => m.type === 'note' && m.to === 'Alice')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ from: 'room', text: 'you switched to feature; the room is for rehearsal; commits here are not the room\'s base until they are pushed to rehearsal' })
    expect(messageForMe({ name: 'Alice' }, notices[0])).toBe(true)
    expect(messageForMe({ name: 'Bob' }, notices[0])).toBe(false)
    expect(shouldWakeOnMsg({ name: 'Alice', kind: 'agent' }, notices[0]).wake).toBe(true)

    sh(dir, 'checkout', '-q', 'rehearsal')
    sh(dir, 'merge', '-q', '--ff-only', 'feature')
    sh(dir, 'push', '-q', 'origin', 'rehearsal')
    await poll()
    await poll()
    expect(daemon.roomDoc.meta.base).toBe(feature)
    expect(daemon.roomDoc.messages().filter(m => m.type === 'base')).toHaveLength(1)
  })

  it('advances only through the pushed room-branch commit when HEAD is two commits ahead', async () => {
    const { dir, base, daemon, poll } = await setup()
    sh(dir, 'commit', '--allow-empty', '-qm', 'first')
    const first = sh(dir, 'rev-parse', 'HEAD')
    sh(dir, 'commit', '--allow-empty', '-qm', 'second')
    const second = sh(dir, 'rev-parse', 'HEAD')
    sh(dir, 'push', '-q', 'origin', `${first}:rehearsal`)
    sh(dir, 'fetch', '-q', 'origin', 'rehearsal')
    await poll()
    expect(daemon.roomDoc.meta.base).toBe(first)
    expect(daemon.roomDoc.messages().filter(m => m.type === 'base')).toMatchObject([
      { prev: base, base: first, commits: 1 },
    ])
    expect(daemon.base).toBe(second)
    sh(dir, 'push', '-q', 'origin', 'rehearsal')
    await poll()
    expect(daemon.roomDoc.meta.base).toBe(second)
    expect(daemon.roomDoc.messages().filter(m => m.type === 'base')).toHaveLength(2)
  })
})
