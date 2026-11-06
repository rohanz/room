import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Env, HostAdapter, Runtime, WorkerCommandInput, WorkerShellIsolation } from './types.js'
import { randomUUID } from 'node:crypto'
import { POWERSHELL_HOOK_ARGS, claudeShellArtifacts, claudeShellEnv, claudeShellWarnings } from './claude-shell.js'

/** Only public configuration is read; credentials are never inspected. */
function defaults(dir: string, env: Env): Runtime {
  const roots = [path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json'), path.join(dir, '.claude', 'settings.json')]
  let model: string | undefined
  for (const file of roots) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { model?: unknown }
      if (typeof parsed.model === 'string' && parsed.model.trim()) model = parsed.model.trim()
    } catch { /* absent or invalid settings */ }
  }
  return { model }
}

function command(input: WorkerCommandInput) {
  const { runtime: { model, effort }, prompt, claudeChannel } = input
  const options = { ...input, resume: input.mode === 'resume' }
  const settings = {
    ...(options.pluginDir ? { enabledPlugins: { 'room@room': false } } : {}),
    ...(options.shellEnvHook ? { hooks: { PreToolUse: [{ matcher: 'PowerShell', hooks: [
      { type: 'command', command: 'node', args: POWERSHELL_HOOK_ARGS, timeout: 5 },
    ] }] } } : {}),
  }
  return {
    cmd: 'claude',
    args: [...(options.pluginDir ? ['--plugin-dir', options.pluginDir] : []), ...(Object.keys(settings).length ? ['--settings', JSON.stringify(settings)] : []), ...(options.wakeChannels && claudeChannel ? ['--dangerously-load-development-channels', claudeChannel] : []), '-p', ...(options.resume ? ['--resume', options.sessionId!] : []), prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__room__*,mcp__plugin_room_room__*,Edit,Write,Read,Bash,Glob,Grep', ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), ...(options.tag ? ['--name', options.tag] : []), ...(!options.resume && options.sessionId ? ['--session-id', options.sessionId] : []), ...(options.maxBudgetUsd ? ['--max-budget-usd', options.maxBudgetUsd] : [])],
  }
}

export function createClaudeWorker(env: Env = process.env): Pick<NonNullable<HostAdapter['worker']>, 'capabilities' | 'freshSessionId' | 'defaults' | 'normalizeRuntime' | 'command'> & WorkerShellIsolation {
  return { capabilities: { resume: true }, freshSessionId: () => randomUUID(),
    // Every 0.17 release pre-generates a Claude worker's id at intent and passes it as --session-id or --resume.
    defaults: cwd => defaults(cwd, env),
    normalizeRuntime: runtime => ({ ...runtime, effort: runtime.effort === 'minimal' ? 'low' : runtime.effort }), command,
    launchOptions: { shellEnvHook: true, developmentPlugin: true }, inheritedShellEnvFile: env.CLAUDE_ENV_FILE,
    shellEnv: claudeShellEnv, shellWarnings: claudeShellWarnings,
    plan: async input => ({ ...command(input), envPatch: {}, warnings: [],
      ...claudeShellArtifacts(input.logDir, input.tag, input.inheritedShellEnvFile) }),
  }
}
