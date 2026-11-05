import type { Env, HostAdapter } from './types.js'

const value = (env: Env, key: string) => env[key]?.trim() || undefined

export const codexPreBinding: HostAdapter['preBinding'] = {
  startup({ env, processDir, platform, parentCommand }) {
    return {
      fallbackDir: value(env, 'ROOM_DIR') ?? value(env, 'PWD') ?? value(env, 'INIT_CWD') ?? processDir,
      // Unknown parent is conservative at startup. Presence classification has a different fallback.
      deferWorkspace: !value(env, 'ROOM_DIR') && (platform === 'win32' || !parentCommand?.trim() || parentCommand.trim().includes('app-server')),
      presenceKind: parentCommand?.includes('app-server') ? 'shared-app-server' : 'interactive',
    }
  },
  decodeCall(rawMeta) {
    if (!rawMeta || typeof rawMeta !== 'object') return { workspaceCandidates: [] }
    const turn = (rawMeta as Record<string, unknown>)['x-codex-turn-metadata']
    if (!turn || typeof turn !== 'object') return { workspaceCandidates: [] }
    const fields = turn as Record<string, unknown>
    const workspaces = fields.workspaces
    return { toolSessionId: typeof fields.thread_id === 'string' ? fields.thread_id : undefined,
      workspaceCandidates: workspaces && typeof workspaces === 'object' && !Array.isArray(workspaces) ? Object.keys(workspaces) : [] }
  },
}

/** Keep the existing early returns: do not probe a parent for workers, other hosts or Windows. */
export function deferWorkspace(env: Env, readParent: () => string, platform: string): boolean {
  if (env.ROOM_HOST !== 'codex' || value(env, 'ROOM_DIR')) return false
  if (platform === 'win32') return true
  try {
    const command = readParent().trim()
    return !command || command.includes('app-server')
  } catch { return true }
}
