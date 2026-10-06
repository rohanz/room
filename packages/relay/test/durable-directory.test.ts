import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { writeAtomic } from '../src/leases.js'

const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const setup = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-durable-')); dirs.push(dir); return dir }

it('writes below an existing root that rejects mkdir with Windows EPERM', () => {
  const dir = setup(), root = path.parse(dir).root
  const mkdir = fs.mkdirSync.bind(fs)
  vi.spyOn(fs, 'mkdirSync').mockImplementation((target, options) => {
    if (String(target) === root) throw Object.assign(new Error('Windows root mkdir'), { code: 'EPERM' })
    return mkdir(target, options)
  })
  const file = path.join(dir, 'new', 'nested', 'record.json')
  writeAtomic(file, { value: 1 })
  writeAtomic(file, { value: 2 })
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ value: 2 })
})

it('still syncs an existing ancestor when another writer wins mkdir', () => {
  const dir = setup(), raced = path.join(dir, 'raced')
  const mkdir = fs.mkdirSync.bind(fs)
  let racedOnce = false
  vi.spyOn(fs, 'mkdirSync').mockImplementation((target, options) => {
    if (String(target) === raced && !racedOnce) { racedOnce = true; mkdir(target, options) }
    return mkdir(target, options)
  })
  const open = vi.spyOn(fs, 'openSync')
  const sync = vi.spyOn(fs, 'fsyncSync')
  const file = path.join(raced, 'record.json')
  writeAtomic(file, { value: 1 })
  const parentOpen = open.mock.calls.findIndex(([target]) => String(target) === dir)
  expect(racedOnce).toBe(true)
  expect(parentOpen).toBeGreaterThanOrEqual(0)
  const opened = open.mock.results[parentOpen]
  if (opened.type === 'return') expect(sync).toHaveBeenCalledWith(opened.value)
  else expect(['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM']).toContain(opened.value.code)
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ value: 1 })
})

it('does not suppress permission errors below the root', () => {
  const dir = setup(), denied = path.join(dir, 'denied'), mkdir = fs.mkdirSync.bind(fs)
  vi.spyOn(fs, 'mkdirSync').mockImplementation((target, options) => {
    if (String(target) === denied) throw Object.assign(new Error('denied'), { code: 'EPERM' })
    return mkdir(target, options)
  })
  expect(() => writeAtomic(path.join(denied, 'record.json'), {})).toThrow('denied')
})

it('refuses a file in the directory path', () => {
  const dir = setup(), file = path.join(dir, 'file')
  fs.writeFileSync(file, 'keep')
  expect(() => writeAtomic(path.join(file, 'record.json'), {})).toThrow()
  expect(fs.readFileSync(file, 'utf8')).toBe('keep')
})
