import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { previewCachePath, removePreviewCache, runInMergedTree, waitForPreviewSweepForTests } from '../src/tools/files.js'
import type { Session } from '../src/session.js'

it('places a preview checkout in a shared fingerprint entry beneath the clone key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-slot-'))
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
    fs.writeFileSync(path.join(root, 'app.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base')
    const cache = await previewCachePath(root)
    expect(path.basename(path.dirname(cache))).toMatch(/^[a-f0-9]{20}$/)
    expect(path.basename(cache)).toMatch(/^shared-[a-f0-9]{16}$/)
    const result = await runInMergedTree({ dir: root } as Session, git('rev-parse', 'HEAD'), new Map(), 'echo "1 passed"')
    expect(result.passed, result.text).toBe(true)
    expect(git('worktree', 'list', '--porcelain')).toContain(cache)
    expect(git('worktree', 'list', '--porcelain')).toMatch(/locked room preview cache/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}, 30_000)

it('ignores persistent legacy sidecars on repeated migration passes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-legacy-'))
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
    fs.writeFileSync(path.join(root, 'app.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base')
    const key = path.dirname(await previewCachePath(root))
    fs.mkdirSync(key, { recursive: true })
    const name = '999999999-dead-start-0'
    const slot = path.join(key, name)
    git('worktree', 'add', '--detach', '-q', slot, git('rev-parse', 'HEAD'))
    await removePreviewCache(root)
    await waitForPreviewSweepForTests()
    expect(fs.existsSync(slot)).toBe(false)
    for (const suffix of ['.lock', '.meta.json', '.claim', '.settings', '.settings.old', '.settings-old']) {
      if (suffix === '.settings-old') fs.mkdirSync(`${slot}${suffix}`)
      else fs.writeFileSync(`${slot}${suffix}`, 'persistent sidecar')
    }
    for (let pass = 0; pass < 3; pass++) {
      await removePreviewCache(root)
      await waitForPreviewSweepForTests()
    }
    expect(fs.readdirSync(key).filter(item => item.startsWith(name)).sort()).toEqual(
      ['.claim', '.lock', '.meta.json', '.settings', '.settings.old', '.settings-old'].map(suffix => `${name}${suffix}`).sort(),
    )
    expect(fs.existsSync(`${slot}.lock.lock`)).toBe(false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}, 30_000)
