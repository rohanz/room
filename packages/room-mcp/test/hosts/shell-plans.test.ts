import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkerInput, WorkerPlan } from '../../src/hosts/types.js'
import { writeWorkerArtifacts } from '../../src/worker-artifacts.js'
import { workerAdapter } from '../../src/hosts/index.js'
import { codexShellFilterWarning } from '../../src/hosts/codex-shell.js'
import { POWERSHELL_HOOK_ARGS, workerShellEnvScript } from '../../src/hosts/claude-shell.js'

const baseline = JSON.parse(fs.readFileSync(new URL('./shell-baseline.json', import.meta.url), 'utf8'))
const roots: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-shell-plan-')); roots.push(root); return root }
const input = (logDir: string): WorkerInput => ({ mode: 'fresh', prompt: 'task', runtime: {}, tag: 'w', cwd: logDir, logDir,
  env: {}, claudeChannel: '', shellEnvHook: true, wakeChannels: true, inheritedShellEnvFile: "C:\\lead's dir\\env.sh" })

it('retains the exact pre-extraction shell encodings and old-version warning', () => {
  // Captured from HEAD's worker-shell-env.ts before extraction; do not regenerate from adapters.
  expect(workerShellEnvScript()).toBe(baseline.plain)
  expect(workerShellEnvScript("C:\\lead's dir\\env.sh")).toBe(baseline.inherited)
  expect(POWERSHELL_HOOK_ARGS).toEqual(baseline.powerShellArgs)
  expect(codexShellFilterWarning('codex-cli 0.145.3')).toBe(baseline.oldVersionWarning)
})

it.each(['claude', 'codex'] as const)('%s plans preserve command overrides for fresh and resumed workers', async host => {
  const worker = workerAdapter(host, {})
  for (const mode of ['fresh', 'resume'] as const) for (const shellEnvHook of [false, true]) for (const pluginDir of [undefined, '/plugin space']) {
    const request = { ...input(temp()), mode, shellEnvHook, pluginDir, sessionId: 'retained-id', maxBudgetUsd: '2.50', runtime: { model: 'fixture', effort: 'high' } }
    const plan = await worker.plan(request)
    expect(plan.cmd).toBe(host)
    expect(plan.args).toContain('fixture')
    expect(plan.args).toContain('task')
    expect(plan.args.includes('--resume') || plan.args.includes('resume')).toBe(mode === 'resume')
    if (host === 'claude') {
      expect(plan.args.includes('--plugin-dir')).toBe(!!pluginDir)
      expect(plan.args.some(arg => arg.includes('PreToolUse'))).toBe(shellEnvHook)
      expect(plan.args).toContain('--max-budget-usd')
    }
    expect(plan.envPatch).toEqual({})
    if (host === 'claude') {
      expect(plan.artifacts).toEqual([{ id: 'shell-env', path: path.join(request.logDir, '.room/workers/w.env.sh'), content: baseline.inherited, mode: 0o600 }])
      expect(plan.artifactEnv).toEqual([{ artifactId: 'shell-env', key: 'CLAUDE_ENV_FILE' }])
    } else {
      expect(plan.args).toContain(baseline.filter)
      expect(plan.artifacts).toEqual([])
      expect(plan.artifactEnv).toEqual([])
    }
    expect(fs.existsSync(path.join(request.logDir, '.room'))).toBe(false)
  }
})

it('plans use the explicit inherited file without reading ambient environment', async () => {
  vi.stubEnv('CLAUDE_ENV_FILE', '/ambient/should-not-be-read')
  const worker = workerAdapter('claude', {})
  const plan = await worker.plan({ ...input(temp()), inheritedShellEnvFile: undefined })
  expect(plan.artifacts[0].content).toBe(baseline.plain)
})

it('reports individual write outcomes and applies only successful artifact environment', () => {
  const root = temp(), directory = path.join(root, '.room/workers')
  fs.mkdirSync(directory, { recursive: true })
  const good = path.join(directory, 'good.env'), bad = path.join(directory, 'bad.env')
  fs.mkdirSync(bad)
  const written = writeWorkerArtifacts(root, {
    artifacts: [{ id: 'good', path: good, content: 'good', mode: 0o600 }, { id: 'bad', path: bad, content: 'bad', mode: 0o600 }],
    artifactEnv: [{ artifactId: 'good', key: 'GOOD_FILE' }, { artifactId: 'bad', key: 'BAD_FILE' }], envPatch: { USER_SETTING: 'kept' },
  })
  expect(written.outcomes).toEqual([{ artifactId: 'good', path: good, written: true }, { artifactId: 'bad', path: bad, written: false, error: expect.any(String) }])
  expect(written.envPatch).toEqual({ USER_SETTING: 'kept', GOOD_FILE: good })
  expect(fs.readFileSync(good, 'utf8')).toBe('good')
})

it('validates the whole plan before any write and refuses unconditional artifact environment', () => {
  const root = temp(), file = path.join(root, '.room/workers/w.env')
  const plan: Pick<WorkerPlan, 'artifacts' | 'artifactEnv' | 'envPatch'> = {
    artifacts: [{ id: 'shell', path: file, content: 'script', mode: 0o600 }], artifactEnv: [{ artifactId: 'shell', key: 'ENV_FILE' }], envPatch: {},
  }
  for (const invalid of [
    { ...plan, artifacts: [...plan.artifacts, { id: 'outside', path: path.join(root, 'outside'), content: 'no', mode: 0o600 }] },
    { ...plan, artifacts: [...plan.artifacts, plan.artifacts[0]] },
    { ...plan, artifactEnv: [{ artifactId: 'missing', key: 'ENV_FILE' }] },
    { ...plan, artifactEnv: [{ artifactId: 'shell', key: 'INVALID=KEY' }] },
    { ...plan, envPatch: { ENV_FILE: file } },
    { ...plan, envPatch: { OTHER_FILE: file } },
  ]) {
    expect(() => writeWorkerArtifacts(root, invalid)).toThrow(/worker artifact/)
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(path.join(root, 'outside'))).toBe(false)
  }
})
