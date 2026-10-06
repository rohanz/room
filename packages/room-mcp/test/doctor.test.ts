import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { CODEX_ROOM_HOOKS_FILE_SHA256, CODEX_ROOM_HOOK_HASHES, claudePlugin, codexPlugin, codexHooksRoot, codexRoomHookTrustStatus, codexRoomHooksTrusted, evaluateDoctor, formatDoctor, hookVersion, probeHealth, probeCredential, runDoctor, type DoctorFacts } from '../src/doctor.js'
import type { Session } from '../src/session.js'

const version = '0.17.11'
const trust = `[hooks.state."room@room:hooks.json:pre_tool_use:0:0"]
trusted_hash = "${CODEX_ROOM_HOOK_HASHES['pre_tool_use:0:0']}"
[hooks.state."room@room:hooks.json:session_start:0:0"]
trusted_hash = "${CODEX_ROOM_HOOK_HASHES['session_start:0:0']}"`
const base = (): DoctorFacts => ({ node: 'v22.14.0', git: 'git version 2.39.0', repo: true,
  claudeCli: true, codexCli: true, claude: { version }, codex: { version }, claudeVersion: '2.1.285',
  claudeHooks: `export const HOOKS_VERSION = '${version}'`, codexHooks: `export const HOOKS_VERSION = '${version}'`,
  codexTrust: trust, wakeSession: true, wakeBound: true, relayFile: '/tmp/relay.json', relayHealth: true,
  inSession: true })

describe('doctor report', () => {
  it.each(['directory', 'git'])('reads the loaded plugin for %s marketplace installs on both hosts', source => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'room-doctor-versions-'))
    const marketRoot = path.join(root, 'marketplace')
    const claudeCache = path.join(root, 'claude-cache')
    const codexHome = path.join(root, 'codex')
    const codexCache = path.join(codexHome, 'plugins', 'cache', 'room', 'room', '0.8.0')
    const writeManifest = (pluginRoot: string, host: 'claude' | 'codex', loadedVersion: string) => {
      const manifestDir = path.join(pluginRoot, host === 'claude' ? '.claude-plugin' : '.codex-plugin')
      mkdirSync(manifestDir, { recursive: true })
      writeFileSync(path.join(manifestDir, 'plugin.json'), JSON.stringify({ name: 'room', version: loadedVersion }))
    }
    const writeHooks = (pluginRoot: string) => {
      mkdirSync(path.join(pluginRoot, 'hooks'), { recursive: true })
      writeFileSync(path.join(pluginRoot, 'hooks', 'common.mjs'), `export const HOOKS_VERSION = '${version}'`)
    }
    const claudeLoadedRoot = source === 'directory' ? path.join(marketRoot, 'plugins', 'room') : claudeCache
    writeManifest(claudeLoadedRoot, 'claude', source === 'directory' ? version : '0.8.0')
    writeHooks(claudeLoadedRoot)
    if (source === 'directory') writeManifest(claudeCache, 'claude', '0.8.0')
    writeManifest(codexCache, 'codex', '0.8.0')
    const codexHooks = path.join(marketRoot, 'plugins', 'room')
    writeHooks(codexHooks)
    const claudeMarkets = [{ name: 'room', source, path: marketRoot, installLocation: marketRoot }]
    const codexMarkets = { marketplaces: [{ name: 'room', root: marketRoot, marketplaceSource: { sourceType: source } }] }
    const claude = claudePlugin({ version: '0.8.0', installPath: claudeCache }, claudeMarkets)
    const codex = codexPlugin({ version: '0.8.0', marketplaceName: 'room' }, codexMarkets, codexHome)
    expect(claude).toMatchObject({ version: source === 'directory' ? version : '0.8.0', root: claudeLoadedRoot, recordedVersion: '0.8.0' })
    expect(codex).toMatchObject({ version: '0.8.0', root: codexCache, hooksRoot: codexHooks })
    const rows = evaluateDoctor({ ...base(), claude, codex })
    expect(rows.find(r => r.name === 'Claude Code')?.level).toBe(source === 'directory' ? 'PASS' : 'FAIL')
    if (source === 'directory') expect(rows.find(r => r.name === 'Claude Code install record')).toMatchObject({ level: 'WARN', fix: 'claude plugin update room@room' })
    else expect(rows.find(r => r.name === 'Claude Code install record')).toBeUndefined()
    expect(rows.find(r => r.name === 'Codex')).toMatchObject({ level: 'FAIL', fix: 'codex plugin marketplace upgrade room && codex plugin add room@room' })
    if (source === 'directory') {
      writeManifest(claudeLoadedRoot, 'claude', '0.8.0')
      expect(evaluateDoctor({ ...base(), claude: claudePlugin({ version: '0.8.0', installPath: claudeCache }, claudeMarkets) })
        .find(r => r.name === 'Claude Code')).toMatchObject({ level: 'FAIL', fix: 'claude plugin marketplace update room && claude plugin update room@room' })
    }
    writeManifest(codexCache, 'codex', version)
    expect(evaluateDoctor({ ...base(), codex: codexPlugin({ version: '0.8.0', marketplaceName: 'room' }, codexMarkets, codexHome) })
      .find(r => r.name === 'Codex')?.level).toBe('PASS')
  })
  it('finds Codex hooks in the marketplace root, including a Git snapshot', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'room-doctor-market-'))
    mkdirSync(path.join(root, '.agents', 'plugins'), { recursive: true })
    writeFileSync(path.join(root, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'room', source: { source: 'local', path: './plugins/room' } }] }))
    const markets = { marketplaces: [{ name: 'other', root: '/elsewhere' }, { name: 'room', root, marketplaceSource: { sourceType: 'git', source: 'rohanz/room' } }] }
    expect(codexHooksRoot(markets, 'room')).toBe(path.join(root, 'plugins', 'room'))
    expect(codexHooksRoot(markets, 'missing')).toBeUndefined()
    expect(codexHooksRoot({ marketplaces: [{ name: 'room', root: '/no/listing' }] }, 'room')).toBe(path.join('/no/listing', 'plugins', 'room'))
  })
  it('passes a healthy local installation', () => {
    const rows = evaluateDoctor(base())
    expect(rows.every(r => r.level === 'PASS')).toBe(true)
    expect(formatDoctor(rows).split('\n').length).toBeLessThan(25)
  })
  it('warns while a Room 0.16 local relay still serves the clone', () => {
    const rows = evaluateDoctor({ ...base(), legacyRelay: true })
    expect(rows.find(r => r.name === 'Room 0.16 session')).toMatchObject({ level: 'WARN' })
    expect(evaluateDoctor(base()).some(r => r.name === 'Room 0.16 session')).toBe(false)
  })
  it('warns with the canonical relay collision sentence and fix', () => {
    const warning = "an older Room session (pid 321) still holds this room's relay on 127.0.0.1:46115; quit it or reconnect Room there"
    expect(evaluateDoctor({ ...base(), canonicalRelayWarning: warning }).find(r => r.name === 'canonical relay'))
      .toMatchObject({ level: 'WARN', finding: warning, fix: 'Quit the older Room session or reconnect Room there' })
  })
  it('reports old runtimes, missing commit, stale host bundles and hooks', () => {
    const f = { ...base(), node: 'v20.0.0', git: 'git version 2.30.9', repo: false,
      claude: { version: '0.16.40' }, codexHooks: undefined }
    const rows = evaluateDoctor(f)
    expect(rows.filter(r => r.level === 'FAIL').map(r => r.name)).toEqual(expect.arrayContaining(['Node', 'Git', 'repository', 'Claude Code', 'Codex hooks']))
    expect(formatDoctor(rows)).toContain('fix:')
  })
  it('reports absent hosts, untrusted hooks, wake and server failures', () => {
    const f = { ...base(), claudeCli: false, claude: undefined, codexTrust: '',
      wakeBound: false, server: 'wss://example.com', serverHealth: false, credential: false,
      relayFile: undefined, stale: 'restart needed' }
    const rows = evaluateDoctor(f)
    expect(rows.find(r => r.name === 'Claude Code')?.finding).toBe('not installed')
    expect(rows.filter(r => r.level === 'WARN').map(r => r.name)).toEqual(expect.arrayContaining(['team server', 'team login', 'running session']))
    expect(rows.find(r => r.name === 'Codex hook trust')?.level).toBe('FAIL')
  })
  it('keeps absent relay and CLI session nonfatal', () => {
    const f = { ...base(), claudeCli: false, codexCli: false, claude: undefined, codex: undefined,
      relayFile: undefined, inSession: false, wakeSession: false }
    const rows = evaluateDoctor(f)
    expect(rows.find(r => r.name === 'Room hosts')?.level).toBe('WARN')
    expect(rows.find(r => r.name === 'local relay')?.level).toBe('PASS')
    expect(rows.find(r => r.name === 'running session')?.finding).toBe('n/a')
  })
  it('reports an old wake path, relay outage, and invalid server setting', () => {
    const f = { ...base(), claudeVersion: '2.1.223', wakeBound: false, relayHealth: false }
    const rows = evaluateDoctor(f)
    expect(rows.filter(r => r.level === 'WARN').map(r => r.name)).toEqual(expect.arrayContaining(['Claude wake', 'Claude inbox', 'local relay']))
    expect(evaluateDoctor({ ...f, configError: 'ROOM_URL must use ws:// or wss://' }).find(r => r.name === 'Room config')?.level).toBe('FAIL')
  })
  it('distinguishes missing plugins from a failed host query', () => {
    const f = { ...base(), claude: undefined, codex: undefined }
    expect(evaluateDoctor(f).find(r => r.name === 'Room hosts')?.level).toBe('WARN')
    expect(evaluateDoctor({ ...f, claudeListOk: false }).find(r => r.name === 'Claude Code')?.finding).toBe('plugin list unavailable')
  })
  it('parses only both Room hook trust entries and stamps', () => {
    expect(codexRoomHooksTrusted(trust)).toBe(true)
    expect(codexRoomHooksTrusted(trust.replace('session_start', 'other'))).toBe(false)
    expect(codexRoomHookTrustStatus(trust.replace(CODEX_ROOM_HOOK_HASHES['pre_tool_use:0:0'], `sha256:${'0'.repeat(64)}`))).toBe('modified')
    expect(evaluateDoctor({ ...base(), codexTrust: trust.replace(CODEX_ROOM_HOOK_HASHES['pre_tool_use:0:0'], `sha256:${'0'.repeat(64)}`) }).find(r => r.name === 'Codex hook trust')).toMatchObject({ level: 'WARN' })
    expect(codexRoomHookTrustStatus(trust.replace('session_start', 'other'))).toBe('absent')
    expect(hookVersion('no stamp')).toBeUndefined()
    const root = fileURLToPath(new URL('../../../plugins/room/', import.meta.url))
    expect(createHash('sha256').update(readFileSync(root + 'hooks.json')).digest('hex')).toBe(CODEX_ROOM_HOOKS_FILE_SHA256)
    const hooks = readFileSync(root + 'hooks/common.mjs', 'utf8')
    const manifest = JSON.parse(readFileSync(root + '.claude-plugin/plugin.json', 'utf8')) as { version: string }
    expect(hookVersion(hooks)).toBe(manifest.version)
  })
  it('does not follow a redirected health probe', async () => {
    const fetcher = vi.fn(async (_url: string, opts: RequestInit) => {
      expect(opts.redirect).toBe('manual')
      return { ok: false, status: 302 } as Response
    })
    expect(await probeHealth('https://fixture.invalid/health', fetcher as unknown as typeof fetch)).toEqual({ ok: false, redirect: 'HTTP 302' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(evaluateDoctor({ ...base(), server: 'wss://fixture.invalid', serverHealth: false, serverRedirect: 'HTTP 302' }).find(r => r.name === 'team server')).toMatchObject({ level: 'WARN', finding: 'server redirected /health (HTTP 302); check ROOM_SERVER' })
  })
  it('reads health protocol and storage with a timeout', async () => {
    const fetcher = vi.fn(async (_url: string, opts: RequestInit) => {
      expect(opts.signal).toBeDefined()
      return { ok: true, status: 200, json: async () => ({ ok: true, schema: 2, hub: 1, storage: 'failing' }) } as Response
    })
    expect(await probeHealth('https://fixture.invalid/health', fetcher as unknown as typeof fetch)).toEqual({ ok: true, schema: 2, hub: 1, storage: 'failing' })
  })
  it('checks the server schema and hub protocol, including storage failure', () => {
    const healthy = { ...base(), server: 'wss://fixture.invalid', serverHealth: true, serverSchema: 2, serverHub: 1 }
    expect(evaluateDoctor(healthy).find(r => r.name === 'team server')).toMatchObject({ level: 'PASS' })
    expect(evaluateDoctor({ ...healthy, serverSchema: undefined }).find(r => r.name === 'team server')).toMatchObject({ level: 'FAIL', finding: 'the server is older than Room 0.17: deploy 0.17' })
    expect(evaluateDoctor({ ...healthy, serverHub: 2 }).find(r => r.name === 'team server')).toMatchObject({ level: 'FAIL', finding: 'server schema 2, hub 2; need schema 2, hub 1' })
    expect(evaluateDoctor({ ...healthy, serverStorage: 'failing' }).find(r => r.name === 'team server')).toMatchObject({ level: 'FAIL', finding: "the server's storage is failing" })
  })
  it('validates a saved credential in a header without putting it in the URL', async () => {
    const fetcher = vi.fn(async (url: string, opts: RequestInit) => {
      expect(url).toBe('https://fixture.invalid/auth/me')
      expect(opts.headers).toEqual({ Authorization: 'Bearer secret' })
      expect(opts.signal).toBeDefined()
      return { status: 200, ok: true, json: async () => ({ login: 'rohan' }) } as Response
    })
    expect(await probeCredential('https://fixture.invalid/auth/me', 'secret', fetcher as unknown as typeof fetch)).toEqual({ status: 'valid', login: 'rohan' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('distinguishes rejected credentials from old servers and network failures', async () => {
    const rejected = vi.fn(async () => ({ status: 401, ok: false }) as Response)
    expect(await probeCredential('https://fixture.invalid/auth/me', 'secret', rejected as unknown as typeof fetch)).toEqual({ status: 'rejected' })
    const failed = vi.fn(async () => { throw new Error('offline') })
    expect(await probeCredential('https://fixture.invalid/auth/me', 'secret', failed as unknown as typeof fetch)).toEqual({ status: 'unverified' })
    const healthy = { ...base(), server: 'wss://fixture.invalid', serverHealth: true, serverSchema: 2, serverHub: 1, credential: true }
    expect(evaluateDoctor({ ...healthy, credentialStatus: 'valid', credentialLogin: 'rohan' }).find(r => r.name === 'team login')).toMatchObject({ level: 'PASS', finding: 'logged in as rohan' })
    expect(evaluateDoctor({ ...healthy, credentialStatus: 'rejected' }).find(r => r.name === 'team login')).toMatchObject({ level: 'FAIL', finding: 'saved credential was rejected; log in again (room_login)' })
    expect(evaluateDoctor({ ...healthy, serverSchema: undefined, credentialStatus: 'rejected' }).find(r => r.name === 'team login')).toMatchObject({ level: 'WARN', finding: 'credential present; the server did not confirm it' })
    expect(evaluateDoctor({ ...healthy, credentialStatus: 'unverified' }).find(r => r.name === 'team login')).toMatchObject({ level: 'WARN', finding: 'credential present (not verified)' })
  })
})

vi.mock('../src/doctor.js', async original => {
  const actual = await original<typeof import('../src/doctor.js')>()
  return { ...actual, runDoctor: vi.fn(async () => 'PASS  doctor: report from tool') }
})

it('room_state check works before a session joins', async () => {
  const { createTools } = await import('../src/tools.js')
  const tools = createTools({ getSession: () => null, setSession: () => {}, cwd: '/not/a/repository' })
  expect(await tools.call('room_state', { check: true })).toContain('PASS  doctor: report from tool')
})

it.each(['in progress', 'failed'])('room_state check bypasses an %s automatic join', async state => {
  const { createTools } = await import('../src/tools.js')
  const tools = createTools({ getSession: () => null, setSession: () => {}, cwd: '/not/a/repository' })
  const ensure = vi.fn(state === 'failed' ? () => { throw new Error('AUTO_JOIN_TOUCHED') } : () => new Promise<void>(() => {}))
  const settle = vi.fn(state === 'failed' ? () => Promise.reject(new Error('AUTO_JOIN_TOUCHED')) : () => new Promise<void>(() => {}))
  tools.setAutoJoin({ ensure, settle, cancel() {}, retarget() {}, ...(state === 'failed' ? { failure: 'join failed' } : {}) })
  expect(await tools.call('room_state', { check: true })).toBe('PASS  doctor: report from tool')
  expect(ensure).not.toHaveBeenCalled()
  expect(settle).not.toHaveBeenCalled()
})

it('room_state check diagnoses a never-synced session and its selected checkout', async () => {
  const { createTools } = await import('../src/tools.js')
  const doctor = vi.mocked(runDoctor)
  doctor.mockClear()
  let active: Session | null = null
  const tools = createTools({ getSession: () => active, setSession: s => { active = s }, cwd: '/original/checkout' })
  active = { dir: '/selected/checkout', roomUrl: 'wss://selected.example/repository', roomName: 'repository', token: 'test-token', provider: { synced: false }, daemon: { touch: vi.fn() } } as unknown as Session
  expect(await tools.call('room_state', { check: true })).toBe('PASS  doctor: report from tool')
  expect(doctor).toHaveBeenCalledWith('/selected/checkout', true, { server: 'wss://selected.example', token: 'test-token', credentialsPath: undefined })
  expect(active.daemon.touch).not.toHaveBeenCalled()
})
