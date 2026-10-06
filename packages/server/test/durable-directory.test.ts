import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { incarnationFile } from '../src/hub.js'

const dirs: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }) })
const setup = async () => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-durable-')); dirs.push(dir); return dir }

it('writes below an existing root that rejects mkdir with Windows EPERM', async () => {
  const dir = await setup(), root = path.parse(dir).root
  const mkdir = fs.mkdir.bind(fs)
  vi.spyOn(fs, 'mkdir').mockImplementation(async (target, options) => {
    if (String(target) === root) throw Object.assign(new Error('Windows root mkdir'), { code: 'EPERM' })
    return mkdir(target, options)
  })
  const store = incarnationFile(path.join(dir, 'new', 'nested'), 0)
  const first = await store.advance(0)
  expect(await store.advance(first)).toBeGreaterThan(first)
})

it('still syncs an existing ancestor when another writer wins mkdir', async () => {
  const dir = await setup(), raced = path.join(dir, 'raced'), mkdir = fs.mkdir.bind(fs)
  let racedOnce = false, syncedParent = false, unsupportedParent = false
  vi.spyOn(fs, 'mkdir').mockImplementation(async (target, options) => {
    if (String(target) === raced && !racedOnce) { racedOnce = true; await mkdir(target, options) }
    return mkdir(target, options)
  })
  const open = fs.open.bind(fs)
  vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
    let handle
    try { handle = await open(target, flags, mode) }
    catch (error) {
      if (String(target) === dir && ['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) unsupportedParent = true
      throw error
    }
    if (String(target) === dir) {
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementation(async () => { syncedParent = true; await sync() })
    }
    return handle
  })
  await incarnationFile(raced, 0).advance(0)
  expect(racedOnce).toBe(true)
  expect(syncedParent || unsupportedParent).toBe(true)
})

it('does not suppress permission errors below the root', async () => {
  const dir = await setup(), denied = path.join(dir, 'denied'), mkdir = fs.mkdir.bind(fs)
  vi.spyOn(fs, 'mkdir').mockImplementation(async (target, options) => {
    if (String(target) === denied) throw Object.assign(new Error('denied'), { code: 'EPERM' })
    return mkdir(target, options)
  })
  await expect(incarnationFile(denied, 0).advance(0)).rejects.toThrow('denied')
})

it('refuses a file in the directory path', async () => {
  const dir = await setup(), file = path.join(dir, 'file')
  await fs.writeFile(file, 'keep')
  await expect(incarnationFile(file, 0).advance(0)).rejects.toThrow()
  expect(await fs.readFile(file, 'utf8')).toBe('keep')
})
