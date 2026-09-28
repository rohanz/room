import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupOrphanTemps, compareAndRelease, createExclusive, liveness, recover, replace, withGuard, type InstanceToken } from '../src/leases.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function leaseFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-lease-test-'))
  dirs.push(dir)
  return path.join(dir, 'lease.json')
}
const token = (nonce: string, pid = process.pid): InstanceToken => ({ sessionId: 's', pid, startTime: 'birth', executable: 'node', nonce })
const childScript = fileURLToPath(new URL('./fixtures/lease-child.ts', import.meta.url))
const children: ChildProcess[] = []
afterEach(() => { for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL') })
function launch(mode: string, file: string, ready: string, signal = ''): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', childScript, mode, file, ready, signal], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  return child
}
async function untilFile(file: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (fs.existsSync(file)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${file}`)
}
function output(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '', err = ''
    child.stdout?.on('data', chunk => { out += chunk })
    child.stderr?.on('data', chunk => { err += chunk })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve(out) : reject(new Error(`child exited ${code}: ${err}`)))
  })
}

describe('local leases', () => {
  it('admits exactly one of two creators in separate processes', async () => {
    const file = leaseFile()
    const a = launch('create', file, `${file}.a`, `${file}.go`)
    const b = launch('create', file, `${file}.b`, `${file}.go`)
    const doneA = output(a), doneB = output(b)
    await Promise.all([untilFile(`${file}.a`), untilFile(`${file}.b`)])
    fs.writeFileSync(`${file}.go`, '')
    expect([await doneA, await doneB].sort()).toEqual(['lost', 'won'])
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toHaveProperty('child')
  })

  it('guards release against a successor that replaced the old token', () => {
    const file = leaseFile()
    const a = token('a'), b = token('b')
    expect(createExclusive(file, { holder: a })).toBe(true)
    expect(replace(file, value => value.holder.nonce === a.nonce, { holder: b })).toBe(true)
    expect(compareAndRelease(file, a)).toBe(false)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).holder).toEqual(b)
    expect(compareAndRelease(file, b)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('releases a bare run-writer token and admits a successor', () => {
    const file = leaseFile()
    const a = token('writer-a'), b = token('writer-b')
    expect(createExclusive(file, a)).toBe(true)
    expect(compareAndRelease(file, a)).toBe(true)
    expect(createExclusive(file, b)).toBe(true)
    expect(compareAndRelease(file, a)).toBe(false)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(b)
  })

  it('recovers a guard after its owner is killed', async () => {
    const file = leaseFile(), ready = `${file}.ready`
    const child = launch('guard', file, ready)
    await untilFile(ready)
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
    expect(withGuard(file, () => 'recovered')).toBe('recovered')
    expect(fs.existsSync(`${file}.guard`)).toBe(false)
  })

  it('rejects an async guarded callback even when a caller erases its type', () => {
    const file = leaseFile()
    const invalid = () => withGuard(file, (async () => 1) as never)
    expect(invalid).toThrow(/synchronous/)
    expect(fs.existsSync(`${file}.guard`)).toBe(false)
  })

  it('fsyncs parents of newly created directories', () => {
    const file = path.join(path.dirname(leaseFile()), 'new', 'nested', 'lease.json')
    const original = fs.fsyncSync
    let directories = 0
    const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) directories++
      return original(fd)
    })
    try { expect(createExclusive(file, { held: true })).toBe(true) }
    finally { spy.mockRestore() }
    expect(directories).toBeGreaterThanOrEqual(3)
  })

  it('keeps a live writer temp and removes it after that writer dies', async () => {
    const file = leaseFile(), ready = `${file}.ready`
    const child = launch('temp', file, ready)
    await untilFile(ready)
    const temp = fs.readFileSync(ready, 'utf8')
    expect(fs.existsSync(temp)).toBe(true)
    createExclusive(`${file}.other`, {})
    expect(fs.existsSync(temp)).toBe(true)
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
    expect(cleanupOrphanTemps(path.dirname(file), () => ({}))).toBe(0)
    expect(fs.existsSync(temp)).toBe(true)
    createExclusive(`${file}.third`, {})
    expect(fs.existsSync(temp)).toBe(false)
  })

  it('recovers a dead holder after a pid is reused with a different start time', () => {
    const file = leaseFile()
    const dead = token('old', 500)
    expect(liveness(dead, () => ({ startTime: 'new-birth', executable: 'node' }))).toBe('dead')
    expect(liveness(dead, () => ({ startTime: 'new-birth' }))).toBe('dead')
    expect(createExclusive(file, { holder: dead })).toBe(true)
    expect(recover(file, value => value.holder.nonce === 'old', () => ({ startTime: 'new-birth', executable: 'node' }))).toBe(true)
    expect(createExclusive(file, { holder: token('new') })).toBe(true)
  })

  it('recovers a dead bare run-writer token', () => {
    const file = leaseFile()
    const old = token('old-writer', 500)
    expect(createExclusive(file, old)).toBe(true)
    expect(recover(file, value => value.nonce === old.nonce, () => ({ startTime: 'reused', executable: 'node' }))).toBe(true)
    expect(createExclusive(file, token('successor'))).toBe(true)
  })

  it('keeps an unreadable holder until an explicit override', () => {
    const file = leaseFile()
    const old = token('old', 500)
    expect(createExclusive(file, { holder: old })).toBe(true)
    expect(liveness(old, () => ({}))).toBe('unknown')
    expect(recover(file, () => true, () => ({}))).toBe(false)
    expect(fs.existsSync(file)).toBe(true)
  })
})
