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

export const DEFAULT_CLAUDE_CHANNEL = 'plugin:room@room'
/** Explicit empty strings disable the development channel. */
export function claudeChannel(argument: string | undefined, env: Env): string {
  return (argument ?? env.ROOM_CLAUDE_CHANNEL ?? DEFAULT_CLAUDE_CHANNEL).trim()
}
/** Advertised on both hosts today, independently of channel configuration. */
export const channelCapabilities = { 'claude/channel': {} }
