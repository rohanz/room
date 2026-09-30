import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { previewCachePath, runInMergedTree, waitForPreviewSweepForTests } from '../src/tools/files.js'
import { tryPreviewLock } from '../src/preview-cache.js'
import type { Session } from '../src/session.js'

const filesModule = fileURLToPath(new URL('../src/tools/files.ts', import.meta.url))

async function until(test: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (test()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('preview process did not reach the expected event')
}

it('keeps an orphaned check and eviction off the cached tree until the check exits', async () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-crash-')))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  let holder: ReturnType<typeof spawn> | undefined
  const oldCap = process.env.ROOM_PREVIEW_CACHE_GB
  const ready = path.join(root, 'ready.json'), gate = path.join(root, 'gate'), result = path.join(root, 'result')
  try {
    process.env.ROOM_PREVIEW_CACHE_GB = '4'
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
    fs.writeFileSync(path.join(root, 'app.txt'), 'BASE\n'); git('add', '.'); git('commit', '-qm', 'base')
    const head = git('rev-parse', 'HEAD')
    const checker = path.join(root, 'checker.cjs')
    fs.writeFileSync(checker, `const fs=require('fs'); fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({dir:process.cwd(),pid:process.pid})); const timer=setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(timer); fs.writeFileSync(${JSON.stringify(result)},fs.readFileSync('app.txt','utf8')); } }, 20); setTimeout(() => process.exit(1), 30000).unref();`)
    const script = `import {runInMergedTree} from ${JSON.stringify(filesModule)}; await runInMergedTree({dir:${JSON.stringify(root)}},${JSON.stringify(head)},new Map([['app.txt','FIRST\\n']]),${JSON.stringify(`node ${JSON.stringify(checker)}`)});`
    holder = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: 'ignore' })
    await until(() => fs.existsSync(ready))
    const cache = await previewCachePath(root)
    expect((JSON.parse(fs.readFileSync(ready, 'utf8')) as { dir: string }).dir).toBe(cache)
    holder.kill('SIGKILL')
    await new Promise(resolve => holder!.once('exit', resolve))
    const checkPid = (JSON.parse(fs.readFileSync(ready, 'utf8')) as { pid: number }).pid
    expect(() => process.kill(checkPid, 0)).not.toThrow()
    expect(await tryPreviewLock(cache)).toBeUndefined()

    const second = await runInMergedTree({ dir: root } as Session, head, new Map([['app.txt', 'SECOND\n']]), 'echo "1 passed"')
    expect(second.passed, second.text).toBe(true)
    expect(second.text).toContain('(fresh base)')
    process.env.ROOM_PREVIEW_CACHE_GB = '0'
    const eviction = await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')
    expect(eviction.passed, eviction.text).toBe(true)
    await waitForPreviewSweepForTests()
    expect(fs.existsSync(path.join(cache, '.git'))).toBe(true)
    expect(fs.readFileSync(path.join(cache, 'app.txt'), 'utf8')).toBe('FIRST\n')

    fs.writeFileSync(gate, '')
    await until(() => fs.existsSync(result))
    expect(fs.readFileSync(result, 'utf8')).toBe('FIRST\n')
    let recovered = false
    for (let attempt = 0; attempt < 500; attempt++) {
      const unlock = await tryPreviewLock(cache)
      if (unlock) { await unlock(); recovered = true; break }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(recovered).toBe(true)
    process.env.ROOM_PREVIEW_CACHE_GB = '4'
    const third = await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')
    expect(third.passed, third.text).toBe(true)
    expect(third.text).toContain('(cached base)')
  } finally {
    fs.writeFileSync(gate, '')
    holder?.kill('SIGKILL')
    if (oldCap === undefined) delete process.env.ROOM_PREVIEW_CACHE_GB
    else process.env.ROOM_PREVIEW_CACHE_GB = oldCap
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* Preserve the failed assertion. */ }
  }
}, 120_000)
