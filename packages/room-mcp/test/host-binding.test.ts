import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import baseline from './fixtures/host-binding-baseline.json' with { type: 'json' }
import { workerCommand, workerRuntime, hostWorkerEffort, hostDefaultRuntime, type WorkerHost } from '../src/worker-config.js'
import { codexThreadFromMeta, codexWorkspace, fallbackWorkspace, deferForSharedCodex } from '../src/workspace.js'
import { hostKind } from '../src/presence-end.js'
import { resolveConfig, resolveSessionHost } from '../src/config.js'
import { workerAdapter, preBindingAdapter } from '../src/hosts/index.js'
import { workerHost } from '../src/hosts/selection.js'

// Captured from cf81702d09 before extraction; retain these expectations across adapter moves.
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

it('retains the argv captured before extraction for fresh and resumed workers', () => {
  for (const { input, output } of baseline.commands) {
    expect(workerCommand(input.host as WorkerHost, input.model, input.prompt, input.channel, input.effort, input.options)).toEqual(output)
  }
})

it('retains all captured startup, naming and presence precedence and failure policies', () => {
  for (const { env, parent, platform, output } of baseline.classification) {
    const read = () => { if (parent === null) throw new Error('unreadable'); return parent }
    expect({ fallback: fallbackWorkspace(env, '/process'), deferred: deferForSharedCodex(env, read, platform as NodeJS.Platform),
      presence: hostKind(env, read), sessionHost: resolveSessionHost(env, read) }).toEqual(output)
  }
})

it('retains captured runtime precedence and effort normalization', () => {
  for (const { host, effort, output, normalized } of baseline.runtime) {
    const runtime = workerRuntime(host as WorkerHost, ' ', effort, { ROOM_WORKER_MODEL: ' generic ', ROOM_WORKER_EFFORT: ' medium ',
      ROOM_CODEX_WORKER_MODEL: ' codex ', ROOM_CLAUDE_WORKER_EFFORT: ' low ' })
    expect(runtime).toEqual(output)
    expect(hostWorkerEffort(host as WorkerHost, effort)).toBe(normalized)
  }
})

it('decodes only the existing metadata fields, including a thread without a workspace', () => {
  for (const { meta, thread } of baseline.metadata) expect(codexThreadFromMeta({ _meta: meta }) ?? null).toBe(thread)
  expect(preBindingAdapter('codex').decodeCall({ 'x-codex-turn-metadata': { thread_id: 'thread', workspaces: { '/a': {}, '/b': {} } } }))
    .toEqual({ toolSessionId: 'thread', workspaceCandidates: ['/a', '/b'] })
  expect(preBindingAdapter('codex').decodeCall({ 'x-codex-turn-metadata': { workspaces: ['/a'] } }).workspaceCandidates).toEqual([])
  expect(preBindingAdapter('claude').decodeCall({ 'x-codex-turn-metadata': { thread_id: 'ignored' } })).toEqual({ workspaceCandidates: [] })
})

it('does not inspect parents when the original startup and presence rules skip them', () => {
  const read = vi.fn(() => { throw new Error('must not read') })
  for (const env of [{ ROOM_HOST: 'claude' }, { ROOM_HOST: 'codex', ROOM_DIR: '/worker' }]) expect(deferForSharedCodex(env, read, 'darwin')).toBe(false)
  expect(deferForSharedCodex({ ROOM_HOST: 'codex' }, read, 'win32')).toBe(true)
  expect(hostKind({ ROOM_HOST: 'claude' }, read)).toBe('interactive')
  expect(read).not.toHaveBeenCalled()
})

it('preserves each spawn selector outcome independently of the naming selector', () => {
  expect(workerHost(undefined, { ROOM_WORKER_HOST: 'codex', ROOM_HOST: 'claude' })).toBe('claude')
  expect(workerHost(undefined, { ROOM_WORKER_HOST: 'claude', ROOM_HOST: 'codex' })).toBe('codex')
  expect(workerHost(undefined, { ROOM_WORKER_HOST: 'codex', ROOM_HOST: 'invalid' })).toBe('claude')
  expect(workerHost('claude', { ROOM_HOST: 'codex' })).toBe('claude')
  expect(workerHost(undefined, {})).toBe('claude')
  expect(workerAdapter('codex').freshSessionId()).toBeUndefined()
  expect(workerAdapter('claude').freshSessionId()).toMatch(/^[a-f0-9-]{36}$/)
})

it('keeps Claude cwd spelling and synchronous public-config defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-adapter-binding-')); dirs.push(dir)
  const real = path.join(dir, 'project'), alias = path.join(dir, 'alias'), config = path.join(dir, 'config')
  fs.mkdirSync(real); fs.mkdirSync(config); fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(fallbackWorkspace({ ROOM_HOST: 'claude', PWD: alias }, real)).toBe(alias)
  fs.writeFileSync(path.join(config, 'config.toml'), 'model = "top"\nmodel_reasoning_effort = "high"\n[profiles.other]\nmodel = "ignored"\n')
  expect(hostDefaultRuntime('codex', real, { CODEX_HOME: config })).toEqual({ model: 'top', effort: 'high' })
  fs.writeFileSync(path.join(config, 'settings.json'), '{"model":" global "}')
  fs.mkdirSync(path.join(real, '.claude')); fs.writeFileSync(path.join(real, '.claude/settings.json'), '{"model":" project "}')
  expect(hostDefaultRuntime('claude', real, { CLAUDE_CONFIG_DIR: config })).toEqual({ model: 'project' })
  fs.writeFileSync(path.join(real, '.claude/settings.json'), 'malformed')
  expect(hostDefaultRuntime('claude', real, { CLAUDE_CONFIG_DIR: config })).toEqual({ model: 'global' })
  expect(codexWorkspace({ _meta: { 'x-codex-turn-metadata': { workspaces: { [real]: {} } } } }, () => undefined)).toBe(fs.realpathSync(real))
})

it('preserves explicit empty channels and existing command rejection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-adapter-config-')); dirs.push(dir)
  expect((await resolveConfig({ dir, env: { ROOM_CLAUDE_CHANNEL: 'env' }, args: { claudeChannel: ' ' } })).claudeChannel).toBe('')
  expect((await resolveConfig({ dir, env: { ROOM_CLAUDE_CHANNEL: '' } })).claudeChannel).toBe('')
  expect((await resolveConfig({ dir, env: {} })).claudeChannel).toBe('plugin:room@room')
  for (const host of ['claude', 'codex'] as const) {
    expect(() => workerCommand(host, undefined, 'task', '', 'invalid', { resume: true })).toThrow('effort must be minimal|low|medium|high')
    expect(() => workerCommand(host, undefined, 'task', '', undefined, { resume: true })).toThrow('resuming a worker requires its host session id')
    expect(workerCommand(host, undefined, 'task').args).not.toContain('--thread-source')
  }
})
