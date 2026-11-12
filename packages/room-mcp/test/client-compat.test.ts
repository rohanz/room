import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CURRENT_COMPAT, selectContract } from '@room/hub-core'
import { compatibilityFromHealth } from '../src/server-compat.js'
import { validateSelection } from '@room/hub-core'
import { checkTeamAdmission } from '../src/session.js'
import { codexRoomCompatibilityMismatch } from '../src/hosts/codex-worker-warning.js'

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
  it.each([undefined, null, {}, { ok: true }, { ok: true, schema: 2, hub: 1 }])('requires a negotiation advertisement (%j)', health => {
    expect(() => compatibilityFromHealth(health)).toThrow(/invalid compatibility contract/)
  })
  it.each([
    ['unreachable', async () => { throw new TypeError('fetch failed') }, 'Cannot reach Room server ws://diagnostic.example: fetch failed'],
    ['interrupted', async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection reset')) } })), 'Cannot reach Room server ws://diagnostic.example: /health response interrupted (connection reset)'],
    ['incompatible', async () => Response.json({ compat: { ...CURRENT_COMPAT, hub: { min: 9, max: 9 } } }), 'Room server ws://diagnostic.example is incompatible:'],
    ['missing health route', async () => new Response('not found', { status: 404 }), 'Room server ws://diagnostic.example is incompatible: /health returned HTTP 404'],
    ['unavailable', async () => new Response('try later', { status: 503 }), 'Room server ws://diagnostic.example is unavailable: /health returned HTTP 503'],
    ['malformed health', async () => new Response('<html>wrong origin</html>'), 'Room server ws://diagnostic.example is incompatible: /health returned malformed JSON'],
  ] as const)('identifies an %s server in one line before admission', async (_case, health, expected) => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/config')) return Response.json({})
      if (url.endsWith('/health')) return health()
      throw new Error('admission must not run')
    })
    vi.stubGlobal('fetch', fetcher)
    try {
      const error = await checkTeamAdmission('ws://diagnostic.example', 'example/repo', { dir: '.', credentialsPath: '/nonexistent/credentials.json' }).catch(error => error as Error)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(expected)
      expect((error as Error).message).not.toMatch(/[\r\n]/)
      expect(fetcher.mock.calls.some(([url]) => url.endsWith('/view-token'))).toBe(false)
    } finally { vi.unstubAllGlobals() }
  })
  it('rejects malformed explicit advertisements instead of treating them as legacy', () => {
    expect(() => compatibilityFromHealth({ ok: true, schema: 2, hub: 1, compat: null })).toThrow(/Room server.*invalid compatibility contract/)
  })
  it('accepts ranges independently of release and rejects explicit no overlap without fallback', () => {
    expect(compatibilityFromHealth({ ok: true, compat: { ...CURRENT_COMPAT, release: '99.0.0' } }).release).toBe('99.0.0')
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
