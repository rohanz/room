import type * as Y from 'yjs'
import { formatMsg, type ChatItem, type Claim, type Identity, type Msg, type ReleaseMsg, RoomDoc } from '@room/shared'
import type { AgentBackend, AgentItem } from './backend.js'
import { claimToMsg, shouldWakeOnClaim, shouldWakeOnMsg } from './wake.js'
import { preamble } from './prompt.js'

export interface AwarenessLike { setLocalStateField(field: string, value: unknown): void }

export interface RunnerOptions {
  name: string
  room: RoomDoc
  awareness: AwarenessLike
  backend: AgentBackend
  preamble?: string
  log?: (line: string) => void
}

type Queued = { kind: 'human'; text: string } | { kind: 'event'; msg: Msg; line: string }

const OUTPUT_TAIL = 400

export class Runner {
  readonly me: Identity
  private queue: Queued[] = []
  private running = false
  private firstTurn = true
  private seenClaimIds = new Set<string>()
  private idleWaiters: (() => void)[] = []
  private unobserve: (() => void)[] = []
  private stopped = false
  private paused = false

  constructor(private opts: RunnerOptions) {
    this.me = { name: opts.name, kind: 'agent' }
  }

  private get room() { return this.opts.room }
  private log(s: string) { this.opts.log?.(s) }

  start(): void {
    const { room } = this.opts
    this.setStatus('idle')

    // (a) human chat: only items appended after start, only role 'human'
    const chat = room.chat(this.me.name)
    const onChat = (ev: Y.YArrayEvent<ChatItem>) => {
      for (const d of ev.changes.delta) {
        for (const it of d.insert ?? []) {
          if (it.role !== 'human') continue
          const command = it.text.trim()
          if (command === '/stop') { this.stopTurn(); continue }
          if (command === '/resume') { this.resume(); continue }
          if (this.paused) {
            room.say(this.me.name, { role: 'status', text: 'agent paused; send /resume' })
            continue
          }
          this.enqueue({ kind: 'human', text: it.text })
        }
      }
    }
    chat.observe(onChat); this.unobserve.push(() => chat.unobserve(onChat))

    // (b) bus messages
    const bus = room.bus
    const onBus = (ev: Y.YArrayEvent<Msg>) => {
      for (const d of ev.changes.delta) for (const m of d.insert ?? []) this.onMsg(m)
    }
    bus.observe(onBus); this.unobserve.push(() => bus.unobserve(onBus))

    // (c) claims map: new claims overlapping ours
    for (const c of room.openClaims()) this.seenClaimIds.add(c.id)
    const claims = room.claims
    const onClaims = (ev: Y.YMapEvent<Claim>) => {
      for (const [key, ch] of ev.changes.keys) {
        if (ch.action !== 'add') continue
        const c = claims.get(key); if (!c) continue
        this.onClaim(c)
      }
    }
    claims.observe(onClaims); this.unobserve.push(() => claims.unobserve(onClaims))
  }

  stop(): void {
    this.stopped = true
    for (const u of this.unobserve) u()
    this.unobserve = []
    this.setStatus('offline')
  }

  /** Resolves once the queue is empty and no turn is running. */
  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve()
    return new Promise(r => this.idleWaiters.push(r))
  }

  private onMsg(m: Msg) {
    if (m.type === 'claim') this.seenClaimIds.add(m.claimId)
    const d = shouldWakeOnMsg(this.me, m, this.room.openClaims())
    this.log(`bus ${m.type} from ${m.from}/${m.fromKind}: ${d.wake ? 'wake' : 'skip'} (${d.reason})`)
    if (d.wake) {
      const queued = { kind: 'event' as const, msg: m, line: formatMsg(m) }
      if (m.type === 'conflict') this.preemptForConflict(queued)
      else this.enqueue(queued)
    }
  }

  private onClaim(c: Claim) {
    if (this.seenClaimIds.has(c.id)) return
    this.seenClaimIds.add(c.id)
    const d = shouldWakeOnClaim(this.me, c, this.room.openClaims())
    this.log(`claim ${c.id} by ${c.by}: ${d.wake ? 'wake' : 'skip'} (${d.reason})`)
    if (d.wake) { const msg = claimToMsg(c); this.enqueue({ kind: 'event', msg, line: formatMsg(msg) }) }
  }

  private enqueue(q: Queued) {
    if (this.stopped || this.paused) return
    this.queue.push(q)
    void this.drain()
  }

  private async drain() {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length && !this.stopped) {
        const batch = this.nextBatch()
        await this.turn(batch)
      }
    } finally {
      this.running = false
      const w = this.idleWaiters; this.idleWaiters = []
      for (const r of w) r()
    }
  }

  /** Human messages run alone; consecutive events are coalesced into one input. */
  private nextBatch(): Queued[] {
    const head = this.queue.shift()!
    if (head.kind === 'human') return [head]
    const batch: Queued[] = [head]
    while (this.queue.length && this.queue[0].kind === 'event') batch.push(this.queue.shift()!)
    return batch
  }

  private abort: AbortController | null = null
  private abortReason: 'stop' | 'conflict' | null = null

  /** Interrupt, release our claims, and pause until an explicit /resume. */
  stopTurn(): void {
    this.paused = true
    this.queue.length = 0
    const mine = this.room.openClaims().filter(c => c.by === this.me.name && c.byKind === 'agent')
    for (const c of mine) {
      this.room.removeClaim(c.id, this)
      this.room.post<ReleaseMsg>(this.me, { type: 'release', claimId: c.id, path: c.path, summary: 'released by /stop' }, this)
    }
    this.room.say(this.me.name, { role: 'status', text: `stopped by you; released ${mine.length} ${mine.length === 1 ? 'claim' : 'claims'}; paused until /resume` })
    this.setStatus('paused')
    if (this.abort) {
      this.abortReason = 'stop'
      this.abort.abort()
      this.log('stop requested by human')
    }
  }

  private resume(): void {
    if (!this.paused) {
      this.room.say(this.me.name, { role: 'status', text: 'agent is already running' })
      return
    }
    this.paused = false
    this.room.say(this.me.name, { role: 'status', text: 'resumed' })
    this.setStatus('idle')
  }

  private preemptForConflict(q: Queued): void {
    if (this.stopped || this.paused) return
    this.queue.unshift(q)
    const path = q.kind === 'event' && q.msg.type === 'conflict' ? q.msg.path : 'unknown path'
    if (this.abort) {
      this.room.say(this.me.name, { role: 'status', text: `conflict on ${path}; interrupting current turn` })
      this.abortReason = 'conflict'
      this.abort.abort()
    } else this.room.say(this.me.name, { role: 'status', text: `conflict on ${path}; handling now` })
    void this.drain()
  }

  private async turn(batch: Queued[]) {
    const say = (item: Omit<ChatItem, 'id' | 'at'>) => this.room.say(this.me.name, item)
    let body: string
    if (batch[0].kind === 'human') {
      body = batch[0].text
    } else {
      for (const q of batch) if (q.kind === 'event') say({ role: 'event', text: q.line, meta: { type: q.msg.type, from: q.msg.from, msg_id: q.msg.id } })
      body = batch.flatMap(q => q.kind === 'event' ? [formatEvent(q.msg, q.line)] : []).join('\n\n')
    }
    let input = body
    if (this.firstTurn) { input = `${this.opts.preamble ?? preamble(this.me.name)}\n\n---\n\n${body}`; this.firstTurn = false }

    this.setStatus('thinking')
    this.abort = new AbortController()
    const { signal } = this.abort
    try {
      await this.opts.backend.run(input, item => {
        const c = itemToChat(item)
        if (c) say(c)
      }, s => this.setStatus(s), signal)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (signal.aborted && this.abortReason === 'conflict') { say({ role: 'status', text: 'turn interrupted by conflict' }) }
      else if (signal.aborted && this.abortReason === 'stop') { /* stopTurn already posted the status */ }
      else if (signal.aborted) { say({ role: 'status', text: 'turn aborted' }) }
      else { this.log(`turn failed: ${msg}`); say({ role: 'status', text: `turn failed: ${msg}` }) }
    } finally {
      this.abort = null
      this.abortReason = null
      this.setStatus(this.paused ? 'paused' : 'idle')
    }
  }

  private setStatus(s: string) { this.opts.awareness.setLocalStateField('status', s) }
}

export function formatEvent(m: Msg, line: string): string {
  const path = 'path' in m ? m.path : 'paths' in m ? m.paths.join(',') : ''
  const attrs = [`type="${m.type}"`, `from="${m.from}"`, `from_kind="${m.fromKind}"`, `path="${path}"`].join(' ')
  return `<room-event ${attrs}>\n${line}\n${JSON.stringify(m)}\n</room-event>\nReact per your instructions. If nothing is needed, reply briefly and do nothing.`
}

export function itemToChat(item: AgentItem): Omit<ChatItem, 'id' | 'at'> | null {
  switch (item.type) {
    case 'agent_message': return { role: 'agent', text: item.text }
    case 'command_execution': {
      const out = (item.aggregated_output ?? '').trim()
      const tail = out.length > OUTPUT_TAIL ? '…' + out.slice(-OUTPUT_TAIL) : out
      const code = item.exit_code === undefined ? '' : `\n[exit ${item.exit_code}]`
      return { role: 'tool', text: `$ ${item.command}${tail ? '\n' + tail : ''}${code}`, meta: { kind: 'command' } }
    }
    case 'file_change': return { role: 'tool', text: `edited ${item.changes.map(c => c.path).join(', ')}${item.status === 'failed' ? ' (failed)' : ''}`, meta: { kind: 'file_change' } }
    case 'mcp_tool_call': {
      const args = item.arguments === undefined ? '' : JSON.stringify(item.arguments)
      let result = item.error?.message ?? ''
      if (!result && item.result) {
        const first = item.result.content.find(b => b.type === 'text') as { text?: string } | undefined
        result = first?.text ?? (item.result.structured_content ? JSON.stringify(item.result.structured_content) : '')
      }
      const firstLine = result.split('\n')[0] ?? ''
      return { role: 'tool', text: `${item.tool}(${args}) → ${firstLine}`, meta: { kind: 'mcp', tool: item.tool } }
    }
    case 'error': return { role: 'status', text: item.message }
    case 'reasoning': case 'todo_list': case 'web_search': return null
    default: return null
  }
}
