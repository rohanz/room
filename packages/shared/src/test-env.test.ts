import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { isolateTestEnv } from './test-env.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

it('does not pass Claude session identity into tests or their child processes', () => {
  const keys = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']
  for (const key of keys) expect(process.env[key]).toBeUndefined()
  const inherited = JSON.parse(execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).filter(k => k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE")))'], { encoding: 'utf8' })) as string[]
  for (const key of keys) expect(inherited).not.toContain(key)
})

it('strips what a Room worker, its host and a git hook pass down, and points config dirs at the test home', () => {
  const env: NodeJS.ProcessEnv = {
    PATH: '/bin', HOME: '/home/u', USER: 'u', LANG: 'C', TMPDIR: '/tmp', NODE_ENV: 'test', VITEST: 'true', GIT_TRACE: '0',
    ROOM_WORKER_ID: 'w', ROOM_WORKER_RUN: '1', ROOM_LAUNCH_NONCE: 'n', ROOM_REGISTRY: '/r', ROOM_WORKER_HOST: 'claude',
    CLAUDE_PLUGIN_ROOT: '/p', CLAUDE_PLUGIN_DATA: '/d', CLAUDE_PROJECT_DIR: '/x', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/home/u/.claude',
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1', CLAUDE_CODE_SUBPROCESS_ENV_KEEP: 'PATH',
    CODEX_HOME: '/home/u/.codex', CODEX_THREAD_ID: 't', CODEX_COMPANION_SESSION_ID: 's', CODEX_SANDBOX: 'seatbelt',
    GIT_DIR: '/lead/.git', GIT_WORK_TREE: '/lead', GIT_INDEX_FILE: '/lead/.git/index', GIT_COMMON_DIR: '/lead/.git', GIT_CONFIG_PARAMETERS: "'a.b=c'",
    PORT: '4414', VIRTUAL_ENV: '/lead/.venv', OMP_NUM_THREADS: '1', RAYON_NUM_THREADS: '1',
    DATABASE_URL: 'postgres://prod', YPERSISTENCE: '/data', PUBLIC_URL: 'https://room', GITHUB_CLIENT_ID: 'real', OIDC_ISSUER: 'https://idp', HOST: '0.0.0.0',
  }
  isolateTestEnv(env, '/tmp/cfg')
  expect(env).toEqual({
    PATH: '/bin', HOME: '/home/u', USER: 'u', LANG: 'C', TMPDIR: '/tmp', NODE_ENV: 'test', VITEST: 'true', GIT_TRACE: '0',
    XDG_CONFIG_HOME: '/tmp/cfg', CODEX_HOME: path.join('/tmp/cfg', 'codex'), CLAUDE_CONFIG_DIR: path.join('/tmp/cfg', 'claude'),
  })
})

it('loads the shared setup when vitest runs from any package directory', async () => {
  // vitest looks for a config only in its working directory; without one, a run from a package skips vitest.setup.ts.
  const setup = path.join(repoRoot, 'vitest.setup.ts')
  for (const name of fs.readdirSync(path.join(repoRoot, 'packages'))) {
    const dir = path.join(repoRoot, 'packages', name)
    const tests = fs.existsSync(path.join(dir, 'test')) || fs.readdirSync(path.join(dir, 'src'), { recursive: true }).some(f => String(f).endsWith('.test.ts'))
    if (!tests) continue
    const file = path.join(dir, 'vitest.config.ts')
    expect(fs.existsSync(file), `${name} has no vitest.config.ts`).toBe(true)
    const config = (await import(file)).default as { test?: { setupFiles?: string[]; include?: string[] } }
    expect(config.test?.setupFiles, name).toEqual([setup])
    expect(config.test?.include, name).toEqual(['src/**/*.test.ts', 'test/**/*.test.ts'])
  }
})
