import { mode } from './wake-mode.js'
import { sendClaudeWake, wakePathStatus as claudeStatus } from './claude-wake.js'
import { sendCodexWake, codexWakeStatus } from './codex-wake.js'
import type { WakeSenderOptions, SendWake, WakeVia, WakeAttempt, WakeAvailability, WakePathStatus } from './wake-types.js'
import type { HostAdapter, HostId } from './types.js'
import type { SendMidTurn } from './wake-types.js'
import { CodexTurnProbe, type CodexWakeProbe, type CodexTurnProbeOptions } from './codex-turn.js'
import { createClaudeWakeFacet } from './claude-wake.js'
import { createCodexWakeFacet } from './codex-wake.js'

export function wakePathStatus(o: WakeAvailability): WakePathStatus {
  const selected = mode(o.env ?? process.env)
  if (selected !== 'off' && o.host === 'codex') return codexWakeStatus(o)
  return claudeStatus(o)
}
/** Codex: the queue. Claude: the socket, then the channel if the socket fails and the channel is admitted. ROOM_WAKE=off sends nothing. */
export function createWakeSender(o: WakeSenderOptions): SendWake {
  let last: WakeAttempt | undefined
  let lastTarget: string | undefined
  const attempt = async (via: WakeVia, run: () => Promise<unknown>): Promise<WakeVia> => {
    last = { via, at: Date.now(), outcome: 'attempting' }
    try { await run(); last = { ...last, outcome: via === 'queue' ? 'queued' : 'written' }; return via }
    catch (e) { last = { ...last, outcome: 'failed' }; throw e }
  }
  const send: SendWake = async (target, text) => {
    const key = `${target.host}\0${target.id}`
    if (lastTarget !== key) last = undefined
    lastTarget = key
    const env = o.env ?? process.env
    const selected = mode(env)
    // ROOM_WAKE=off is the user's switch for every host; the ledger still owes the message.
    if (selected === 'off') return undefined
    if (target.host === 'codex') return sendCodexWake(o, target.id, text, attempt)
    return sendClaudeWake(o, text, attempt, () => { if (last) last = { ...last, fallback: 'socket-failed' } })
  }
  send.describe = target => wakePathStatus({ ...o, host: target.host })
  send.lastAttempt = target => (!target || `${target.host}\0${target.id}` === lastTarget) && last ? { ...last } : undefined
  return send
}

/** Compatibility probe port for callers migrating in step 9. */
export function createWakeProbe(options: CodexTurnProbeOptions = {}): CodexWakeProbe { return new CodexTurnProbe(options) }

export interface WakeFacetOptions {
  send: SendWake
  midTurn?: SendMidTurn
  probe?: CodexWakeProbe
}
/** reportsState keeps legacy busy-only test/caller probes from adding health evidence. */
export type WakeFacet = NonNullable<HostAdapter['wake']> & { reportsState: boolean }
export function createWakeFacets(options: WakeFacetOptions): (host: HostId) => WakeFacet {
  const facets = { claude: createClaudeWakeFacet(options), codex: createCodexWakeFacet(options) }
  return host => facets[host]
}

export type WakeAttemptRunner = (via: WakeVia, run: () => Promise<unknown>) => Promise<WakeVia>
