import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createProcessProbe, pidAlive, probeProcess } from '../src/process.js'
import { cleanupOrphanTemps, liveness, recover } from '../src/leases.js'

afterEach(() => vi.restoreAllMocks())

it.each(['EPERM', 'EINVAL', 'ERR_INVALID_ARG_TYPE', 'EIO', undefined])('retains uncertainty on probe error %s', code => {
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('probe failed'), { code }) })
  expect(pidAlive(123)).toBe(true)
})
it('only ESRCH proves a pid gone', () => {
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
  expect(pidAlive(123)).toBe(false)
})
it.each([2147483648, Number.MAX_SAFE_INTEGER, 0, -1, 1.5, NaN, Infinity, '42', null, undefined])('never probes or declares invalid pid %s dead', value => {
  const pid = value as number
  const kill = vi.spyOn(process, 'kill')
  expect(pidAlive(pid)).toBe(true)
  expect(probeProcess(pid)).toEqual({})
  expect(liveness({ pid, startTime: 'old', executable: 'node' }, () => undefined)).toBe('unknown')
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const fail = () => { throw new Error('must not read invalid pid') }
    const probe = createProcessProbe({ platform, readFile: fail, readLink: fail, exec: fail, alive: () => false })
    expect(probe(pid)).toEqual({})
    expect(probe.fresh(pid)).toEqual({})
    expect(probe.confirm(pid, {})).toEqual({})
  }
  expect(kill).not.toHaveBeenCalled()
})
it.each(['2147483648', '0', '01', '-1', '1.5'])('keeps atomic temps with invalid/non-Room pid spelling %s', pid => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-invalid-temp-'))
  try {
    const file = path.join(dir, 'state.roomtmp-p' + pid + '-su-n12345678-1234-1234-1234-123456789abc.tmp')
    fs.writeFileSync(file, 'partial')
    expect(cleanupOrphanTemps(dir, () => undefined)).toBe(0)
    expect(fs.readFileSync(file, 'utf8')).toBe('partial')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

it('keeps a lease whose recorded owner has an invalid pid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-invalid-lease-'))
  try {
    const file = path.join(dir, 'owner.lock')
    const text = JSON.stringify({ pid: 2147483648, startTime: 'old', executable: 'node', sessionId: 'test', nonce: 'test' })
    fs.writeFileSync(file, text)
    expect(recover(file, () => true)).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe(text)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
