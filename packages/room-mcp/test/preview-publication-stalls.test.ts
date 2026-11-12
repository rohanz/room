import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { beginPreviewAttempt } from '../src/preview-evidence.js'

it('publishes preview evidence without synchronous fsyncs', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'room-publication-stalls-'))
  execFileSync('git', ['init', '-q', repo])
  const sync = fs.fsyncSync.bind(fs)
  let syncMs = 0
  const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    const start = performance.now()
    try { return sync(fd) } finally { syncMs += performance.now() - start }
  })
  const start = performance.now()
  let previous = start, maxDelay = 0
  const timer = setInterval(() => { const now = performance.now(); maxDelay = Math.max(maxDelay, now - previous - 10); previous = now }, 10)
  try {
    const complete = await beginPreviewAttempt(repo, 'test')
    expect(await complete(null, { complete: true, exitCode: 0, passed: true })).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 10))
    process.stdout.write(JSON.stringify({ publicationMs: performance.now() - start, maxDelayMs: maxDelay, syncCalls: spy.mock.calls.length, syncMs }) + '\n')
    expect(spy).not.toHaveBeenCalled()
  } finally { clearInterval(timer); spy.mockRestore(); fs.rmSync(repo, { recursive: true, force: true }) }
})
