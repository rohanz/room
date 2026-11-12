import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cloneId, probeRelay, readRelayInfo, relayFile } from '../src/index.js'

const probe = vi.hoisted(() => vi.fn())
vi.mock('../src/proof.js', async original => ({ ...await original<typeof import('../src/proof.js')>(), relayIdentityProbe: probe }))
const dirs: string[] = []
const commonDir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-negotiation-')); dirs.push(dir); return dir }
afterEach(() => { vi.clearAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const health = (dir: string, extra = {}) => ({ ok: true, local: true, schema: 2, hub: 1, clone: cloneId(dir), ...extra })

describe('local relay contract discovery', () => {
  it('refuses discovery without a negotiation advertisement', async () => {
    const dir = commonDir()
    probe.mockResolvedValue({ timedOut: false, identity: { proven: true, health: health(dir) } })
    expect(await probeRelay(4402, dir, 'key')).toBe('incompatible')
  })

  it.each([{ schema: 3 }, { hub: 9 }, { compat: { bootstrap: 99 } }, { compat: null }])('never treats an authenticated incompatible owner as absent: %j', async extra => {
    const dir = commonDir()
    probe.mockResolvedValue({ timedOut: false, identity: { proven: true, health: health(dir, extra) } })
    expect(await probeRelay(4402, dir, 'key')).toBe('incompatible')
  })

  it('classifies identity before contracts, preserving foreign-owner and slow-host behavior', async () => {
    const dir = commonDir()
    probe.mockResolvedValue({ timedOut: false, identity: { proven: false, health: health(dir, { schema: 3 }) } })
    expect(await probeRelay(4402, dir, 'wrong')).toBe('foreign')
    probe.mockResolvedValue({ timedOut: true })
    expect(await probeRelay(4402, dir, 'key')).toBe('slow')
  })

  it('retains the independent discovery format and compatibility hint without rejecting future extra fields', () => {
    const dir = commonDir(), file = relayFile(dir)
    fs.mkdirSync(path.dirname(file))
    const compat = { bootstrap: 1, hub: { min: 1, max: 1 }, schemas: { read: [2], write: [2] }, capabilities: {} }
    fs.writeFileSync(file, JSON.stringify({ schema: 2, port: 4402, pid: 321, room: 'local/test', startedAt: 1, key: 'key', discovery: 1, compat, future: 'ignored' }))
    expect(readRelayInfo(dir)).toMatchObject({ discovery: 1, compat })
  })
})
