import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AutoJoin } from '../src/auto-join.js'
import { deriveRoomName } from '../src/session.js'
import type { Session } from '../src/session.js'
import { codexWorkspace, createWorkspaceBinding, deferForSharedCodex, fallbackWorkspace } from '../src/workspace.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function repo(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `room-workspace-${name}-`))
  dirs.push(dir)
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  execFileSync('git', ['-C', dir, '-c', 'user.name=Room Test', '-c', 'user.email=room@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'])
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/example/${name}.git`])
  return dir
}
const call = (dir?: string) => dir ? { _meta: { 'x-codex-turn-metadata': { workspaces: { [dir]: { has_changes: false } } } } } : {}

it('defers for a shared or unknown Codex parent, but not Claude, workers or ordinary Codex', () => {
  const codex = { ROOM_HOST: 'codex', PWD: '/wrong/repo' }
  expect(deferForSharedCodex(codex, () => 'codex app-server --listen unix:// --managed-daemon')).toBe(true)
  expect(deferForSharedCodex(codex, () => { throw new Error('ps failed') })).toBe(true)
  expect(deferForSharedCodex(codex, () => 'codex', 'win32')).toBe(true)
  expect(deferForSharedCodex(codex, () => 'codex exec')).toBe(false)
  expect(deferForSharedCodex({ ...codex, ROOM_DIR: '/worker' }, () => 'codex app-server')).toBe(false)
  expect(deferForSharedCodex({ ROOM_HOST: 'claude' }, () => 'codex app-server')).toBe(false)
})

it('selects the only metadata workspace, or the first Git worktree among several', () => {
  const target = repo('target')
  expect(codexWorkspace(call(target))).toBe(target)
  expect(codexWorkspace({ _meta: { 'x-codex-turn-metadata': { workspaces: { '/missing/repo': {}, [target]: {} } } } })).toBe(target)
  expect(codexWorkspace(call())).toBeUndefined()
})

it('preserves the directory fallback order when Codex sends no metadata', () => {
  expect(fallbackWorkspace({ ROOM_DIR: '/worker', PWD: '/pwd', INIT_CWD: '/init' }, '/process')).toBe('/worker')
  expect(fallbackWorkspace({ PWD: '/pwd', INIT_CWD: '/init' }, '/process')).toBe('/pwd')
  expect(fallbackWorkspace({ INIT_CWD: '/init' }, '/process')).toBe('/init')
  expect(fallbackWorkspace({}, '/process')).toBe('/process')
})

it('starts no join under shared hosting and first binds and joins the metadata repository, ignoring PWD', async () => {
  const wrong = repo('wrong')
  const target = repo('target')
  const joins: string[] = []
  const binding = createWorkspaceBinding({
    deferred: deferForSharedCodex({ ROOM_HOST: 'codex', PWD: wrong }, () => 'codex app-server --managed-daemon'),
    fallbackDir: () => wrong, logFallback: () => { throw new Error('unexpected fallback') },
    initialize: async dir => {
      const auto = new AutoJoin({ local: false, log: () => {}, report: () => {}, joined: () => joins.length > 0,
        attempt: async () => { const roomName = (await deriveRoomName(dir)).roomName; if (!roomName) throw new Error('no room'); return { roomName } as Session },
        adopt: async session => { joins.push(session.roomName) }, discard: async () => {},
      })
      void auto.ensure()
      return { dir, auto }
    },
  })
  await binding.start()
  expect(joins).toEqual([])
  expect(binding.current()).toBeUndefined()
  const { runtime, warning } = await binding.forCall(call(target))
  await runtime.auto.settle()
  expect(runtime.dir).toBe(target)
  expect(joins).toEqual(['github.com/example/target/main'])
  expect(warning).toBe('')
})

it('keeps startup binding for non-shared Codex, Claude and workers with ROOM_DIR', async () => {
  for (const host of ['codex', 'claude', 'worker']) {
    const dir = repo(host)
    const joins: string[] = []
    const binding = createWorkspaceBinding({
      deferred: deferForSharedCodex({ ROOM_HOST: host === 'worker' ? 'codex' : host, ...(host === 'worker' ? { ROOM_DIR: dir } : {}) }, () => host === 'worker' ? 'codex app-server' : 'codex exec'),
      fallbackDir: () => dir, logFallback: () => {},
      initialize: async target => { joins.push(target); return target },
    })
    await binding.start()
    expect(joins).toEqual([dir])
    expect((await binding.forCall(call(dir))).runtime).toBe(dir)
  }
})

it('falls back without metadata and warns on a later call from another workspace', async () => {
  const fallback = repo('fallback')
  const other = repo('other')
  const logs: string[] = []
  const binding = createWorkspaceBinding({ deferred: true, fallbackDir: () => fallback,
    logFallback: () => logs.push('fallback'), initialize: async dir => dir })
  await binding.start()
  expect((await binding.forCall(call())).runtime).toBe(fallback)
  expect(logs).toEqual(['fallback'])
  const later = await binding.forCall(call(other))
  expect(later.runtime).toBe(fallback)
  expect(later.warning).toBe(`This Codex session's workspace is ${other}, but Room is attached to ${fallback}; restart the session to switch.\n`)
})
