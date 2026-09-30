import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { previewCachePath, runInMergedTree } from '../src/tools/files.js'
import type { Session } from '../src/session.js'

for (const [ignoresTerm, useCache] of [[false, true], [true, true], [false, false]] as const) {
  it(`stops a redirected background check before ${useCache ? 'resetting the cache' : 'removing the fresh tree'}${ignoresTerm ? ' even when it ignores SIGTERM' : ''}`, async () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-child-')))
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
    const oldCap = process.env.ROOM_PREVIEW_CACHE_GB
    try {
      process.env.ROOM_PREVIEW_CACHE_GB = useCache ? '4' : '0'
      git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
      fs.writeFileSync(path.join(root, 'app.txt'), 'BASE\n'); git('add', '.'); git('commit', '-qm', 'base')
      const head = git('rev-parse', 'HEAD')
      const ready = path.join(root, 'child.pid')
      const observed = path.join(root, 'observed')
      const checker = path.join(root, 'checker.cjs')
      fs.writeFileSync(checker, `const fs=require('fs'); fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(observed)}, fs.readFileSync('app.txt','utf8')); ${ignoresTerm ? '' : 'process.exit(0)'} }); setInterval(() => {}, 1000);`)
      const cmd = `node ${JSON.stringify(checker)} >/dev/null 2>&1 & while [ ! -f ${JSON.stringify(ready)} ]; do sleep 0.01; done; echo '1 passed'`
      const result = await runInMergedTree({ dir: root } as Session, head, new Map([['app.txt', 'FIRST\n']]), cmd)
      expect(result.passed, result.text).toBe(true)
      expect(result.text).toContain('stopped 1 leftover process(es) from the check')
      expect(fs.readFileSync(observed, 'utf8')).toBe('FIRST\n')
      const pid = Number(fs.readFileSync(ready, 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
      if (useCache) {
        const cache = await previewCachePath(root)
        expect(fs.readFileSync(path.join(cache, 'app.txt'), 'utf8')).toBe('BASE\n')
      }
    } finally {
      if (oldCap === undefined) delete process.env.ROOM_PREVIEW_CACHE_GB
      else process.env.ROOM_PREVIEW_CACHE_GB = oldCap
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
}
