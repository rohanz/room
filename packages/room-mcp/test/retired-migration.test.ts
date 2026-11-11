import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WorkerRegistry } from '../src/worker-registry.js'
const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
it('ignores a partial worker import without changing its journal or importing old records', async () => {
  const common = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-workers-')); dirs.push(common)
  const file = path.join(common, 'room', 'registry', 'migration.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const before = '{"v":1,"sources":{},"done":false}\n'; fs.writeFileSync(file, before)
  const read = vi.spyOn(fs, 'readFileSync')
  const writer = await WorkerRegistry.open(common, { watch: false }); writer.close()
  const reader = await WorkerRegistry.openReader(common); reader.close()
  expect(read.mock.calls.some(([value]) => value === file)).toBe(false)
  read.mockRestore()
  expect(fs.readFileSync(file, 'utf8')).toBe(before)
  expect(fs.readdirSync(path.dirname(file))).toEqual(['migration.json'])
})

it.each([['room-local', 'old.ydoc'], ['room-carry', 'old.json']])('ignores unimported %s sources without touching them', async (dir, name) => {
  const common = fs.mkdtempSync(path.join(os.tmpdir(), 'unimported-workers-')); dirs.push(common)
  const source = path.join(common, dir, name)
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, 'old state')
  const read = vi.spyOn(fs, 'readFileSync')
  const writer = await WorkerRegistry.open(common, { watch: false }); writer.close()
  const reader = await WorkerRegistry.openReader(common); reader.close()
  expect(read.mock.calls.some(([value]) => value === source)).toBe(false)
  read.mockRestore()
  expect(fs.readFileSync(source, 'utf8')).toBe('old state')
  expect(fs.existsSync(path.join(common, 'room', 'registry', 'migration.json'))).toBe(false)
})
