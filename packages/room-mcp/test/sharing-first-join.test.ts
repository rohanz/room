import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { startAutoTaggedRoomd } from '../src/session.js'
import { sharingFile } from '../src/policy-store.js'
import { hubRoom } from './fixtures/hub-provider.js'

const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

function checkout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-share-migrate-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q', dir])
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'base'])
  vi.stubEnv('ROOM_HOST', 'codex')
  return dir
}

it.each([
  { level: 'intent' as const, remembered: false },
  { level: 'declared' as const, remembered: true },
])('preserves $level through a real first join, tag rewrite, and interrupted policy write (remembered=$remembered)', async ({ level, remembered }) => {
  const dir = checkout(), room = hubRoom(), choice = path.join(dir, '.git', 'room-choice.json')
  const legacy = { where: 'local', at: 1, share: level, warnedLevels: { [`${fs.realpathSync(dir)}#ws://test`]: level },
    ...(remembered ? { tags: { [fs.realpathSync(dir)]: 'old' } } : {}) }
  fs.writeFileSync(choice, JSON.stringify(legacy))
  if (remembered) await room.hold('ada+old')
  else await room.hold('ada')
  const start = (sessionId: string) => startAutoTaggedRoomd({ dir, room: 'ws://test/room', localKey: 'key',
    name: 'ada', owner: 'ada', requested: 'full', sessionId, providerFactory: (_s, _r, doc: Y.Doc) => room.provider(doc), log: () => {} })
  const rename = fs.renameSync
  let interrupted = false
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (!interrupted && String(to).includes('/room/sharing/')) { interrupted = true; throw new Error('simulated crash before policy write') }
    return rename(from, to)
  })
  await expect(start('first')).rejects.toThrow('simulated crash')
  vi.restoreAllMocks()
  expect(interrupted).toBe(true)
  expect(JSON.parse(fs.readFileSync(choice, 'utf8')).share).toBe(level)
  const joined = await start('second')
  try {
    expect(joined.policyStore.requested).toBe(level)
    expect(joined.policyStore.policy.level).toBe(level)
    expect(JSON.parse(fs.readFileSync(await sharingFile(dir, 'room', joined.me.name), 'utf8')).requested).toBe(level)
    expect(JSON.parse(fs.readFileSync(choice, 'utf8')).share).toBeUndefined()
  } finally { await joined.daemon.stop(); room.doc.doc.destroy() }
})
