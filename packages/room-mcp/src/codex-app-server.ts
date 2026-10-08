/** One daemon connection: check for an active thread, then append tool output to its turn. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

export type CodexToolOutputResult = { kind: 'joined'; turnId: string } | { kind: 'idle' } | { kind: 'unavailable'; reason: string }

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
  return new Promise(resolve => {
    let socket: WebSocket | undefined
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let id = 0
    const finish = (result: CodexToolOutputResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.terminate()
      resolve(result)
    }
    const fail = (error: unknown) => finish({ kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) })
    try {
      if (!o.socketPath) { fail('Codex control socket missing'); return }
      socket = new (o.WebSocket ?? WebSocket)(`ws+unix://${o.socketPath}:/`)
      timer = setTimeout(() => fail('Codex app-server timed out'), o.timeoutMs ?? 3_000)
      const send = (method: string, params: unknown) => socket!.send(JSON.stringify({ id: ++id, method, params }))
      socket.on('error', fail)
      socket.on('close', () => { if (!settled) fail('Codex app-server closed before response') })
      socket.on('open', () => {
        try { send('initialize', { clientInfo: { name: 'room', version: o.clientVersion ?? '0.0.0' } }) } catch (e) { fail(e) }
      })
      socket.on('message', data => {
        if (settled) return
        try {
          const response = JSON.parse(String(data))
          if (response.id !== id) return // notifications are not responses
          if (response.error) { fail(response.error.message ?? 'Codex app-server request failed'); return }
          if (id === 1) {
            socket!.send(JSON.stringify({ method: 'initialized', params: {} }))
            send('thread/read', { threadId: o.threadId, includeTurns: false })
          } else if (id === 2) {
            const status = response.result?.thread?.status?.type
            if (status === 'idle' || status === 'notLoaded' || status === 'systemError') { finish({ kind: 'idle' }); return }
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
