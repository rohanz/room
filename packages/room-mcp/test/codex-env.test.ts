import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { workerCommand, workerProcessEnv } from '../src/worker-config.js'

it('passes every launched worker ROOM variable through the Codex MCP allow-list', () => {
  const file = fileURLToPath(new URL('../../../plugins/room/codex-mcp.json', import.meta.url))
  const plugin = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    mcpServers: { room: { env_vars: string[]; env: Record<string, string> } }
  }
  const launched = workerProcessEnv({ threads: 1, memGb: 1, host: 'codex', model: 'gpt-6-sol', effort: 'high',
    server: 'local', room: 'local/repo/main', dir: '/repo/.room/workers/test', tag: 'test',
    lead: 'lead', owner: 'lead', share: 'intent', run: 1, nonce: 'launch-nonce',
    registry: '/repo/.git/room/registry', id: 'w_test', token: 'token', logDir: '/repo', isWorker: false })
  const passed = new Set([...plugin.mcpServers.room.env_vars, ...Object.keys(plugin.mcpServers.room.env)])
  const missing = Object.keys(launched).filter(key => key.startsWith('ROOM_') && !passed.has(key))
  expect(missing).toEqual([])
})

it('passes the documented ROOM_ tuning knobs through the Codex MCP allow-list', () => {
  const file = fileURLToPath(new URL('../../../plugins/room/codex-mcp.json', import.meta.url))
  const envVars = (JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: { room: { env_vars: string[] } } }).mcpServers.room.env_vars
  // A Codex-hosted MCP sees only allow-listed variables; the MCP reads these tuning knobs from its environment.
  for (const knob of ['ROOM_AUTO_FETCH', 'ROOM_GIT_TIMEOUT_MS', 'ROOM_IDLE_LEASE_MS', 'ROOM_WORKER_MAX_BUDGET_USD', 'ROOM_WORKER_NICE', 'ROOM_WAKE']) {
    expect(envVars).toContain(knob)
  }
})

it('forwards ROOM_WAKE=channels into a Claude worker launch', () => {
  const file = fileURLToPath(new URL('../../../plugins/room/codex-mcp.json', import.meta.url))
  const envVars = (JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: { room: { env_vars: string[] } } }).mcpServers.room.env_vars
  const shell = { ROOM_WAKE: 'channels' }
  const forwarded = Object.fromEntries(Object.entries(shell).filter(([key]) => envVars.includes(key)))
  const command = workerCommand('claude', undefined, 'task', 'plugin:room@room', undefined,
    { wakeChannels: forwarded.ROOM_WAKE === 'channels' })
  expect(command.args).toContain('--dangerously-load-development-channels')
  expect(command.args).toContain('plugin:room@room')
})
