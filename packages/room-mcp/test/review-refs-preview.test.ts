import fs from 'node:fs'
import path from 'node:path'
import { realRepo } from './workers-fixture.js'
import { afterEach, expect, it } from 'vitest'
import { previewCachePath, runInMergedTree, waitForPreviewSweepForTests } from '../src/tools/files.js'
import { disposePreviewFixture } from './fixtures/preview-disposal.js'
import type { Session } from '../src/session.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await disposePreviewFixture(root) })
it.each([undefined, 'room preview cache', 'personal lock', ''])('respects the exact missing cache registration lock %j', async reason => {
  const { repo: root, git, head } = realRepo()
  roots.push(root)
  const cache = await previewCachePath(root), unrelated = path.join(path.dirname(cache), '999999999-dead-start-0')
  fs.mkdirSync(path.dirname(cache), { recursive: true })
  for (const dir of [unrelated, cache]) {
    git('worktree', 'add', '--detach', '-q', dir, head)
    if (reason !== undefined && dir === cache) git('worktree', 'lock', ...(reason ? ['--reason', reason] : []), dir)
    fs.rmSync(dir, { recursive: true, force: true })
  }
  const result = await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')
  const takeover = reason === undefined || reason === 'room preview cache'
  expect(result.passed, result.text).toBe(takeover)
  await waitForPreviewSweepForTests()
  expect(fs.existsSync(path.join(cache, '.git'))).toBe(takeover)
  if (!takeover) {
    expect(result.text).toContain(cache)
    expect(result.text).toContain('git worktree unlock')
    expect(result.text).toContain('git worktree prune')
    expect(git('worktree', 'list', '--porcelain').split('\n')).toContain(reason ? `locked ${reason}` : 'locked')
  }
  expect(git('worktree', 'list', '--porcelain')).toContain(unrelated)
})
