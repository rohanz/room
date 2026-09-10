import { Codex, type ThreadItem, type ThreadOptions } from '@openai/codex-sdk'

export type AgentItem = ThreadItem
export interface TurnResult { finalResponse: string }

export interface AgentBackend {
  /** Run one turn. `onItem` fires for every completed item; `onStatus` for coarse progress. */
  run(input: string, onItem: (item: AgentItem) => void, onStatus?: (status: string) => void, signal?: AbortSignal): Promise<TurnResult>
}

export interface CodexBackendOptions {
  workingDirectory: string
  model?: string
  mcp: { command: string; args: string[]; env: Record<string, string> }
}

export class CodexBackend implements AgentBackend {
  private codex: Codex
  private thread
  constructor(opts: CodexBackendOptions) {
    this.codex = new Codex({ config: { mcp_servers: { room: { command: opts.mcp.command, args: opts.mcp.args, env: opts.mcp.env, default_tools_approval_mode: 'auto' } } } })
    const t: ThreadOptions = { workingDirectory: opts.workingDirectory, sandboxMode: 'workspace-write', approvalPolicy: 'never', skipGitRepoCheck: true, networkAccessEnabled: true }
    if (opts.model) t.model = opts.model
    this.thread = this.codex.startThread(t)
  }
  get threadId(): string | null { return this.thread.id }

  async run(input: string, onItem: (item: AgentItem) => void, onStatus?: (s: string) => void, signal?: AbortSignal): Promise<TurnResult> {
    const { events } = await this.thread.runStreamed(input, signal ? { signal } : undefined)
    let finalResponse = ''
    for await (const ev of events) {
      switch (ev.type) {
        case 'turn.started': onStatus?.('thinking'); break
        case 'item.started':
          if (ev.item.type === 'command_execution') onStatus?.(`running: ${ev.item.command}`)
          else if (ev.item.type === 'mcp_tool_call') onStatus?.(`calling ${ev.item.tool}`)
          break
        case 'item.completed':
          if (ev.item.type === 'agent_message') finalResponse = ev.item.text
          onItem(ev.item)
          onStatus?.('thinking')
          break
        case 'turn.failed': throw new Error(ev.error.message)
        case 'error': throw new Error(ev.message)
        default: break
      }
    }
    return { finalResponse }
  }
}

/** Scripted backend for tests: records inputs, replays items. */
export class FakeBackend implements AgentBackend {
  inputs: string[] = []
  /** Items to emit on the next run(s); each run shifts one batch. */
  scripts: AgentItem[][] = []
  /** Resolve to let a turn finish (when `hold` is true). */
  private release: (() => void) | null = null
  hold = false
  async run(input: string, onItem: (item: AgentItem) => void, onStatus?: (s: string) => void, signal?: AbortSignal): Promise<TurnResult> {
    this.inputs.push(input)
    onStatus?.('thinking')
    if (this.hold) await new Promise<void>((r, rej) => { this.release = r; signal?.addEventListener('abort', () => rej(new Error('aborted'))) })
    const items = this.scripts.shift() ?? []
    let finalResponse = ''
    for (const it of items) { if (it.type === 'agent_message') finalResponse = it.text; onItem(it) }
    return { finalResponse }
  }
  /** Finish a held turn. */
  finish(): void { const r = this.release; this.release = null; r?.() }
}
