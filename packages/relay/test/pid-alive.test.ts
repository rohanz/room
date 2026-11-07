import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pidAlive, probeProcess, validPid } from '../src/process.js'
import { cleanupOrphanTemps } from '../src/leases.js'
import { exitedPid } from './exited-pid.js'

afterEach(() => vi.restoreAllMocks())
it.each([0, -1, 1.5, 2147483648, NaN, Infinity, '12', null, undefined])('keeps malformed pid %s unknown without signalling', pid => {
  const kill = vi.spyOn(process, 'kill')
  expect(validPid(pid)).toBe(false)
  expect(pidAlive(pid as number)).toBe(true)
  expect(probeProcess(pid as number)).toEqual({})
  expect(kill).not.toHaveBeenCalled()
})
it.each(['EPERM', 'EINVAL', 'ERR_INVALID_ARG_TYPE', 'EIO', 'ESRCH'])('only ESRCH is death: %s', code => {
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(code), { code }) })
  expect(pidAlive(123)).toBe(code !== 'ESRCH')
})
it('recognizes a real exited child', () => expect(pidAlive(exitedPid())).toBe(false))
it('retains an invalid-pid atomic temp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invalid-temp-'))
  try {
    const file = path.join(dir, 'record.roomtmp-p2147483648-su-n00000000-0000-0000-0000-000000000000.tmp')
    fs.writeFileSync(file, '')
    expect(cleanupOrphanTemps(dir)).toBe(0)
    expect(fs.existsSync(file)).toBe(true)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
