import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CURRENT_COMPAT, selectContract } from '@room/hub-core'
import { compatibilityFromHealth, compatibilityFloor, validateSelection } from '../src/client-compat.js'
import { checkTeamAdmission } from '../src/session.js'
import { codexRoomCompatibilityMismatch } from '../src/worker-config.js'

const selection = { bootstrap: 1 as const, hub: 1, schema: 2, capabilities: { 'room.generation': 1, 'room.manifest': 1, 'room.ledger': 1 } }
describe('client compatibility', () => {
  it.each([
    ['ws://plain.example:1234', 'http://plain.example:1234'],
    ['wss://secure.example', 'https://secure.example'],
  ])('discovers and negotiates team admission at %s', async (server, origin) => {
    const dir = mkdtempSync(join(tmpdir(), 'room-compat-transport-'))
    execFileSync('git', ['init', '-q', dir])
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `${origin}/auth/config`) return Response.json({})
      if (url === `${origin}/health`) return Response.json({ ok: true, compat: CURRENT_COMPAT })
      if (url === `${origin}/view-token`) {
        const request = JSON.parse(String(init?.body))
        expect(request).toMatchObject({ room: 'example/repo', compat: CURRENT_COMPAT })
        const contract = selectContract(request.compat, CURRENT_COMPAT, { activeSchema: 2 })
        expect(contract).toMatchObject({ ok: true, selection })
        return Response.json({ view: 'v', hub: 1 })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetcher)
    try {
      await expect(checkTeamAdmission(server, 'example/repo', { dir, credentialsPath: join(dir, 'credentials.json') })).resolves.toBeUndefined()
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${origin}/auth/config`, `${origin}/health`, `${origin}/view-token`])
    } finally {
      vi.unstubAllGlobals()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it.each([undefined, null, {}, { ok: true }, { ok: true, schema: 1, hub: 1 }, { ok: true, schema: 2, hub: 1 }])('uses only the fixed legacy adapter without an advertisement (%j), unless a floor was learned', health => {
    expect(compatibilityFromHealth(health)).toMatchObject({ legacy: true, offer: { hub: { min: 1, max: 1 }, schemas: { read: [2], write: [2] } } })
    expect(() => compatibilityFromHealth(health, true)).toThrow('Room server negotiation advertisement disappeared; refusing a protocol downgrade. Restore negotiation on the server and reconnect Room (/mcp) or restart the session')
  })
  it.each(['ws://legacy-plain.example', 'wss://legacy-secure.example'])('preserves admission refusal wording at %s when discovery is unavailable or absent', async server => {
    const dir = mkdtempSync(join(tmpdir(), 'room-compat-legacy-'))
    execFileSync('git', ['init', '-q', dir])
    let healthResponse = () => Response.json({ ok: true })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname
      if (path === '/auth/config') return Response.json({})
      if (path === '/health') return healthResponse()
      expect(path).toBe('/view-token')
      expect(JSON.parse(String(init?.body))).not.toHaveProperty('compat')
      return new Response('not a collaborator', { status: 403 })
    }))
    try {
      for (const response of [
        () => Response.json({ ok: true }),
        () => new Response('not found', { status: 404 }),
        () => { throw new TypeError('fetch failed') },
        () => new Response('not JSON'),
      ]) {
        healthResponse = response
        await expect(checkTeamAdmission(server, 'example/repo', { dir, credentialsPath: join(dir, 'credentials.json') })).rejects.toMatchObject({ message: `${server} refused example/repo: not a collaborator` })
      }
      compatibilityFloor(join(dir, '.git'), new URL(server).origin).remember()
      await expect(checkTeamAdmission(server, 'example/repo', { dir, credentialsPath: join(dir, 'credentials.json') })).rejects.toThrow(/advertisement disappeared; refusing a protocol downgrade/)
    } finally {
      vi.unstubAllGlobals()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('rejects malformed explicit advertisements instead of treating them as legacy', () => {
    expect(() => compatibilityFromHealth({ ok: true, schema: 2, hub: 1, compat: null })).toThrow(/Room server.*invalid compatibility contract/)
  })
  it('accepts ranges independently of release and rejects explicit no overlap without fallback', () => {
    expect(compatibilityFromHealth({ ok: true, compat: { ...CURRENT_COMPAT, release: '99.0.0' } }).legacy).toBe(false)
    expect(() => compatibilityFromHealth({ ok: true, schema: 2, hub: 1, compat: { ...CURRENT_COMPAT, hub: { min: 9, max: 9 } } })).toThrow()
  })
  it('rejects a server selection outside the offer or required capabilities', () => {
    expect(() => validateSelection(selection, CURRENT_COMPAT, CURRENT_COMPAT)).not.toThrow()
    expect(() => validateSelection({ ...selection, hub: 9 }, CURRENT_COMPAT, CURRENT_COMPAT)).toThrow()
    expect(() => validateSelection({ ...selection, capabilities: { ...selection.capabilities, unknown: 1 } }, CURRENT_COMPAT, CURRENT_COMPAT)).toThrow()
    expect(() => validateSelection({ ...selection, capabilities: {} }, { ...CURRENT_COMPAT, requiredCapabilities: { 'room.generation': [1] } }, CURRENT_COMPAT)).toThrow()
  })
})

it('worker preflight compares executable wire and record contracts, not releases', () => {
  const lead = { release: '0.17.32', compat: CURRENT_COMPAT, workerRecordSchema: 1 }
  expect(codexRoomCompatibilityMismatch(lead, { ...lead, release: '0.17.99' })).toBeUndefined()
  expect(codexRoomCompatibilityMismatch(lead, { ...lead, release: '0.18.0', workerRecordSchema: 2 })).toMatch(/reconnect Room.*\/mcp.*restart/i)
  expect(codexRoomCompatibilityMismatch(lead, { ...lead, release: '0.16.40', compat: { ...CURRENT_COMPAT, hub: { min: 9, max: 9 } } })).toMatch(/Codex|update/i)
  expect(codexRoomCompatibilityMismatch(lead, undefined)).toMatch(/unverified/i)
})

it('persists a learned floor across connections and refuses a changed local key identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-compat-floor-'))
  try {
    const first = compatibilityFloor(dir, 'local:canonical-git-common-dir', 'key-fingerprint')
    expect(first.learned()).toBe(false); first.remember()
    expect(compatibilityFloor(dir, 'local:canonical-git-common-dir', 'key-fingerprint').learned()).toBe(true)
    expect(() => compatibilityFloor(dir, 'local:canonical-git-common-dir', 'changed-key').learned()).toThrow()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
