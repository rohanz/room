import fs from 'node:fs'
import type { Env, HostAdapter } from './types.js'

const value = (env: Env, key: string) => env[key]?.trim() || undefined
const samePlace = (a: string, b: string): boolean => { try { return fs.realpathSync(a) === fs.realpathSync(b) } catch { return false } }

/** Claude starts MCP in the conversation's folder; PWD may only supply its spelling. */
export const claudePreBinding: HostAdapter['preBinding'] = {
  startup({ env, processDir }) {
    const pwd = value(env, 'PWD')
    return { fallbackDir: value(env, 'ROOM_DIR') ?? (pwd && samePlace(pwd, processDir) ? pwd : processDir),
      deferWorkspace: false, presenceKind: 'interactive' }
  },
  decodeCall: () => ({ workspaceCandidates: [] }),
}
