import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadMemory } from '../src/memory.js'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
it('loads only schema-2 memory while leaving oversized old snapshots untouched', () => {
  const common = fs.mkdtempSync(path.join(os.tmpdir(), 'ignored-local-')); dirs.push(common)
  const source = path.join(common, 'room-local', `${encodeURIComponent('local/repo/main')}.ydoc`)
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, 'old bytes'); fs.truncateSync(source, 65 * 1048576)
  const stat = fs.statSync(source)
  const doc = loadMemory(common, 'local/repo')
  expect(doc.getMap('old').size).toBe(0)
  expect(fs.statSync(source).mtimeMs).toBe(stat.mtimeMs)
  expect(fs.statSync(source).size).toBe(stat.size)
  expect(fs.existsSync(path.join(common, 'room'))).toBe(false)
  doc.destroy()
})
