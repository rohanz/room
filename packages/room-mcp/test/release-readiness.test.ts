import { workerInput } from './fixtures/worker-input.js'
import { workerRuntimeForHost } from '../src/hosts/selection.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Identity } from '@room/shared'
import type { Session } from '../src/session.js'
import { resolveDisplayedName, type NameContext } from '../src/tools/names.js'
import { workerAdapter } from '../src/hosts/index.js'
import { DEFAULT_CLAUDE_CHANNEL } from '../src/hosts/claude-binding.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

function names(people: Identity[], requested: string, known: string[] = [], workers: { name: string; status: 'running' | 'done' }[] = [], me: Identity = { name: 'lead', kind: 'agent' }) {
  const room = { me, room: {
    colors: new Map(known.map(name => [name, 1])), scopes: new Map(), manifestHead: new Map(), openClaims: () => [],
    workerViews: new Map(), acceptedWorkerViews: () => workers, retiredWorkers: () => [], messages: () => [], mail: new Map(),
    doc: { getMap: () => new Map() }, allScopes: () => [],
  } } as unknown as Session
  const context: NameContext = { all: () => [room], presences: () => people.map(user => ({ user })), myWorkers: () => [] }
  return resolveDisplayedName(requested, context, room)
}

it('resolves a single tagged active agent from owner phrasing or bare owner', async () => {
  const cy: Identity = { name: 'cy+codex', owner: 'cy', kind: 'agent' }
  expect((await names([cy], "CY’S AGENT"))).toEqual({ name: cy.name })
  expect((await names([cy], 'Cy'))).toEqual({ name: cy.name })
})

it('reports multiple active owner agents, while exact names still win', async () => {
  const people: Identity[] = [{ name: 'cy+codex', owner: 'cy', kind: 'agent' }, { name: 'cy+claude', owner: 'cy', kind: 'agent' }]
  expect((await names(people, "cy's agent"))).toEqual({ ambiguous: ['cy+claude', 'cy+codex'] })
  expect((await names(people, 'cy+codex'))).toEqual({ name: 'cy+codex' })
  expect((await names(people, 'cy', ['cy']))).toEqual({ name: 'cy' })
})

it('ignores old offline names when an active owner agent exists', async () => {
  expect((await names([{ name: 'cy+codex', owner: 'cy', kind: 'agent' }], "cy's agent", ['cy+old'])))
    .toEqual({ name: 'cy+codex' })
})

it('includes a running worker in owner ambiguity but ignores a done worker', async () => {
  const cy: Identity = { name: 'cy+codex', owner: 'cy', kind: 'agent' }
  expect((await names([cy], "cy's agent", [], [{ name: 'cy+helper', status: 'running' }])))
    .toEqual({ ambiguous: ['cy+codex', 'cy+helper'] })
  expect((await names([cy], "cy's agent", [], [{ name: 'cy+helper', status: 'done' }])))
    .toEqual({ name: 'cy+codex' })
})

it('never resolves an owner label to the caller: with two sessions under one owner, the other one is meant', async () => {
  // Live check 2026-11-08: "rohanz's agent" from the untagged session resolved to itself ("you cannot message yourself").
  const me: Identity = { name: 'rohanz', owner: 'rohanz', kind: 'agent' }
  const other: Identity = { name: 'rohanz+claude', owner: 'rohanz', kind: 'agent' }
  expect(await names([me, other], "rohanz's agent", ['rohanz', 'rohanz+claude'], [], me)).toEqual({ name: 'rohanz+claude' })
  // The exact own name still means the caller (the self-message error explains what to do).
  expect(await names([me, other], 'rohanz', ['rohanz', 'rohanz+claude'], [], me)).toEqual({ name: 'rohanz' })
  // Alone under the owner, the label names nobody else; only the exact own name reaches the self-message error.
  expect(await names([me], "rohanz's agent", ['rohanz'], [], me)).toEqual({ name: undefined })
})

it('uses request, per-host, generic and then host worker defaults in that order', async () => {
  const env = { ROOM_WORKER_MODEL: 'generic', ROOM_WORKER_EFFORT: 'low', ROOM_CODEX_WORKER_MODEL: 'codex-model', ROOM_CODEX_WORKER_EFFORT: 'high' }
  expect(workerRuntimeForHost('codex', { model: 'named', effort: 'medium' }, env)).toEqual({ model: 'named', effort: 'medium' })
  expect(workerRuntimeForHost('codex', { model: undefined, effort: undefined }, env)).toEqual({ model: 'codex-model', effort: 'high' })
  expect(workerRuntimeForHost('claude', { model: undefined, effort: undefined }, env)).toEqual({ model: 'generic', effort: 'low' })
  expect(workerRuntimeForHost('codex', { model: undefined, effort: undefined }, {})).toEqual({ model: undefined, effort: undefined })
  for (const host of ['codex', 'claude'] as const) {
    const command = (await workerAdapter(host).plan(workerInput({
      claudeChannel: DEFAULT_CLAUDE_CHANNEL,
    })))
    expect(command.args).not.toContain('-m')
    expect(command.args).not.toContain('--model')
    expect(command.args).not.toContain('--effort')
    expect(command.args.some(arg => arg.startsWith('model_reasoning_effort='))).toBe(false)
    const named = (await workerAdapter(host).plan(workerInput({
      runtime: workerAdapter(host).normalizeRuntime({ model: 'named', effort: 'high' }),
      claudeChannel: DEFAULT_CLAUDE_CHANNEL,
    }))).args
    expect(named).toContain('named')
    expect(named).toContain(host === 'codex' ? 'model_reasoning_effort=high' : '--effort')
  }
})

it('reads top-level Codex settings and project Claude settings for host-default reply labels', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-release-')); dirs.push(dir)
  const codex = path.join(dir, 'codex'), claude = path.join(dir, 'claude'), project = path.join(dir, 'project')
  for (const root of [codex, claude, path.join(project, '.claude')]) fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(codex, 'config.toml'), 'model = "configured-codex"\nmodel_reasoning_effort = "high"\n[profile.other]\nmodel = "ignored"\n')
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ model: 'configured-claude' }))
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ model: 'project-claude' }))
  expect(workerAdapter('codex', { CODEX_HOME: codex }).defaults(project)).toEqual({ model: 'configured-codex', effort: 'high' })
  expect(workerAdapter('claude', { CLAUDE_CONFIG_DIR: claude }).defaults(project)).toEqual({ model: 'project-claude' })
  expect(workerAdapter('codex', { CODEX_HOME: path.join(dir, 'missing') }).defaults(project)).toEqual({})
})
