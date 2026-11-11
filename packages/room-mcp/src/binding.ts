import type { HostId } from './hosts/types.js'
/**
 * This MCP's host session (registry §17), re-evaluated on use: a new SessionStart after Claude /clear
 * rebinds. The parent's identity and command line never change for a process, so they are read once.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { boundSession, sessionDirectory, syntheticSessionId } from './session.js'
import { admittedIdentityKey } from './hosts/selection.js'
import { probeOwnProcess, probeProcessNow, type ProcessInfo } from './worker-process.js'

export interface SessionBinding {
  /** The bound host session, or undefined until the shared Codex app-server supplies its thread ID. */
  bound(): { id: string; host: HostId } | undefined
  /** The session receipts name: the bound one, else this process's synthetic `mcp:<pid>:<startTime>`. */
  id(): string
  /** `<common>/room/sessions/<sid>/` of the bound session. */
  dir(): string | undefined
  commonDir(): string | undefined
}

const RECHECK_MS = 1_000


export function createSessionBinding(cwd: string, env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now): SessionBinding {
  let commonDir: string | null | undefined
  let commonCheckedAt = -Infinity
  let parent: ReturnType<typeof identity> | null | undefined
  let parentArgs: string | undefined
  let cached: { at: number; identityKey?: string; value: ReturnType<SessionBinding['bound']> } | undefined
  // A repository found once never moves. A folder that is not one yet (git init after the session started) is
  // re-checked once a second, and git runs again only once a `.git` entry exists in the folder or a parent:
  // an idle session in a plain folder stats a few paths and spawns nothing.
  const common = () => {
    if (commonDir === null && (now() - commonCheckedAt < RECHECK_MS || !gitEntryAbove(cwd))) return undefined
    if (commonDir === undefined || commonDir === null) {
      commonCheckedAt = now()
      try { commonDir = path.resolve(cwd, execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()) }
      catch { commonDir = null }
    }
    return commonDir ?? undefined
  }
  const self = identity(probeOwnProcess(), process.pid)
  const bound = () => {
    const identityKey = admittedIdentityKey()
    if (cached && cached.identityKey === identityKey && now() - cached.at < RECHECK_MS) return cached.value
    if (parent === undefined) {
      // Read once for the session: the cached probe answers a Windows miss as pending, which would fix it as unknown.
      parent = identity(probeProcessNow(process.ppid), process.ppid) ?? null
      try { parentArgs = execFileSync('ps', ['-o', 'args=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { parentArgs = '' }
    }
    const dir = common()
    const value = dir ? boundSession({ commonDir: dir, cwd, env, ...(parent ? { parent } : {}), parentArgs }) : undefined
    cached = { at: now(), value, identityKey }
    return value
  }
  return {
    bound,
    id: () => bound()?.id ?? syntheticSessionId(self ?? { pid: process.pid, startTime: '', executable: '' }),
    dir: () => {
      const b = bound(), dir = common()
      if (!b || !dir) return undefined
      return sessionDirectory(dir, b.id)
    },
    commonDir: common,
  }
}

/** Whether `dir` or an ancestor holds a `.git` entry (directory or worktree file): the only way a repository can appear. */
function gitEntryAbove(dir: string): boolean {
  let current = path.resolve(dir)
  for (;;) {
    try { fs.statSync(path.join(current, '.git')); return true } catch { /* not here */ }
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

function identity(info: ProcessInfo | undefined, pid: number) {
  return info?.startTime && info.executable ? { pid, startTime: info.startTime, executable: info.executable } : undefined
}
