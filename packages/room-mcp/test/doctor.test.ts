import requireFs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { evaluateDoctor, formatDoctor, probeHealth, probeCredential, runDoctor, hookCompatibilityWarning } from '../src/doctor.js'
import { type DoctorFacts } from '../src/hosts/diagnostics.js'
import { hookVersion } from '../src/hosts/install-io.js'
import { CODEX_ROOM_HOOKS_FILE_SHA256, CODEX_ROOM_HOOK_HASHES, codexPlugin, codexHooksRoot, codexRoomHookTrustStatus, codexRoomHooksTrusted } from '../src/hosts/codex-install.js'
import { claudePlugin } from '../src/hosts/claude-install.js'
import { createClaudeInstall } from '../src/hosts/claude-install.js'
import { createCodexInstall } from '../src/hosts/codex-install.js'
import type { InstallIO } from '../src/hosts/install-io.js'
import type { Session } from '../src/session.js'
import { createWakeSender } from '../src/hosts/wake.js'
import { handlers as scopeHandlers } from '../src/tools/scope.js'
import type { HandlerState } from '../src/tools/context.js'
import { RoomDoc } from '@room/shared'
import { CURRENT_COMPAT } from '@room/hub-core'
import { Awareness } from 'y-protocols/awareness'

const { version } = JSON.parse(readFileSync(new URL('../../../plugins/room/.claude-plugin/plugin.json', import.meta.url), 'utf8')) as { version: string }
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
  it('says when the session is unbound instead of calling a configured socket a bound wake path', () => {
    const configured = evaluateDoctor({ ...base(), sessionBound: true }).find(r => r.name === 'Claude inbox')
    expect(configured).toMatchObject({ level: 'PASS', finding: 'wake path configured' })
    const unbound = evaluateDoctor({ ...base(), sessionBound: false }).find(r => r.name === 'Claude inbox')
    expect(unbound).toMatchObject({ level: 'WARN' })
    expect(unbound?.finding).toContain('not bound')
    expect(unbound?.fix).toContain('git init')
    const off = evaluateDoctor({ ...base(), sessionBound: false, deliveryPath: { mode: 'off', transport: 'none', availability: 'off' } }).find(r => r.name === 'Claude inbox')
    expect(off?.level).toBe('PASS')
  })
  it('distinguishes configured Claude delivery from acceptance and respects off', () => {
    const facts = { ...base(), deliveryHost: 'Claude', deliveryPath: { mode: 'auto' as const, transport: 'socket' as const, availability: 'configured' as const } }
    const row = evaluateDoctor(facts).find(r => r.name === 'Claude delivery configuration')
    expect(row?.finding).toContain('configuration only, no receipt evidence')
    expect(row?.finding).toContain('hold/refuse')
    const disabled = evaluateDoctor({ ...facts, wakeBound: false, deliveryPath: { mode: 'off', transport: 'none', availability: 'off' } })
    expect(disabled.find(r => r.name === 'Claude delivery configuration')?.finding).toContain('off; none off')
    expect(disabled.find(r => r.name === 'Claude inbox')).toMatchObject({ level: 'PASS', finding: 'disabled (ROOM_WAKE=off); messages wait for tool/hook handoff', fix: undefined })
  })
  it('reports Codex standalone limitations without treating socket availability as a receipt', () => {
    const rows = evaluateDoctor({ ...base(), deliveryHost: 'Codex', deliveryPath: { mode: 'auto', transport: 'legacy/queue', availability: 'unknown' } })
    expect(rows.find(r => r.name === 'Codex delivery configuration')?.finding).toContain('exec/--no-daemon require tool/hook fallback')
  })
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
    // A directory marketplace runs its checkout; the stale cache record changes nothing that runs.
    expect(rows.find(r => r.name === 'Claude Code install record')).toBeUndefined()
    expect(claude?.cached).toBe(source !== 'directory')
    if (source === 'directory') expect(rows.find(r => r.name === 'Claude Code')?.finding).toContain('(directory marketplace)')
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
    const failed = evaluateDoctor({ ...f, claudeListOk: false })
    expect(failed.find(r => r.name === 'Claude Code')).toMatchObject({ level: 'INFO', fix: undefined })
    expect(failed.find(r => r.name === 'Claude Code')?.finding).toContain('not checked')
    // A failed listing is not evidence that Room is absent.
    expect(failed.find(r => r.name === 'Room hosts')).toBeUndefined()
  })
  it('reports Codex absent from PATH as not installed and a failed listing without a retry fix', () => {
    expect(evaluateDoctor({ ...base(), codexCli: false, codex: undefined }).find(r => r.name === 'Codex')).toMatchObject({ level: 'PASS', finding: 'not installed' })
    const idle = evaluateDoctor({ ...base(), codex: undefined, codexListOk: false }).find(r => r.name === 'Codex')
    expect(idle).toMatchObject({ level: 'INFO', fix: undefined })
    expect(idle?.finding).not.toContain('running session')
    const active = evaluateDoctor({ ...base(), codex: undefined, codexListOk: false, sessionHost: 'codex' }).find(r => r.name === 'Codex')
    expect(active).toMatchObject({ level: 'INFO', fix: undefined })
    expect(active?.finding).toContain('checked under running session')
    expect(formatDoctor(evaluateDoctor({ ...base(), codex: undefined, codexListOk: false }))).not.toMatch(/Retry|plugin list --json/)
  })
  it('does not call Room uninstalled inside a running Room session', () => {
    const f = { ...base(), claude: undefined, codex: undefined }
    const rows = evaluateDoctor({ ...f, sessionHost: 'claude' })
    expect(rows.find(r => r.name === 'Room hosts')).toBeUndefined()
    expect(rows.find(r => r.name === 'Codex')).toMatchObject({ level: 'PASS', finding: 'Room not installed' })
  })
  it('warns about the install record only when Claude loads the recorded cache', () => {
    const cached = { version, recordedVersion: '0.17.15', cached: true }
    expect(evaluateDoctor({ ...base(), claude: cached }).find(r => r.name === 'Claude Code install record')).toMatchObject({ level: 'WARN', fix: 'claude plugin update room@room' })
    expect(evaluateDoctor({ ...base(), claude: { ...cached, cached: false } }).find(r => r.name === 'Claude Code install record')).toBeUndefined()
    expect(evaluateDoctor({ ...base(), claude: { ...cached, recordedVersion: version } }).find(r => r.name === 'Claude Code install record')).toBeUndefined()
  })
  it('treats an unreadable Claude version and delivery configuration as context, not warnings', () => {
    const rows = evaluateDoctor({ ...base(), claudeVersion: undefined, deliveryHost: 'Claude', deliveryPath: { mode: 'auto', transport: 'none', availability: 'unavailable' } })
    expect(rows.find(r => r.name === 'Claude wake')).toMatchObject({ level: 'INFO', fix: undefined })
    expect(rows.find(r => r.name === 'Claude delivery configuration')).toMatchObject({ level: 'INFO', fix: undefined })
    expect(evaluateDoctor({ ...base(), claudeVersion: '2.1.223' }).find(r => r.name === 'Claude wake')?.level).toBe('WARN')
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
    const healthy = { ...base(), server: 'wss://fixture.invalid', serverHealth: true, serverSchema: 2, serverHub: 1, serverCompat: CURRENT_COMPAT }
    expect(evaluateDoctor(healthy).find(r => r.name === 'team server')).toMatchObject({ level: 'PASS' })
    expect(evaluateDoctor({ ...healthy, serverCompat: undefined }).find(r => r.name === 'team server')).toMatchObject({ level: 'FAIL', finding: expect.stringMatching(/server.*update|update.*server/i) })
    expect(evaluateDoctor({ ...healthy, serverCompat: { ...CURRENT_COMPAT, hub: { min: 2, max: 2 } } }).find(r => r.name === 'team server')).toMatchObject({ level: 'FAIL', finding: expect.stringMatching(/client.*protocol/i) })
    expect(evaluateDoctor({ ...healthy, serverStorage: 'failing' }).find(r => r.name === 'team server')).toMatchObject({ level: 'FAIL', finding: "the server's storage is failing" })
  })
  it('reports overlapping contract ranges independently of release and refuses malformed ads', () => {
    const f = { ...base(), server: 'wss://fixture.invalid', serverHealth: true, serverCompat: { ...CURRENT_COMPAT, release: '99.0.0' } }
    expect(evaluateDoctor(f).find(r => r.name === 'team server')).toMatchObject({ level: 'PASS', finding: expect.stringContaining('hub 1') })
    expect(evaluateDoctor({ ...f, serverCompat: { bootstrap: 1 } }).find(r => r.name === 'team server')).toMatchObject({ level: 'FAIL' })
    expect(evaluateDoctor({ ...f, serverCompat: { ...CURRENT_COMPAT, hub: { min: 9, max: 9 } } }).find(r => r.name === 'team server')).toMatchObject({ level: 'FAIL' })
  })
  it('surfaces hook degradation only for the current endpoint incarnation', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'room-hook-diagnostic-'))
    writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ pid: 123, incarnation: 'current' }))
    const status = path.join(dir, 'hook-compat.json')
    writeFileSync(status, JSON.stringify({ pid: 123, incarnation: 'current', degraded: 'failed' }))
    expect(hookCompatibilityWarning(dir)).toMatch(/hook.*Messages remain owed/)
    writeFileSync(status, JSON.stringify({ pid: 123, incarnation: 'old', degraded: 'failed' }))
    expect(hookCompatibilityWarning(dir)).toBeUndefined()
    writeFileSync(status, JSON.stringify({ pid: 123, incarnation: 'current' }))
    expect(hookCompatibilityWarning(dir)).toBeUndefined()
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

it('a first diagnostic reply hands off already-prepared recovery notices without waiting for join', async () => {
  const { createTools } = await import('../src/tools.js')
  const tools = createTools({ getSession: () => null, setSession() {}, cwd: '/not/a/repository' })
  tools.ledger.notice('worker-restart', 'stopped worker recovery advice')
  expect(await tools.call('room_state', { check: true }, undefined, settle => settle.release())).toContain('stopped worker recovery advice')
  expect(await tools.call('room_state', { check: true })).toContain('stopped worker recovery advice')
  expect(await tools.call('room_state', { check: true })).not.toContain('stopped worker recovery advice')
})

it('diagnostics keep recovery advice owed until the bound host session has joined', async () => {
  const { createTools } = await import('../src/tools.js')
  const tools = createTools({ getSession: () => null, setSession() {}, cwd: '/not/a/repository',
    binding: { id: () => 'next-thread', bound: () => ({ id: 'next-thread', host: 'codex' }), dir: () => undefined, commonDir: () => undefined } })
  tools.ledger.notice('worker-restart', 'previous binding recovery advice')
  expect(await tools.call('room_state', { check: true })).not.toContain('previous binding recovery advice')
  expect(tools.ledger.noticeCount()).toBe(1)
})

it('room_state check includes bounded runtime delivery evidence even before join', async () => {
  const { createTools } = await import('../src/tools.js')
  const wake = createWakeSender({ env: { ROOM_WAKE: 'off' } })
  const tools = createTools({ getSession: () => null, setSession: () => {}, cwd: '/not/a/repository', wake,
    binding: { bound: () => ({ host: 'codex', id: 'private-thread' }), id: () => 'private-thread', dir: () => undefined, commonDir: () => undefined } })
  try {
    const report = await tools.call('room_state', { check: true })
    expect(report).toContain('delivery: codex; off; none off')
    expect(report).toContain('last wake attempt none observed')
    expect(report).not.toContain('private-thread')
  } finally { await tools.shutdown() }
})

it('normal room_state avoids detailed health sampling and only shows concise degradation', async () => {
  const room = new RoomDoc(), awareness = new Awareness(room.doc)
  const s = { room, awareness, me: { name: 'Pat', kind: 'agent' }, local: {}, dir: '/fixture' } as Session
  let degraded: 'transport-failed' | undefined
  const sample = vi.fn(() => { throw new Error('normal state must not sample delivery history') })
  const handlers = scopeHandlers({ S: () => s, loadAreas: async () => {}, presences: () => [],
    ledger: { candidates: () => [] }, shareOf: () => 'intent', hasCompany: () => ({ company: false }),
    deliveryHealth: sample, deliveryDegradation: () => degraded, readText: async () => null,
    rooms: { all: () => [s] }, now: () => 0,
  } as unknown as HandlerState)
  try {
    const healthy = await handlers.room_state({ path: 'work.ts' })
    expect(healthy).not.toContain('delivery:')
    degraded = 'transport-failed'
    const report = await handlers.room_state({ path: 'work.ts' })
    expect(report).toContain('WARN  delivery: transport-failed')
    expect(report).not.toMatch(/retained addressed|last wake attempt|delivery limits/)
    expect(sample).not.toHaveBeenCalled()
  } finally { awareness.destroy(); room.doc.destroy() }
})

it.each(['in progress', 'failed'])('room_state check bypasses an %s automatic join', async state => {
  const { createTools } = await import('../src/tools.js')
  const tools = createTools({ getSession: () => null, setSession: () => {}, cwd: '/not/a/repository' })
  const ensure = vi.fn(state === 'failed' ? () => { throw new Error('AUTO_JOIN_TOUCHED') } : () => new Promise<void>(() => {}))
  const settle = vi.fn(state === 'failed' ? () => Promise.reject(new Error('AUTO_JOIN_TOUCHED')) : () => new Promise<void>(() => {}))
  tools.setAutoJoin({ ensure, settle, cancel() {}, retarget() {}, ...(state === 'failed' ? { failure: 'join failed' } : {}) })
  expect(await tools.call('room_state', { check: true })).toMatch(/^PASS  doctor: report from tool\nINFO  Room server process: pid \d+; CPU [\d.]+ s \(user [\d.]+, system [\d.]+\); RSS \d+ MB; up /)
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
  expect(await tools.call('room_state', { check: true })).toMatch(/^PASS  doctor: report from tool\nINFO  Room server process: pid \d+; CPU [\d.]+ s \(user [\d.]+, system [\d.]+\); RSS \d+ MB; up /)
  expect(doctor).toHaveBeenCalledWith('/selected/checkout', { inSession: true, selected: { server: 'wss://selected.example', token: 'test-token', credentialsPath: undefined }, sessionWarning: undefined, sessionBound: undefined })
  expect(active.daemon.touch).not.toHaveBeenCalled()
})


describe('host installation evidence', () => {
  function fakeIO(outputs: Record<string, string | undefined>, files: Record<string, string> = {}): InstallIO {
    return {
      command: vi.fn(async (file, args) => outputs[[file, ...args].join(' ')]),
      readFile: vi.fn(file => {
        if (!(file in files)) throw new Error('missing fixture')
        return files[file]
      }),
    }
  }
  it.each([
    [undefined, 'absent'], ['', 'present'], ['not JSON', 'present'], ['{}', 'present'],
  ] as const)('keeps an unanswered/malformed listing unknown (%s)', async (raw, cli) => {
    const io = fakeIO({ 'claude plugin list --json': raw, 'codex plugin list --json --marketplace room': raw })
    expect(await createClaudeInstall(io).inspectInstall()).toMatchObject({ cli, listing: 'unknown', plugin: 'unknown' })
    expect(await createCodexInstall({ CODEX_HOME: '/codex' }, io).inspectInstall()).toMatchObject({ cli, listing: 'unknown', plugin: 'unknown' })
  })
  it('distinguishes successfully listed absence and keeps Claude version failure as empty evidence', async () => {
    const io = fakeIO({ 'claude plugin list --json': '[]', 'codex plugin list --json --marketplace room': '{"installed":[]}', 'claude --version': '' })
    expect(await createClaudeInstall(io).inspectInstall()).toMatchObject({ cli: 'present', listing: 'ok', plugin: 'absent', version: '', hookTrust: 'not-applicable' })
    expect(await createCodexInstall({ CODEX_HOME: '/codex' }, io).inspectInstall()).toMatchObject({ cli: 'present', listing: 'ok', plugin: 'absent' })
  })
  it('keeps directory source, loaded files, stale bookkeeping and raw hooks separate', async () => {
    const market = path.resolve('/fixture/market'), root = path.join(market, 'plugins', 'room')
    const hooks = `export const HOOKS_VERSION = '${version}'`
    const io = fakeIO({
      'claude plugin list --json': JSON.stringify([{ id: 'room@room', version: '0.8.0', installPath: '/stale/cache' }]),
      'claude plugin marketplace list --json': JSON.stringify([{ name: 'room', source: 'directory', path: market }]),
      'claude --version': '2.1.300',
    }, { [path.join(root, '.claude-plugin', 'plugin.json')]: JSON.stringify({ version }), [path.join(root, 'hooks', 'common.mjs')]: hooks })
    expect(await createClaudeInstall(io).inspectInstall()).toEqual({
      record: { version, recordedVersion: '0.8.0', root, cached: false },
      cli: 'present', version: '2.1.300', listing: 'ok', plugin: 'present',
      bundleRoot: root, hooksRoot: root, loadedVersion: version, recordedVersion: '0.8.0', source: 'directory', cached: false,
      hooks, hooksVersion: version, hookTrust: 'not-applicable',
      remedies: ['claude plugin marketplace update room && claude plugin update room@room'],
    })
    // Empty record roots have historically compared equal and must not acquire a directory warning.
    expect(claudePlugin({}, [])).toEqual({ root: undefined, version: undefined, recordedVersion: undefined, cached: true })
  })
  it('keeps doctor first-row evidence independent of enabled/unique executable-contract admission', async () => {
    const home = path.resolve('/fixture/codex'), market = path.resolve('/fixture/snapshot')
    const cache = path.join(home, 'plugins', 'cache', 'room', 'room', '0.8.0')
    const hooksRoot = path.join(market, 'custom-room')
    const hooks = `export const HOOKS_VERSION = '${version}'`
    const io = fakeIO({
      'codex plugin list --json --marketplace room': JSON.stringify({ installed: [
        { pluginId: 'other@room', version: '99.0.0' },
        { pluginId: 'room@room', version: '0.8.0', marketplaceName: 'room', enabled: false },
        { pluginId: 'room@room', version: '99.0.0', marketplaceName: 'room' },
      ] }),
      'codex plugin marketplace list --json': JSON.stringify({ marketplaces: [{ name: 'room', root: market }] }),
    }, {
      [path.join(cache, '.codex-plugin', 'plugin.json')]: JSON.stringify({ version: '0.8.0' }),
      [path.join(market, '.agents', 'plugins', 'marketplace.json')]: JSON.stringify({ plugins: [{ name: 'room', source: { path: './custom-room' } }] }),
      [path.join(hooksRoot, 'hooks', 'common.mjs')]: hooks,
      [path.join(home, 'config.toml')]: trust,
    })
    expect(await createCodexInstall({ CODEX_HOME: home }, io).inspectInstall()).toEqual({
      record: { version: '0.8.0', recordedVersion: '0.8.0', root: cache, hooksRoot },
      cli: 'present', listing: 'ok', plugin: 'present', bundleRoot: cache, hooksRoot,
      loadedVersion: '0.8.0', recordedVersion: '0.8.0', hooks, hooksVersion: version, trust, hookTrust: 'trusted',
      remedies: ['codex plugin marketplace upgrade room && codex plugin add room@room'],
    })
    expect(io.command).toHaveBeenCalledTimes(2)
    // Inspection must remain read-only and limited to plugin facts and Codex's hook trust config.
    expect(vi.mocked(io.readFile).mock.calls.map(([file]) => file)).toEqual([
      path.join(cache, '.codex-plugin', 'plugin.json'), path.join(market, '.agents', 'plugins', 'marketplace.json'),
      path.join(hooksRoot, 'hooks', 'common.mjs'), path.join(home, 'config.toml'),
    ])
  })
})
