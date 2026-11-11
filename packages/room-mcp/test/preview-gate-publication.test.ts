import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import * as evidence from '../src/preview-evidence.js'
import { runInMergedTree } from '../src/tools/files.js'
import { setPreviewLockUnavailableForTests } from '../src/preview-cache.js'
import type { Session } from '../src/session.js'

it('does not report PASSED after late abort even when a newer attempt superseded its evidence', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-review-publication-')))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(root, 'file.txt'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const controller = new AbortController(), begin = evidence.beginPreviewAttempt
  let superseded = false
  vi.spyOn(evidence, 'beginPreviewAttempt').mockImplementation(async (...args) => {
    const finish = await begin(...args)
    return async (...completion) => {
      if (completion[1].complete) {
        // A real pending publication from a concurrent preview wins during the
        // old attempt's asynchronous completion phase. Then its caller aborts.
        await begin(root, 'newer-command')
        superseded = true
        controller.abort(new Error('cancelled before publication'))
      }
      return finish(...completion)
    }
  })
  setPreviewLockUnavailableForTests(true)
  try {
    const result = await runInMergedTree({ dir: root } as Session, git('rev-parse', 'HEAD'), new Map(), 'echo "1 passed"', { signal: controller.signal })
    expect(superseded).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    expect(await evidence.collectedTreeEvidence(root)).not.toContain('tree that passed')
    expect(result.passed, result.text).toBe(false)
    expect(result.text).not.toContain('tests: PASSED')
  } finally { vi.restoreAllMocks(); setPreviewLockUnavailableForTests(); fs.rmSync(root, { recursive: true, force: true }) }
}, 30_000)
