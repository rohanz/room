import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Identity } from '@room/shared'
import type { Session } from '../src/session.js'
import { resolveDisplayedName, type NameContext } from '../src/tools/names.js'
import { hostDefaultRuntime, workerCommand, workerRuntime } from '../src/worker-config.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

function names(people: Identity[], requested: string, known: string[] = [], workers: { name: string; status: 'running' | 'done' }[] = []) {
  const room = { me: { name: 'lead', kind: 'agent' }, room: {
    colors: new Map(known.map(name => [name, 1])), scopes: new Map(), manifestHead: new Map(), openClaims: () => [],
    workerViews: new Map(), acceptedWorkerViews: () => workers, retiredWorkers: () => [], messages: () => [], mail: new Map(),
    doc: { getMap: () => new Map() }, allScopes: () => [],
  } } as unknown as Session
  const context: NameContext = { all: () => [room], presences: () => people.map(user => ({ user })), myWorkers: () => [] }
  return resolveDisplayedName(requested, context, room)
}

it('resolves a single tagged active agent from owner phrasing or bare owner', () => {
  const cy: Identity = { name: 'cy+codex', owner: 'cy', kind: 'agent' }
  expect(names([cy], "CY’S AGENT")).toEqual({ name: cy.name })
  expect(names([cy], 'Cy')).toEqual({ name: cy.name })
})

it('reports multiple active owner agents, while exact names still win', () => {
  const people: Identity[] = [{ name: 'cy+codex', owner: 'cy', kind: 'agent' }, { name: 'cy+claude', owner: 'cy', kind: 'agent' }]
  expect(names(people, "cy's agent")).toEqual({ ambiguous: ['cy+claude', 'cy+codex'] })
  expect(names(people, 'cy+codex')).toEqual({ name: 'cy+codex' })
  expect(names(people, 'cy', ['cy'])).toEqual({ name: 'cy' })
})

it('ignores old offline names when an active owner agent exists', () => {
  expect(names([{ name: 'cy+codex', owner: 'cy', kind: 'agent' }], "cy's agent", ['cy+old']))
    .toEqual({ name: 'cy+codex' })
})

it('includes a running worker in owner ambiguity but ignores a done worker', () => {
  const cy: Identity = { name: 'cy+codex', owner: 'cy', kind: 'agent' }
  expect(names([cy], "cy's agent", [], [{ name: 'cy+helper', status: 'running' }]))
    .toEqual({ ambiguous: ['cy+codex', 'cy+helper'] })
  expect(names([cy], "cy's agent", [], [{ name: 'cy+helper', status: 'done' }]))
    .toEqual({ name: 'cy+codex' })
})

it('uses request, per-host, generic and then host worker defaults in that order', () => {
  const env = { ROOM_WORKER_MODEL: 'generic', ROOM_WORKER_EFFORT: 'low', ROOM_CODEX_WORKER_MODEL: 'codex-model', ROOM_CODEX_WORKER_EFFORT: 'high' }
  expect(workerRuntime('codex', 'named', 'medium', env)).toEqual({ model: 'named', effort: 'medium' })
  expect(workerRuntime('codex', undefined, undefined, env)).toEqual({ model: 'codex-model', effort: 'high' })
  expect(workerRuntime('claude', undefined, undefined, env)).toEqual({ model: 'generic', effort: 'low' })
  expect(workerRuntime('codex', undefined, undefined, {})).toEqual({ model: undefined, effort: undefined })
  for (const host of ['codex', 'claude'] as const) {
    const command = workerCommand(host, undefined, 'task', undefined, undefined)
    expect(command.args).not.toContain('-m')
    expect(command.args).not.toContain('--model')
    expect(command.args).not.toContain('--effort')
    expect(command.args.some(arg => arg.startsWith('model_reasoning_effort='))).toBe(false)
    const named = workerCommand(host, 'named', 'task', undefined, 'high').args
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
  expect(hostDefaultRuntime('codex', project, { CODEX_HOME: codex })).toEqual({ model: 'configured-codex', effort: 'high' })
  expect(hostDefaultRuntime('claude', project, { CLAUDE_CONFIG_DIR: claude })).toEqual({ model: 'project-claude' })
  expect(hostDefaultRuntime('codex', project, { CODEX_HOME: path.join(dir, 'missing') })).toEqual({})
})
