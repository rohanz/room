import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { acquireOwnedFile } from '../src/owned-file.js'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'room-owned-file-'))
  dirs.push(dir)
  return join(dir, 'reservation')
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
  if (child.error || !child.pid) throw child.error ?? new Error('child had no pid')
  return child.pid
}

it('serializes two contenders that saw the same dead owner', () => {
  const file = fixture()
  fs.writeFileSync(file, JSON.stringify({ pid: deadPid(), nonce: 'dead' }))
  const read = fs.readFileSync.bind(fs)
  let interleaved = false
  let second: (() => void) | undefined
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((path: Parameters<typeof fs.readFileSync>[0], options?: Parameters<typeof fs.readFileSync>[1]) => {
    const contents = read(path, options as never)
    if (path === file && !interleaved) {
      interleaved = true
      second = acquireOwnedFile(file, { pid: process.pid, contender: 'second' })
    }
    return contents
  }) as typeof fs.readFileSync)
  try {
    const first = acquireOwnedFile(file, { pid: process.pid, contender: 'first' })
    expect(interleaved).toBe(true)
    expect(first).toBeUndefined()
    expect(second).toBeTypeOf('function')
    expect(JSON.parse(read(file, 'utf8')).contender).toBe('second')
    second?.()
    expect(fs.existsSync(file)).toBe(false)
  } finally { spy.mockRestore() }
})

it('never removes a live owner’s reservation', () => {
  const file = fixture()
  const contents = JSON.stringify({ pid: process.pid, nonce: 'live' })
  fs.writeFileSync(file, contents)
  expect(acquireOwnedFile(file, { pid: process.pid })).toBeUndefined()
  expect(fs.readFileSync(file, 'utf8')).toBe(contents)
})

it('releases only the reservation bearing its nonce', () => {
  const file = fixture()
  const release = acquireOwnedFile(file, { pid: process.pid })
  expect(release).toBeTypeOf('function')
  const replacement = JSON.stringify({ pid: process.pid, nonce: 'replacement' })
  fs.writeFileSync(file, replacement)
  release?.()
  expect(fs.readFileSync(file, 'utf8')).toBe(replacement)
})

it('reclaims a crashed recovery guard before replacing a dead reservation', () => {
  const file = fixture()
  fs.writeFileSync(file, JSON.stringify({ pid: deadPid(), nonce: 'dead-lock' }))
  fs.writeFileSync(`${file}.recover`, JSON.stringify({ pid: deadPid(), nonce: 'dead-guard' }))
  const release = acquireOwnedFile(file, { pid: process.pid })
  expect(release).toBeTypeOf('function')
  expect(fs.existsSync(`${file}.recover`)).toBe(false)
  release?.()
  expect(fs.existsSync(file)).toBe(false)
})

it('recovers a legacy choice lock containing only a dead pid', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'room-choice-'))
  dirs.push(dir)
  const file = join(dir, 'room-choice.json.lock')
  fs.writeFileSync(file, String(deadPid()))
  const release = acquireOwnedFile(file, { pid: process.pid })
  expect(release).toBeTypeOf('function')
  release?.()
})

it('recovers a plain dead pid in any reservation file', () => {
  const file = fixture()
  fs.writeFileSync(file, String(deadPid()))
  const release = acquireOwnedFile(file, { pid: process.pid })
  expect(release).toBeTypeOf('function')
  release?.()
})

it('leaves malformed and empty reservations untouched', () => {
  const file = fixture()
  for (const contents of ['', '{bad json']) {
    fs.writeFileSync(file, contents)
    expect(acquireOwnedFile(file, { pid: process.pid })).toBeUndefined()
    expect(fs.readFileSync(file, 'utf8')).toBe(contents)
  }
})
