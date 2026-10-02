// rc11 all-Codex rehearsal R4: a lead with eight workers re-read the same commit's files for every claim and
// conflict reconcile, two Git processes per read; spawning them cost its MCP seconds of event-loop time.
import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const spawned = vi.hoisted(() => ({ blobInfo: 0 }))
vi.mock('@room/roomd/git', async importOriginal => {
  const actual = await importOriginal<typeof import('@room/roomd/git')>()
  return { ...actual, gitBlobInfoMany: (...args: Parameters<typeof actual.gitBlobInfoMany>) => { spawned.blobInfo++; return actual.gitBlobInfoMany(...args) } }
})
import { readBoundedHistoricalText } from '../src/tools/disk-text.js'

let dir = ''
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); spawned.blobInfo = 0 })
const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim()

it('reads one commit\'s file from Git once, however often it is asked', async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-historical-')))
  git('init', '-q'); git('config', 'user.email', 'a@b'); git('config', 'user.name', 'A')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n'); git('add', '.'); git('commit', '-qm', 'one')
  const first = git('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n'); git('commit', '-qam', 'two')
  const results = await Promise.all(Array.from({ length: 20 }, () => readBoundedHistoricalText(dir, first, 'a.txt')))
  for (let i = 0; i < 20; i++) results.push(await readBoundedHistoricalText(dir, first, 'a.txt'))
  expect(new Set(results)).toEqual(new Set(['one\n']))
  expect(await readBoundedHistoricalText(dir, first, 'missing.txt')).toBeUndefined()
  expect(await readBoundedHistoricalText(dir, first, 'missing.txt')).toBeUndefined()
  expect(spawned.blobInfo).toBe(2)
  // A ref names whatever it points at now: never cached.
  expect(await readBoundedHistoricalText(dir, 'HEAD', 'a.txt')).toBe('two\n')
  git('reset', '-q', '--hard', first)
  expect(await readBoundedHistoricalText(dir, 'HEAD', 'a.txt')).toBe('one\n')
})
