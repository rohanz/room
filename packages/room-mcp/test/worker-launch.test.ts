import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import type { Session } from '../src/session.js'
import type { SpawnSpec } from '../src/worker-process.js'
import { workerEnv } from '../src/worker-config.js'

vi.mock('../src/port-reservations.js', () => ({
  reserveWorkerPort: () => ({ port: 4417, release: () => {} }), bindWorkerPortReservation: () => {},
}))
vi.mock('../src/worker-shell-env.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/worker-shell-env.js')>()
  return { ...original, workerShellEnvWarnings: (host: 'claude' | 'codex', written: { warning?: string }) =>
    original.workerShellEnvWarnings(host, written, async () => 'codex-cli 0.145.3') }
})
import { launchWorkerProcess } from '../src/worker-launch.js'

const roots: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

async function launch(host: 'claude' | 'codex', mode: 'fresh' | 'resume', blockWrite = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-launch-shell-'))
  roots.push(root)
  execFileSync('git', ['init', '-q', root])
  const inherited = path.join(root, "lead's env.sh")
  fs.writeFileSync(inherited, 'export USER_SETTING=kept\nexport ROOM_LEAD_FILE=private\n')
  vi.stubEnv('CLAUDE_ENV_FILE', inherited)
  vi.stubEnv('ROOM_WORKER_NICE', '0')
  if (blockWrite) fs.writeFileSync(path.join(root, '.room'), 'blocked')
  let spec: SpawnSpec | undefined
  const proc = { pid: 4242, started: Promise.resolve(), onExit: () => {}, kill: () => true, isRunning: () => true }
  const result = await launchWorkerProcess({ session: { dir: root, roomName: 'local/repo' } as Session,
    id: 'worker-id', tag: 'w', dir: root, lead: 'lead', owner: 'lead', host, share: 'intent', run: 1, nonce: 'nonce', registry: root,
    budget: { threads: 2, memGb: 1, nice: 0 }, server: 'local', isWorker: true, token: 'test-token', claudeChannel: '',
    spawner: value => { spec = value; return proc }, probe: () => ({ startTime: 'birth', executable: 'fixture' }), log: () => {} },
  mode === 'fresh' ? { mode, task: 'task', links: [], sessionId: 'retained-id' } : { mode, sessionId: 'retained-id', followUp: 'follow up', oldPort: 4417 },
  { setHandle: () => {}, watch: () => {}, aborted: () => false },
  { onLaunched: async () => {}, onSpawn: async () => {}, onExit: async () => {} })
  return { result, spec: spec!, root, inherited }
}

it.each(['fresh', 'resume'] as const)('%s launch applies successful shell artifacts without scrubbing the host/MCP environment', async mode => {
  const { result, spec, root, inherited } = await launch('claude', mode)
  const file = path.join(root, '.room/workers/w.env.sh')
  expect(spec.env.CLAUDE_ENV_FILE).toBe(file)
  expect(spec.env).toMatchObject({ ROOM_WORKER_ID: 'worker-id', ROOM_TOKEN: 'test-token', PORT: '4417', OMP_NUM_THREADS: '2' })
  expect(fs.readFileSync(file, 'utf8')).toContain('lead')
  expect(result.warnings).toEqual([])
  const settings = JSON.parse(spec.args[spec.args.indexOf('--settings') + 1])
  expect(settings.hooks.PreToolUse[0].matcher).toBe('PowerShell')
  expect(spec.args).toContain('acceptEdits')
  expect(spec.args).not.toContain('--dangerously-skip-permissions')
  const env = workerEnv(process.env, spec.env)
  expect(env.CLAUDE_ENV_FILE).not.toBe(inherited)
  if (process.platform !== 'win32') {
    const shellEnv = execFileSync('sh', ['-c', '. "$CLAUDE_ENV_FILE"; env'], { env, encoding: 'utf8' })
    expect(shellEnv.split('\n').filter(line => line.startsWith('ROOM_'))).toEqual([])
    expect(shellEnv).toContain('USER_SETTING=kept')
    expect(shellEnv).toContain('PORT=4417')
    expect(shellEnv).toContain('OMP_NUM_THREADS=2')
    expect(env.ROOM_WORKER_ID).toBe('worker-id')
    expect(env.ROOM_TOKEN).toBe('test-token')
  }
})

it.each(['fresh', 'resume'] as const)('%s launch warns on artifact failure and preserves the inherited env file', async mode => {
  const { result, spec, inherited } = await launch('claude', mode, true)
  expect(spec.env).not.toHaveProperty('CLAUDE_ENV_FILE')
  expect(workerEnv(process.env, spec.env).CLAUDE_ENV_FILE).toBe(inherited)
  expect(workerEnv({}, spec.env)).not.toHaveProperty('CLAUDE_ENV_FILE')
  expect(result.warnings).toEqual([expect.stringMatching(/^warning: could not write .*w\.env\.sh .*; w's Bash commands still see Room's ROOM_\* variables\.$/)])
  expect(spec.env.ROOM_WORKER_ID).toBe('worker-id')
  expect(spec.args).toContain('--settings') // PowerShell isolation remains independent of the Bash artifact.
})

it.each(['fresh', 'resume'] as const)('%s Codex launch uses filters and a version warning without writing shell artifacts', async mode => {
  const { result, spec, root } = await launch('codex', mode, true)
  expect(spec.env).not.toHaveProperty('CLAUDE_ENV_FILE')
  expect(fs.readFileSync(path.join(root, '.room'), 'utf8')).toBe('blocked')
  expect(spec.args).toContain('shell_environment_policy.filters={"ROOM_*"="exclude"}')
  expect(spec.env).toMatchObject({ ROOM_WORKER_ID: 'worker-id', ROOM_TOKEN: 'test-token', PORT: '4417', OMP_NUM_THREADS: '2' })
  expect(result.warnings).toEqual([expect.stringContaining('predates shell_environment_policy.filters (0.146.0)')])
  expect(spec.args).not.toContain('--settings')
})
