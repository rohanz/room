export type WakeEnv = NodeJS.ProcessEnv
export type Mode = 'auto' | 'socket' | 'off'

export interface WakeTarget { id: string; host: 'claude' | 'codex' }
/** Shared senders take the conversation alone; a facet's surface is its own concern. */
export const wakeTarget = (t: WakeTarget): WakeTarget => ({ id: t.id, host: t.host })
export type WakeVia = 'queue' | 'socket' | 'turn'
/** One bounded observation, never peer content, host error text, paths or credentials. */
export interface WakeAttempt {
  via: WakeVia
  at: number
  outcome: 'attempting' | 'written' | 'queued' | 'submitted' | 'uncertain' | 'failed' | 'unavailable' | 'skipped-idle'
}
export interface WakePathStatus {
  mode: Mode
  transport: 'turn/queue' | 'legacy/queue' | 'socket' | 'none'
  availability: 'configured' | 'unknown' | 'off' | 'unavailable'
}
/** Resolves with the path that took the wake, or undefined when this host has none; rejects when the path failed. */
export type SendWake = ((target: WakeTarget, text: string) => Promise<WakeVia | undefined>) & {
  describe?: (target: WakeTarget) => WakePathStatus
  lastAttempt?: (target?: WakeTarget) => WakeAttempt | undefined
}

export interface WakeAvailability {
  host: string
  env?: WakeEnv
}

export interface WakeSenderOptions {
  env?: WakeEnv
  post?: (socketPath: string, token: string | undefined, content: string, timeoutMs?: number) => Promise<void>
  queue?: (threadId: string, text: string) => Promise<void>
}

export type SendMidTurn = ((target: WakeTarget, text: string) => Promise<WakeVia | 'uncertain-turn' | 'idle' | undefined>)
  & Pick<SendWake, 'describe' | 'lastAttempt'>

