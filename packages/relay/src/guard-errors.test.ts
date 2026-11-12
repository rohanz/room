import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { withGuardAsync } from './leases.js'

it('releases its live guard if acquisition fails after the exclusive link succeeds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-stalls-guard-'))
  const file = path.join(dir, 'publication'), guard = `${file}.guard`
  const open = fs.promises.open.bind(fs.promises)
  let injected = false, entered = false
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (String(args[0]) === dir && fs.existsSync(guard) && !injected) {
      injected = true
      vi.spyOn(handle, 'sync').mockRejectedValueOnce(Object.assign(new Error('one-shot directory sync failure'), { code: 'EIO' }))
    }
    return handle
  })
  try {
    await expect(withGuardAsync(file, () => { entered = true })).rejects.toThrow('one-shot directory sync failure')
    expect(injected).toBe(true)
    expect(entered).toBe(false)
    // The one-shot fault is gone. A surviving MCP must be able to publish again.
    vi.restoreAllMocks()
    expect(fs.existsSync(guard), 'failed acquisition stranded a guard owned by this still-live process').toBe(false)
    await expect(withGuardAsync(file, () => 'retry')).resolves.toBe('retry')
  } finally {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
