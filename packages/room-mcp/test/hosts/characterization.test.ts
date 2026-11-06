import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { workerCommand } from '../../src/worker-config.js'
import { createWakeSender, createMidTurnSender } from '../../src/wake-path.js'
import { evaluateDoctor } from '../../src/doctor.js'
import * as claude from '../../src/hosts/claude.js'
import * as codex from '../../src/hosts/codex.js'
import { createLogDecoder } from '../../src/hosts/index.js'
import { followUpAnswer, resumeAccepted, missingClaudeSession } from '../../src/worker-process.js'
import { sessionDirectory } from '../../src/session.js'
import { argvFixtures, hookEnvelopes, toolEnvelopes, portExamples, sessionId } from './fixtures.js'
// The shipped hook helper is deliberately plain ESM, with no MCP process dependency.
// @ts-expect-error Plain ESM hook entry has no TypeScript declaration.
import { pathsOf, isShellTool } from '../../../../plugins/room/hooks/common.mjs'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const dirs: string[] = []
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-contract-')); dirs.push(dir); return dir }
const write = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)) }
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function hook(script: string, event: object, args: readonly string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [path.join(root, 'plugins/room/hooks', script), ...args], { timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve(stdout))
    child.stdin!.end(JSON.stringify(event))
  })
}

describe('current worker argv (no native host invocation)', () => {
  it.each(argvFixtures)('$host $mode', fixture => {
    expect(workerCommand(fixture.host, 'fixture-model', 'fixture task', '', 'minimal', {
      tag: 'fixture', sessionId, resume: fixture.mode === 'resume', maxBudgetUsd: '2.50',
    })).toEqual({ cmd: fixture.host, args: fixture.args })
  })
  it('keeps explicit empty channel, development plugin settings and shell hook opt-in', () => {
    const plain = workerCommand('claude', undefined, 'task', '', undefined, { wakeChannels: true })
    expect(plain.args).not.toContain('--dangerously-load-development-channels')
    const configured = workerCommand('claude', undefined, 'task', 'plugin:room@room', undefined, { pluginDir: '/fixture/plugin', wakeChannels: true, shellEnvHook: true })
    expect(configured.args.slice(0, 3)).toEqual(['--plugin-dir', '/fixture/plugin', '--settings'])
    const settings = JSON.parse(configured.args[3])
    expect(settings.enabledPlugins).toEqual({ 'room@room': false })
    expect(settings.hooks.PreToolUse[0]).toMatchObject({ matcher: 'PowerShell', hooks: [{ type: 'command', command: 'node', timeout: 5 }] })
    expect(configured.args.slice(4, 6)).toEqual(['--dangerously-load-development-channels', 'plugin:room@room'])
    expect(() => workerCommand('codex', undefined, 'task', '', undefined, { resume: true })).toThrow('host session id')
    expect(claude.leadClaudePluginDir({ CLAUDE_PLUGIN_ROOT: '/fixture/plugin', CLAUDE_CONFIG_DIR: temp() })).toBe('/fixture/plugin')
    expect(codex.CODEX_SHELL_FILTER).toBe('shell_environment_policy.filters={"ROOM_*"="exclude"}')
  })
})

describe('current hook envelopes and output', () => {
  it.each(hookEnvelopes)('$host startup records the current fields and invocation host', async fixture => {
    const dir = temp(); execFileSync('git', ['init', '-q', dir])
    const transcript = path.join(dir, 'transcript.jsonl')
    const raw = { ...fixture.raw, cwd: dir, transcript_path: transcript }
    expect(await hook('session-start.mjs', raw, fixture.argv)).toBe('')
    const record = JSON.parse(fs.readFileSync(path.join(sessionDirectory(path.join(dir, '.git'), sessionId), 'session.json'), 'utf8'))
    expect(record).toMatchObject({ session_id: sessionId, host: fixture.host, cwd: dir, source: 'startup', model: 'fixture-model' })
    expect(record.transcript_path).toBe(fixture.host === 'claude' ? transcript : undefined)
  })
  it.each(toolEnvelopes)('$host $raw.tool_name retains original discriminator/input for path analysis', fixture => {
    expect(pathsOf(fixture.raw.tool_name, fixture.raw.tool_input, '/fixture/repo')).toEqual(fixture.paths)
    expect(isShellTool(fixture.raw.tool_name)).toBe(fixture.dialect !== undefined)
    expect(pathsOf(fixture.raw.tool_name, fixture.raw.tool_input, 'C:\\fixture\\repo')).toEqual(fixture.paths)
  })
  it('uses Codex command-local cwd while leaving path analysis rooted in the repository', async () => {
    const dir = temp(); execFileSync('git', ['init', '-q', dir]); fs.mkdirSync(path.join(dir, 'subdir'))
    const sd = sessionDirectory(path.join(dir, '.git'), sessionId)
    write(path.join(sd, 'session.json'), { session_id: sessionId, host: 'codex', cwd: dir })
    write(path.join(sd, 'state.json'), { at: Date.now(), room: 'fixture', company: true, companyLine: '[room] Peer is here.', claims: [{ id: 'c', path: 'src/a.ts', from: 1, to: 1, by: 'Peer', intent: 'fixture' }] })
    const raw = toolEnvelopes[2].raw
    const out = JSON.parse(await hook('before-edit.mjs', { ...raw, cwd: path.join(dir, 'subdir'), model: 'new-model' }))
    expect(out.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(10_000)
    expect(out.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', additionalContext: "[room] Peer is here.\n[room claims on src/a.ts]\n  Peer's agent holds src/a.ts:1-1 — fixture. Do not edit inside that range; room_wait or ask." })
    expect(JSON.parse(fs.readFileSync(path.join(sd, 'runtime.json'), 'utf8'))).toMatchObject({ model: 'new-model' })
  })
  it('bounds oversized additionalContext using the current 10,000-character cap', async () => {
    // Claude Code 2.1.317 cap; dated 2.1.318 snapshot in host-survey-2026-11-05-claude.md.
    const dir = temp(); execFileSync('git', ['init', '-q', dir])
    const sd = sessionDirectory(path.join(dir, '.git'), sessionId)
    write(path.join(sd, 'state.json'), { at: Date.now(), room: 'fixture', company: true, companyLine: 'x'.repeat(20_000) })
    const out = JSON.parse(await hook('before-edit.mjs', { ...toolEnvelopes[0].raw, cwd: dir }))
    expect(out.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(10_000)
    expect(out.hookSpecificOutput.additionalContext).toContain('more: call room_state')
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined()
  })
  it('keeps early hook activity for subagent calls without a session record', async () => {
    const dir = temp(); execFileSync('git', ['init', '-q', dir])
    const sd = sessionDirectory(path.join(dir, '.git'), sessionId)
    expect(await hook('before-edit.mjs', { ...toolEnvelopes[0].raw, cwd: dir, agent_id: 'subagent-fixture', agent_type: 'worker' })).toBe('')
    expect(JSON.parse(fs.readFileSync(path.join(sd, 'hook-activity.json'), 'utf8'))).toMatchObject({ session_id: sessionId, event: 'PreToolUse' })
    expect(fs.existsSync(path.join(sd, 'session.json'))).toBe(false)
  })
  it('preserves startup id aliases, while before-tool still requires session_id', async () => {
    const dir = temp(); execFileSync('git', ['init', '-q', dir])
    for (const alias of ['thread_id', 'sessionId']) {
      const id = `${alias}-fixture`
      await hook('session-start.mjs', { [alias]: id, cwd: dir })
      const sd = sessionDirectory(path.join(dir, '.git'), id)
      expect(fs.existsSync(path.join(sd, 'session.json'))).toBe(true)
      expect(await hook('before-edit.mjs', { [alias]: id, cwd: dir, tool_name: 'Write', tool_input: { path: 'a.ts' } })).toBe('')
      expect(fs.existsSync(path.join(sd, 'hook-activity.json'))).toBe(false)
    }
  })
})

describe('installation evidence compatibility exports', () => {
  it('Claude directory marketplace reads live files and preserves stale bookkeeping separately', () => {
    const dir = temp(), plugin = path.join(dir, 'plugins/room')
    write(path.join(plugin, '.claude-plugin/plugin.json'), { version: '0.17.33' })
    const actual = claude.claudePlugin({ version: '0.17.1', installPath: '/fixture/cache' }, [{ name: 'room', source: 'directory', path: dir }])
    expect(actual).toEqual({ version: '0.17.33', recordedVersion: '0.17.1', root: plugin, cached: false })
    expect(evaluateDoctor({ repo: true, claudeCli: true, codexCli: false, claude: actual }, '0.17.33').some(row => row.name === 'Claude Code install record')).toBe(false)
  })
  it('Codex bundle and hook roots are independent and trust is hash evidence', () => {
    const home = temp(), market = temp(), plugin = path.join(home, 'plugins/cache/room/room/0.17.33')
    write(path.join(plugin, '.codex-plugin/plugin.json'), { version: '0.17.33' })
    write(path.join(market, '.agents/plugins/marketplace.json'), { plugins: [{ name: 'room', source: { path: './custom/room' } }] })
    const markets = { marketplaces: [{ name: 'room', root: market }] }
    expect(codex.codexHooksRoot(markets, 'room')).toBe(path.join(market, 'custom/room'))
    expect(codex.codexPlugin({ version: '0.17.33', marketplaceName: 'room' }, markets, home)).toEqual({ version: '0.17.33', recordedVersion: '0.17.33', root: plugin, hooksRoot: path.join(market, 'custom/room') })
    const trusted = Object.entries(codex.CODEX_ROOM_HOOK_HASHES).map(([kind, hash]) => `[hooks.state."room@room:hooks.json:${kind}"]\ntrusted_hash = "${hash}"`).join('\n')
    expect(codex.codexRoomHookTrustStatus(trusted)).toBe('trusted')
    expect(codex.codexRoomHookTrustStatus(trusted.replace('sha256:e959', 'sha256:0000'))).toBe('modified')
    expect(codex.codexRoomHookTrustStatus('')).toBe('absent')
    expect(codex.CODEX_ROOM_HOOKS_FILE_SHA256).toBe('336c0b90c935ff627f9988ceb92e21c887b44c9b6e904b2c2ddd9a188db4b777')
  })
  it('failed listing stays unknown and cannot prove absence', () => {
    const rows = evaluateDoctor({ repo: true, claudeCli: true, codexCli: true, claudeListOk: false, codexListOk: false })
    expect(rows.filter(row => row.name === 'Room hosts')).toEqual([])
    expect(rows.filter(row => row.name === 'Claude Code' || row.name === 'Codex').map(row => row.level)).toEqual(['INFO', 'INFO'])
  })
})

describe('current wake outcomes never imply a receipt', () => {
  it('Claude socket write and admitted fallback preserve outcome evidence', async () => {
    const env = { CLAUDE_CODE_MESSAGING_SOCKET: '/fixture/socket' }
    expect(claude.claudeWakeAvailable({ host: 'claude', env })).toBe(true)
    const send = createWakeSender({ env, notify: vi.fn(), post: async () => {} })
    expect(await send({ host: 'claude', id: sessionId }, 'pointer')).toBe('socket')
    expect(send.lastAttempt?.()).toMatchObject({ via: 'socket', outcome: 'written' })
    const fallback = createWakeSender({ env, parentArgs: 'claude --channels plugin:room@room', notify: vi.fn(), post: async () => { throw Error('refused') } })
    expect(await fallback({ host: 'claude', id: sessionId }, 'pointer')).toBe('channel')
    expect(fallback.lastAttempt?.()).toMatchObject({ outcome: 'written', fallback: 'socket-failed' })
  })
  it.each(['claude', 'codex'] as const)('%s off has no attempt; failures remain failures', async host => {
    const off = createWakeSender({ env: { ROOM_WAKE: 'off' }, notify: vi.fn() })
    expect(await off({ host, id: sessionId }, 'pointer')).toBeUndefined()
    expect(off.lastAttempt?.()).toBeUndefined()
    const send = createWakeSender({ env: { ROOM_WAKE: 'channels' }, notify: async () => { throw Error('failed') }, queue: async () => { throw Error('failed') } })
    await expect(send({ host, id: sessionId }, 'pointer')).rejects.toThrow('failed')
    expect(send.lastAttempt?.()).toMatchObject({ outcome: 'failed' })
  })
  it('Codex queue uses exact thread; no metadata workspaces are needed to decode identity', async () => {
    const queue = vi.fn(async () => {})
    const send = createWakeSender({ env: {}, queue, notify: vi.fn() })
    expect(await send({ host: 'codex', id: sessionId }, 'pointer')).toBe('queue')
    expect(queue).toHaveBeenCalledWith(sessionId, 'pointer')
    expect(send.lastAttempt?.()).toMatchObject({ via: 'queue', outcome: 'queued' })
    expect(codex.codexThreadFromMeta({ _meta: { 'x-codex-turn-metadata': { thread_id: sessionId } } })).toBe(sessionId)
  })
  it.each([
    [{ kind: 'joined', turnId: 'turn' }, 'turn', 'submitted'],
    [{ kind: 'uncertain', reason: 'unknown' }, 'uncertain-turn', 'uncertain'],
    [{ kind: 'idle' }, 'idle', 'skipped-idle'],
    [{ kind: 'unavailable', reason: 'no-socket' }, undefined, 'unavailable'],
  ] as const)('Codex active result %j', async (result, returned, outcome) => {
    const send = createMidTurnSender({ env: {}, post: async () => result })
    expect(await send({ host: 'codex', id: sessionId }, 'pointer')).toBe(returned)
    expect(send.lastAttempt?.()).toMatchObject({ via: 'turn', outcome })
  })
  it('Codex exec excludes the mid-turn transport', async () => {
    const post = vi.fn()
    const send = createMidTurnSender({ env: { ROOM_WORKER_ID: 'fixture', ROOM_WORKER_HOST: 'codex' }, post })
    expect(await send({ host: 'codex', id: sessionId }, 'pointer')).toBeUndefined()
    expect(post).not.toHaveBeenCalled()
  })
})

describe('log acceptance/final facts and typed evidence', () => {
  it.each(['claude', 'codex'] as const)('%s emits normalized final facts through the adapter facet', host => {
    const decoder = createLogDecoder(host, { ...portExamples.context, scope: 'whole-run' })
    const event = host === 'claude'
      ? { type: 'result', result: 'done' }
      : { type: 'item.completed', item: { type: 'agent_message', text: 'done' } }
    expect(decoder.push(event)).toEqual(portExamples.logs.filter(f => f.kind === 'final' && f.slot === 'preferred'))
    expect(decoder.acceptsLine(JSON.stringify(event))).toBe(true)
    expect(decoder.backgroundTasks).toBe(host === 'claude' ? 'observed' : 'unknown')
  })
  it('represents failure resets and result boundaries without obsolete required fields', () => {
    const decoder = createLogDecoder('claude', portExamples.context)
    expect(decoder.push({ type: 'result', is_error: false })).toEqual([
      ...portExamples.logs.filter(f => f.kind === 'failure' && f.failure === undefined),
      ...portExamples.logs.filter(f => f.kind === 'background' && f.state === 'result-boundary'),
    ])
  })
  it('pins Claude assistant acceptance, zero-turn missing session and final-result precedence', () => {
    const file = path.join(temp(), 'run.jsonl')
    fs.writeFileSync(file, JSON.stringify({ type: 'result', session_id: sessionId, subtype: 'error_during_execution', is_error: true, num_turns: 0 }) + '\n')
    expect(missingClaudeSession(file, sessionId, 0)).toBe(true)
    expect(resumeAccepted(file, 'claude', sessionId, 0)).toBe(false)
    fs.appendFileSync(file, [{ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: 'interim' }] } }, { type: 'result', result: 'final' }].map(e => JSON.stringify(e) + '\n').join(''))
    expect(resumeAccepted(file, 'claude', sessionId, 0)).toBe(true)
    expect(followUpAnswer(file, 'claude', 0)).toBe('final')
  })
  it('pins Codex announcement alone, direct turn id and announcement fallback', () => {
    const file = path.join(temp(), 'run.jsonl')
    fs.writeFileSync(file, JSON.stringify({ type: 'thread.started', thread_id: sessionId }) + '\n')
    expect(resumeAccepted(file, 'codex', sessionId, 0)).toBe(false)
    fs.appendFileSync(file, JSON.stringify({ type: 'turn.started' }) + '\n')
    expect(resumeAccepted(file, 'codex', sessionId, 0)).toBe(true)
    const direct = path.join(temp(), 'direct.jsonl')
    fs.writeFileSync(direct, [{ type: 'turn.started', thread_id: sessionId }, { type: 'item.completed', item: { type: 'agent_message', text: 'final' } }].map(e => JSON.stringify(e) + '\n').join(''))
    expect(resumeAccepted(direct, 'codex', sessionId, 0)).toBe(true)
    expect(followUpAnswer(direct, 'codex', 0)).toBe('final')
  })
  it('keeps optional capabilities, event time and successful-artifact env separate', () => {
    expect(portExamples.optionalFacets).toEqual({})
    expect(portExamples.logs.filter(f => f.kind === 'activity')).toEqual([{ kind: 'activity', text: 'Edit src/a.ts', eventTimeMs: 1 }, { kind: 'activity', text: 'Edit src/a.ts' }])
    expect(portExamples.plan.envPatch).toEqual({})
    expect(portExamples.plan.artifactEnv).toEqual([{ artifactId: 'shell-env', key: 'CLAUDE_ENV_FILE' }])
    expect(portExamples.hook.tool).toMatchObject({ originalName: 'PowerShell', shellDialect: 'powershell' })
    expect(portExamples.context).toMatchObject({ run: 2, logStart: 100, scope: 'diagnostic-suffix', dir: '/fixture/repo' })
  })
})
