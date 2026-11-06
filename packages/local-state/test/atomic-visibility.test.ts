import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createExclusive, withGuard, writeAtomic } from '../src/leases.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-atomic-'))
  roots.push(dir)
  return path.join(dir, 'room', 'tickets', 'record.json')
}

it('publishes complete private JSON and releases a guard without fsync when explicitly non-durable', () => {
  const file = fixture(), sync = vi.spyOn(fs, 'fsyncSync')
  const link = fs.linkSync.bind(fs)
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    expect(() => JSON.parse(fs.readFileSync(from, 'utf8'))).not.toThrow()
    if (process.platform !== 'win32') expect(fs.statSync(from).mode & 0o777).toBe(0o600)
    return link(from, to)
  })
  withGuard(file, () => {
    expect(createExclusive(file, { first: true }, { durable: false })).toBe(true)
    expect(createExclusive(file, { overwrite: true }, { durable: false })).toBe(false)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ first: true })
    writeAtomic(file, { next: true }, { durable: false })
  }, undefined, { durable: false })
  expect(sync).not.toHaveBeenCalled()
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ next: true })
  expect(fs.readdirSync(path.dirname(file))).toEqual(['record.json'])
})

it('retains fsync durability by default even after non-durable directory creation', () => {
  const file = fixture()
  createExclusive(file, {}, { durable: false })
  const sync = vi.spyOn(fs, 'fsyncSync')
  writeAtomic(file, { durable: true })
  expect(sync).toHaveBeenCalled()
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ durable: true })
})

it('removes a non-durable guard on callback failure and leaves no partial publication', () => {
  const file = fixture(), sync = vi.spyOn(fs, 'fsyncSync')
  expect(() => withGuard(file, () => { throw new Error('failed') }, undefined, { durable: false })).toThrow('failed')
  expect(fs.readdirSync(path.dirname(file))).toEqual([])
  expect(sync).not.toHaveBeenCalled()
})
