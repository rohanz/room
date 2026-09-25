import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readRelayInfo } from '@room/relay'
import { ensureLocalRelay, localRoomName } from '../src/local.js'
import { gitCommonDir } from '../src/git-dirs.js'

const sh = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim()

async function makeRepo(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'room-local-'))
  sh(dir, ['init', '-q', '-b', 'main'])
  sh(dir, ['config', 'user.email', 't@t']); sh(dir, ['config', 'user.name', 'Test'])
  await fsp.writeFile(path.join(dir, 'a.txt'), 'a\n')
  sh(dir, ['add', '-A']); sh(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

describe('local rooms', () => {
  it('names the room after the main worktree so every worktree of a clone shares it', async () => {
    const dir = await makeRepo()
    const wt = path.join(dir, '.room', 'workers', 'x')
    sh(dir, ['worktree', 'add', '-q', '-b', 'room/x', wt, 'HEAD'])
    expect(await localRoomName(dir)).toBe(`local/${path.basename(dir)}/main`)
    expect(await localRoomName(wt)).toBe(`local/${path.basename(dir)}/main`)
    expect(await localRoomName(wt, 'feature')).toBe(`local/${path.basename(dir)}/feature`)
    expect(fs.realpathSync(await gitCommonDir(wt))).toBe(fs.realpathSync(path.join(dir, '.git')))
  })

  it('starts the relay in the clone\'s common git dir', async () => {
    const dir = await makeRepo()
    const common = await gitCommonDir(dir)
    const a = await ensureLocalRelay(common, 'local/x/main', { watchMs: 100 })
    try {
      expect(a.owned).toBe(true)
      expect(readRelayInfo(common)?.port).toBe(a.port)
      expect(fs.existsSync(path.join(common, 'room-local.json'))).toBe(true)
    } finally { await a.stop() }
  })
})
