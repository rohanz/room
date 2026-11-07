import { execFile } from 'node:child_process'
import { codexControlSocket, postCodexToolOutput } from './codex-app-server.js'
import { isCodexExecWorker } from './codex-identity.js'
import { mode } from './wake-mode.js'
import type { WakeEnv, WakeAttempt, SendMidTurn } from './wake-types.js'
import { wakeTarget } from './wake-types.js'
import type { WakeFacet, WakeFacetOptions } from './wake.js'
import { CodexTurnProbe } from './codex-turn.js'
import { sendResult } from './wake-result.js'
import type { WakeSenderOptions, WakeAvailability, WakePathStatus, WakeVia } from './wake-types.js'
import type { WakeAttemptRunner } from './wake.js'

function codexQueue(threadId: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('codex', ['queue', '--thread', threadId, '--message', text], { timeout: 10_000 }, (err, _out, stderr) => err ? reject(new Error(String(stderr || err.message).trim())) : resolve())
  })
}

export function createMidTurnSender(o: { env?: WakeEnv; post?: typeof postCodexToolOutput; log?: (line: string) => void; clientVersion?: string } = {}): SendMidTurn {
  let last: WakeAttempt | undefined
  let lastTarget: string | undefined
  let lastFailure: string | undefined
  const send: SendMidTurn = async (target, text) => {
    const key = `${target.host}\0${target.id}`
    if (lastTarget !== key) last = undefined
    lastTarget = key
    const env = o.env ?? process.env
    // A `codex exec` worker's thread is not an app-server thread: no mid-turn path exists, and tool replies carry its messages.
    if (target.host !== 'codex' || mode(env) === 'off' || isCodexExecWorker(env)) return undefined
    last = { via: 'turn', at: Date.now(), outcome: 'attempting' }
    let result
    try { result = await (o.post ?? postCodexToolOutput)({ socketPath: codexControlSocket(env), threadId: target.id, text, clientVersion: o.clientVersion }) }
    catch (e) { last = { ...last, outcome: 'failed' }; throw e }
    last = { ...last, outcome: result.kind === 'joined' ? 'submitted' : result.kind === 'idle' ? 'skipped-idle' : result.kind }
    if (result.kind === 'joined') {
      lastFailure = undefined
      o.log?.(`wake: Codex mid-turn joined turn ${result.turnId} of session ${target.id}`)
      return 'turn'
    }
    if (result.kind === 'uncertain') return 'uncertain-turn'
    if (result.kind === 'idle') return 'idle'
    if (result.kind === 'unavailable') {
      const key = `${target.id}\0${result.reason}`
      if (key !== lastFailure) o.log?.(`wake: Codex mid-turn unavailable for session ${target.id}: ${result.reason}`)
      lastFailure = key
    }
    return undefined
  }
  send.lastAttempt = target => (!target || `${target.host}\0${target.id}` === lastTarget) && last ? { ...last } : undefined
  return send
}

export function createCodexWakeFacet(o: WakeFacetOptions): WakeFacet {
  const probe = o.probe ?? new CodexTurnProbe()
  return {
    reportsState: !!probe.state,
    describe: target => { const path = o.send.describe?.(wakeTarget(target)); return path && { ...path, limitation: 'Submission is not a receipt.' } },
    state: async target => {
      if (!probe.state) return { kind: await probe.busy(target.id) ? 'active' : 'idle', source: 'host' }
      const state = await probe.state(target.id)
      return state.kind === 'unknown' ? { ...state, kind: 'unknown', reason: state.reason ?? 'status-unavailable' } : { ...state, kind: state.kind }
    },
    send: async (target, pointer, phase) => sendResult(await (phase === 'active' ? o.midTurn?.(wakeTarget(target), pointer) : o.send(wakeTarget(target), pointer))),
  }
}

export function sendCodexWake(o: WakeSenderOptions, id: string, text: string, attempt: WakeAttemptRunner): Promise<WakeVia> {
  return attempt('queue', () => (o.queue ?? codexQueue)(id, text))
}
export function codexWakeStatus(o: WakeAvailability): WakePathStatus {
  return { mode: mode(o.env ?? process.env), transport: codexControlSocket(o.env) ? 'turn/queue' : 'legacy/queue', availability: 'unknown' }
}
