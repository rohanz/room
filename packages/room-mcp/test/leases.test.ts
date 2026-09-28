import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compareAndRelease, createExclusive, liveness, recover, replace, type InstanceToken } from '../src/leases.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function leaseFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-lease-test-'))
  dirs.push(dir)
  return path.join(dir, 'lease.json')
}
const token = (nonce: string, pid = process.pid): InstanceToken => ({ sessionId: 's', pid, startTime: 'birth', executable: 'node', nonce })

describe('local leases', () => {
  it('admits exactly one of two exclusive creators', async () => {
    const file = leaseFile()
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => createExclusive(file, { holder: token('a') })),
      Promise.resolve().then(() => createExclusive(file, { holder: token('b') })),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).holder.nonce).toBe(a ? 'a' : 'b')
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

  it('recovers a dead holder after a pid is reused with a different start time', () => {
    const file = leaseFile()
    const dead = token('old', 500)
    expect(liveness(dead, () => ({ startTime: 'new-birth', executable: 'node' }))).toBe('dead')
    expect(liveness(dead, () => ({ startTime: 'new-birth' }))).toBe('dead')
    expect(createExclusive(file, { holder: dead })).toBe(true)
    expect(recover(file, value => value.holder.nonce === 'old', () => ({ startTime: 'new-birth', executable: 'node' }))).toBe(true)
    expect(createExclusive(file, { holder: token('new') })).toBe(true)
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
