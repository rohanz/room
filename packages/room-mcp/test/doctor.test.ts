import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexHooksRoot, codexRoomHooksTrusted, evaluateDoctor, formatDoctor, hookVersion, type DoctorFacts } from '../src/doctor.js'

const version = '0.17.0'
const trust = `[hooks.state."room@room:hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:${'a'.repeat(64)}"
[hooks.state."room@room:hooks.json:session_start:0:0"]
trusted_hash = "sha256:${'b'.repeat(64)}"`
const base = (): DoctorFacts => ({ node: 'v22.14.0', git: 'git version 2.39.0', repo: true,
  claudeCli: true, codexCli: true, claude: { version }, codex: { version }, claudeVersion: '2.1.285',
  claudeHooks: `export const HOOKS_VERSION = '${version}'`, codexHooks: `export const HOOKS_VERSION = '${version}'`,
  codexTrust: trust, wakeSession: true, wakeBound: true, relayFile: '/tmp/relay.json', relayHealth: true,
  inSession: true })

describe('doctor report', () => {
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
    expect(hookVersion('no stamp')).toBeUndefined()
    const root = fileURLToPath(new URL('../../../plugins/room/', import.meta.url))
    const hooks = readFileSync(root + 'hooks/common.mjs', 'utf8')
    const manifest = JSON.parse(readFileSync(root + '.claude-plugin/plugin.json', 'utf8')) as { version: string }
    expect(hookVersion(hooks)).toBe(manifest.version)
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
