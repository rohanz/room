/** One daemon connection: check for an active thread, then append tool output to its turn. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

export type CodexToolOutputResult = { kind: 'joined'; turnId: string } | { kind: 'idle' }
  | { kind: 'unavailable' | 'uncertain'; reason: string }
export type CodexThreadStatus = { kind: 'active'; waiting: string[] } | { kind: 'idle' }
  | { kind: 'unknown'; reason: 'notLoaded' | 'systemError' | 'unknown-status' }
  | { kind: 'unavailable'; reason: string; legacy?: boolean }

export function codexControlSocket(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = path.join(env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'app-server-control', 'app-server-control.sock')
  return fs.existsSync(file) ? file : undefined
}

export interface CodexToolOutputOptions {
  socketPath: string | undefined
  threadId: string
  text: string
  clientVersion?: string
  timeoutMs?: number
  WebSocket?: typeof WebSocket
}

/** No retries and no receipts. Failure leaves the idle queue fallback available. */
export function postCodexToolOutput(o: CodexToolOutputOptions): Promise<CodexToolOutputResult> {
  return exchange(o, true)
}

/** Read status without loading, resuming or subscribing to the thread. Fresh connection per probe. */
export function readCodexThreadStatus(o: Omit<CodexToolOutputOptions, 'text'>): Promise<CodexThreadStatus> {
  return exchange(o, false)
}

function exchange(o: CodexToolOutputOptions, post: true): Promise<CodexToolOutputResult>
function exchange(o: Omit<CodexToolOutputOptions, 'text'>, post: false): Promise<CodexThreadStatus>
function exchange(o: Omit<CodexToolOutputOptions, 'text'> & { text?: string }, post: boolean): Promise<CodexToolOutputResult | CodexThreadStatus> {
  return new Promise(resolve => {
    let socket: WebSocket | undefined
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let id = 0
    let submitted = false
    const finish = (result: CodexToolOutputResult | CodexThreadStatus) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.terminate()
      resolve(result)
    }
    const fail = (error: unknown, rejected = false) => finish({ kind: submitted && !rejected ? 'uncertain' : 'unavailable', reason: error instanceof Error ? error.message : String(error) })
    try {
      if (!o.socketPath) { finish({ kind: 'unavailable', reason: 'Codex control socket missing', ...(!post && { legacy: true }) }); return }
      socket = new (o.WebSocket ?? WebSocket)(`ws+unix://${o.socketPath}:/`)
      timer = setTimeout(() => fail('Codex app-server timed out'), o.timeoutMs ?? 3_000)
      const send = (method: string, params: unknown) => {
        // Once submission is attempted, a timeout/close cannot prove it was not received.
        if (method === 'turn/start') submitted = true
        socket!.send(JSON.stringify({ id: ++id, method, params }))
      }
      socket.on('error', error => fail(error))
      socket.on('close', () => { if (!settled) fail('Codex app-server closed before response') })
      socket.on('open', () => {
        try { send('initialize', { clientInfo: { name: 'room', version: o.clientVersion ?? '0.0.0' } }) } catch (e) { fail(e) }
      })
      socket.on('message', data => {
        if (settled) return
        try {
          const response = JSON.parse(String(data))
          if (response.id !== id) return // notifications are not responses
          if (response.error) {
            if (!post && response.error.code === -32601) finish({ kind: 'unavailable', reason: 'thread/read unsupported', legacy: true })
            else if (!post && response.error.code === -32600 && (response.error.message === 'thread not found'
              || response.error.message === `thread not found: ${o.threadId}`)) finish({ kind: 'unknown', reason: 'notLoaded' })
            else fail(response.error.message ?? 'Codex app-server request failed', true)
            return
          }
          if (id === 1) {
            socket!.send(JSON.stringify({ method: 'initialized', params: {} }))
            send('thread/read', { threadId: o.threadId, includeTurns: false })
          } else if (id === 2) {
            const runtime = response.result?.thread?.status
            const status = runtime?.type
            if (status === 'idle') { finish({ kind: 'idle' }); return }
            if (!post) {
              if (status === 'active') finish({ kind: 'active', waiting: Array.isArray(runtime.activeFlags)
                ? runtime.activeFlags.filter((f: unknown) => f === 'waitingOnApproval' || f === 'waitingOnUserInput') : [] })
              else finish({ kind: 'unknown', reason: status === 'notLoaded' || status === 'systemError' ? status : 'unknown-status' })
              return
            }
            if (status === 'notLoaded' || status === 'systemError') { fail(`Codex thread is ${status}`); return }
            if (status !== 'active') { fail('Codex app-server returned an unknown thread status'); return }
            send('turn/start', { threadId: o.threadId, input: [], toolOutput: { name: 'room_notify', namespace: 'room', output: o.text } })
          } else {
            const turn = response.result?.turn
            if (typeof turn?.id !== 'string' || turn.status !== 'inProgress') { fail('Codex app-server returned an invalid turn'); return }
            finish({ kind: 'joined', turnId: turn.id })
          }
        } catch (e) { fail(e) }
      })
    } catch (e) { fail(e) }
  })
}
