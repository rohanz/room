import { expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBundleUpdateNotice } from '../src/index.js'

it('warns once when the running Room bundle is newer on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-bundle-'))
  try {
    const file = join(dir, 'index.mjs')
    writeFileSync(file, 'old')
    const notice = createBundleUpdateNotice(file)
    expect(notice()).toBe('')
    writeFileSync(file, 'new')
    utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    expect(notice()).toBe('Room was updated on disk; restart this session to pick up fixes')
    expect(notice()).toBe('')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
