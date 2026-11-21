vi.mock('../src/hosts/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/hosts/index.js')>()
  return { ...original, workerAdapter: (...args: Parameters<typeof original.workerAdapter>) => {
    const adapter = original.workerAdapter(...args)
    return { ...adapter, shellWarnings: (written: { warning?: string }) => adapter.shellWarnings(written, async () => 'codex-cli 0.145.3') }
  } }
})
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import type { Session } from '../src/session.js'
import type { SpawnSpec } from '../src/worker-process.js'
import * as roomGit from '@room/roomd/git'
import { workerEnv } from '../src/worker-config.js'

vi.mock('../src/port-reservations.js', () => ({
  reserveWorkerPort: () => ({ port: 4417, release: () => {} }), bindWorkerPortReservation: () => {},
}))

import { launchWorkerProcess } from '../src/worker-launch.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

async function launch(host: 'claude' | 'codex', mode: 'fresh' | 'resume', blockWrite = false, overrides: { effort?: string; sessionId?: string; ownsBuildDir?: boolean; setup?: (root: string) => void } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-launch-shell-'))
  roots.push(root)
  execFileSync('git', ['init', '-q', root])
  const inherited = path.join(root, "lead's env.sh")
  fs.writeFileSync(inherited, 'export USER_SETTING=kept\nexport ROOM_LEAD_FILE=private\n')
  vi.stubEnv('CLAUDE_ENV_FILE', inherited)
  vi.stubEnv('ROOM_WORKER_NICE', '0')
  if (blockWrite) fs.writeFileSync(path.join(root, '.room'), 'blocked')
  overrides.setup?.(root)
  let spec: SpawnSpec | undefined
  const proc = { pid: 4242, started: Promise.resolve(), onExit: () => {}, kill: () => true, isRunning: () => true }
  const result = await launchWorkerProcess({ session: { dir: root, roomName: 'local/repo' } as Session,
    id: 'worker-id', tag: 'w', dir: root, lead: 'lead', owner: 'lead', host, effort: overrides.effort, share: 'intent', run: 1, nonce: 'nonce', registry: root,
    budget: { threads: 2, memGb: 1, nice: 0 }, server: 'local', isWorker: true, token: 'test-token', ownsBuildDir: overrides.ownsBuildDir,
    spawner: value => { spec = value; return proc }, probe: () => ({ startTime: 'birth', executable: 'fixture' }), log: () => {} },
  mode === 'fresh' ? { mode, task: 'task', links: [], sessionId: overrides.sessionId ?? 'retained-id' } : { mode, sessionId: overrides.sessionId ?? 'retained-id', followUp: 'follow up', oldPort: 4417 },
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

it.each(['claude', 'codex'] as const)('%s launch retains effort and resume-id validation', async host => {
  await expect(launch(host, 'resume', false, { effort: 'invalid' })).rejects.toThrow('effort must be minimal|low|medium|high')
  await expect(launch(host, 'resume', false, { sessionId: '' })).rejects.toThrow('resuming a worker requires its host session id')
})


it.each(['fresh', 'resume'] as const)('%s owned launch prepares the advertised ignored build directory and preserves it in Claude shells', async mode => {
  const { spec, root } = await launch('claude', mode, false, { ownsBuildDir: true })
  const build = path.join(fs.realpathSync.native(root), '.room/scratch/w')
  expect(spec.env.WORKER_BUILD_DIR).toBe(build)
  expect(fs.statSync(build).isDirectory()).toBe(true)
  expect(spec.args.some(arg => arg.includes(`${build} (WORKER_BUILD_DIR)`))).toBe(true)
  expect(execFileSync('git', ['check-ignore', '.room/scratch/w/'], { cwd: root, encoding: 'utf8' })).toContain('.room/scratch/w/')
  if (process.platform !== 'win32') {
    const shellEnv = execFileSync('sh', ['-c', '. "$CLAUDE_ENV_FILE"; env'], { env: workerEnv(process.env, spec.env), encoding: 'utf8' })
    expect(shellEnv).toContain(`WORKER_BUILD_DIR=${build}`)
    expect(shellEnv.split('\n').filter(line => line.startsWith('ROOM_'))).toEqual([])
  }
})


const unavailableBuildCases = ['tracked path', 'obstructing file', 'changed ignore file', 'not writable', 'not ignored'] as const
for (const host of ['claude', 'codex'] as const) for (const mode of ['fresh', 'resume'] as const) {
  it.each(unavailableBuildCases)(`${host} ${mode} starts without a build directory when setup fails: %s`, async failure => {
    vi.stubEnv('WORKER_BUILD_DIR', '/outside/inherited-build')
    const { result, spec, root } = await launch(host, mode, false, { ownsBuildDir: true, setup: root => {
      const scratch = path.join(root, '.room/scratch')
      fs.mkdirSync(path.dirname(scratch), { mode: 0o700 })
      if (failure === 'tracked path' || failure === 'obstructing file') {
        fs.writeFileSync(scratch, 'project content')
        if (failure === 'tracked path') execFileSync('git', ['add', '--', '.room/scratch'], { cwd: root })
      } else if (failure === 'changed ignore file') {
        fs.mkdirSync(scratch, { mode: 0o700 })
        fs.writeFileSync(path.join(scratch, '.gitignore'), '!w/\n')
      } else if (failure === 'not writable') {
        const access = fs.promises.access
        vi.spyOn(fs.promises, 'access').mockImplementation(async (file, mode) => {
          if (String(file).endsWith(path.join('.room', 'scratch', 'w'))) throw Object.assign(new Error('build directory permission denied'), { code: 'EACCES' })
          return access(file, mode)
        })
      } else {
        const git = roomGit.git
        vi.spyOn(roomGit, 'git').mockImplementation(async (dir, args, ...rest) => {
          if (args[0] === 'check-ignore') throw new Error('build directory is not ignored')
          return git(dir, args, ...rest)
        })
      }
    } })
    if (failure === 'tracked path' || failure === 'obstructing file') expect(fs.readFileSync(path.join(root, '.room/scratch'), 'utf8')).toBe('project content')
    if (failure === 'changed ignore file') expect(fs.readFileSync(path.join(root, '.room/scratch/.gitignore'), 'utf8')).toBe('!w/\n')
    expect(result.proc.pid).toBe(4242)
    expect(workerEnv(process.env, spec.env)).not.toHaveProperty('WORKER_BUILD_DIR')
    const warning = result.warnings.find(w => w.includes('No build directory is available'))
    expect(warning).toBeDefined()
    expect(warning).toContain('WORKER_BUILD_DIR is unset')
    expect(warning).not.toContain('supplied dir=')
    expect(spec.args.some(arg => arg.includes(warning!.replace(/^warning: /, '')))).toBe(true)
  })
}
