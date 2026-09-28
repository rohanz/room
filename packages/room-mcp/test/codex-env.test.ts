import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { workerProcessEnv } from '../src/worker-config.js'

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
