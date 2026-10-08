/**
 * This MCP's host session (registry §17), re-evaluated on use: a new SessionStart after Claude /clear
 * rebinds. The parent's identity and command line never change for a process, so they are read once.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { admitCodexThread, admittedCodexThread, boundSession, sessionDirectory, syntheticSessionId } from './session.js'
import { probeProcess } from './worker-process.js'
import { migrateLocalState } from './local-migration.js'

export interface SessionBinding {
  /** The bound host session, or undefined until the shared Codex app-server supplies its thread ID. */
  bound(): { id: string; host: 'claude' | 'codex' } | undefined
  /** The session receipts name: the bound one, else this process's synthetic `mcp:<pid>:<startTime>`. */
  id(): string
  /** `<common>/room/sessions/<sid>/` of the bound session. */
  dir(): string | undefined
  commonDir(): string | undefined
}

const RECHECK_MS = 1_000

export function createSessionBinding(cwd: string, env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now,
  options: { log?: (line: string) => void } = {}): SessionBinding & { admitCodexThread(id: string): void } {
  let commonDir: string | null | undefined
  let parent: ReturnType<typeof identity> | null | undefined
  let parentArgs: string | undefined
  let cached: { at: number; codexThreadId?: string; value: ReturnType<SessionBinding['bound']> } | undefined
  let ownGitDir: string | undefined
  const migrated = new Set<string>()
  const common = () => {
    if (commonDir === undefined) {
      try { commonDir = path.resolve(cwd, execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()) }
      catch { commonDir = null }
    }
    return commonDir ?? undefined
  }
  const self = identity(process.pid)
  const bound = () => {
    const codexThreadId = admittedCodexThread()
    if (cached && cached.codexThreadId === codexThreadId && now() - cached.at < RECHECK_MS) return cached.value
    if (parent === undefined) {
      parent = identity(process.ppid) ?? null
      try { parentArgs = execFileSync('ps', ['-o', 'args=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { parentArgs = '' }
    }
    const dir = common()
    const value = dir ? boundSession({ commonDir: dir, cwd, env, ...(parent ? { parent } : {}), parentArgs }) : undefined
    cached = { at: now(), value, codexThreadId }
    return value
  }
  return {
    admitCodexThread: id => admitCodexThread(id, options.log),
    bound,
    id: () => bound()?.id ?? syntheticSessionId(self ?? { pid: process.pid, startTime: '', executable: '' }),
    dir: () => {
      const b = bound(), dir = common()
      if (!b || !dir) return undefined
      const target = sessionDirectory(dir, b.id)
      if (!migrated.has(b.id)) {
        try {
          ownGitDir ??= execFileSync('git', ['-C', cwd, 'rev-parse', '--absolute-git-dir'],
            { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
          if (migrateLocalState(ownGitDir, target, b.id, path.join(dir, 'room', 'registry'))) migrated.add(b.id)
        } catch { /* retry on the next call; local migration must never block Room */ }
      }
      return target
    },
    commonDir: common,
  }
}

function identity(pid: number) {
  const info = probeProcess(pid)
  return info?.startTime && info.executable ? { pid, startTime: info.startTime, executable: info.executable } : undefined
}
