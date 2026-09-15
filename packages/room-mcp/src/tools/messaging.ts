import { formatMsg, type AnswerMsg, type ChangedMsg, type Msg, type NoteMsg, type Priority, type QuestionMsg } from '@room/shared'
import { RO, RW, int, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'

const WAIT_DEFAULT = 30_000
const WAIT_MAX = 120_000

export const defs: ToolDef[] = [
  { name: 'room_send', annotations: RW, description: 'Post to the bus. changed: paths + summary (+ symbols renamed/changed, which notifies whoever uses them). question: to a person\'s agent. answer: inReplyTo a question id. note: broadcast fyi.',
    inputSchema: { type: 'object', properties: {
      type: { type: 'string', enum: ['changed', 'question', 'answer', 'note'] },
      to: str('recipient person name (their agent); empty = broadcast'),
      text: str('message text / change summary'),
      paths: strs('paths touched (changed)'),
      symbols: strs('symbols renamed or whose signature changed (changed)'),
      inReplyTo: str('question id (answer)'),
      priority: { type: 'string', enum: ['fyi', 'notify', 'interrupt'], description: 'override; defaults are usually right' },
    }, required: ['type', 'text'] } },
  { name: 'room_wait', annotations: RO, description: 'Block until a claim is released, a question is answered, or an interrupt arrives for you; or until timeout (default 30s, max 120s). Returns what happened. Then call room_state.',
    inputSchema: { type: 'object', properties: { claimId: str('wait for this claim to be released'), questionId: str('wait for an answer to this question'), timeoutMs: int('default 30000, max 120000') } } }
]

export function handlers(state: HandlerState): Record<string, Handler> {
  const { S, rooms, myWorkers, upgrade, setPresence, forMe } = state
  const handlers: Record<string, Handler> = {
    async room_send(a) {
      const lead = S()
      const to = typeof a.to === 'string' && a.to ? a.to : undefined
      // A reply to a worker's question, or a message to a worker, belongs in the workers room.
      const wsr = rooms.workers()
      const byQuestion = typeof a.inReplyTo === 'string' && a.inReplyTo ? rooms.holdingQuestion(a.inReplyTo, lead) : undefined
      const s = byQuestion ?? (wsr && wsr !== lead && to && myWorkers(wsr).some(w => w.name === to) ? wsr : lead)
      const text = typeof a.text === 'string' ? a.text : ''
      if (!text) return 'error: text is required'
      if (to === s.me.name) return `error: you cannot message yourself. To ask ${s.me.name} (your human), say it in your reply.`
      const pr = typeof a.priority === 'string' && ['fyi', 'notify', 'interrupt'].includes(a.priority) ? a.priority as Priority : undefined
      const withPr = <T extends object>(o: T) => (pr ? { ...o, priority: pr } : o)
      let msg: Msg
      const notes: string[] = []
      switch (a.type) {
        case 'changed': {
          const paths = Array.isArray(a.paths) ? a.paths.filter((x): x is string => typeof x === 'string') : []
          const symbols = Array.isArray(a.symbols) ? a.symbols.filter((x): x is string => typeof x === 'string') : []
          if (!paths.length) return 'error: changed requires paths'
          msg = s.room.post<ChangedMsg>(s.me, withPr({ type: 'changed', paths, summary: text, ...(symbols.length ? { symbols } : {}), ...(to ? { to } : {}) }))
          notes.push(...await upgrade(s, msg, paths, symbols))
          break
        }
        case 'question':
          if (!to) return 'error: question requires to (whose agent)'
          msg = s.room.post<QuestionMsg>(s.me, withPr({ type: 'question', text, to }))
          notes.push(`room_wait questionId=${msg.id} to block for the answer`)
          break
        case 'answer': {
          if (typeof a.inReplyTo !== 'string' || !a.inReplyTo) return 'error: answer requires inReplyTo'
          const orig = s.room.messages().find(m => m.id === a.inReplyTo)
          const dest = to ?? orig?.from
          if (!dest) return 'error: answer requires to (could not infer from inReplyTo)'
          msg = s.room.post<AnswerMsg>(s.me, withPr({ type: 'answer', to: dest, inReplyTo: a.inReplyTo, text }))
          break
        }
        case 'note':
          msg = s.room.post<NoteMsg>(s.me, withPr({ type: 'note', text, ...(to ? { to } : {}) }))
          break
        default: return `error: type must be changed|question|answer|note (got ${String(a.type)})`
      }
      s.daemon.touch()
      return [`sent [${msg.id}] ${formatMsg(msg)}${(s !== lead) ? ' (in the workers room)' : ''}`, ...notes].join('\n')
    },
    async room_wait(a) {
      const s = S()
      const claimId = typeof a.claimId === 'string' && a.claimId ? a.claimId : undefined
      const questionId = typeof a.questionId === 'string' && a.questionId ? a.questionId : undefined
      const timeoutMs = Math.min(WAIT_MAX, Math.max(0, Number(a.timeoutMs ?? WAIT_DEFAULT) || WAIT_DEFAULT))
      if (claimId && !s.room.claims.has(claimId)) return `claim ${claimId} is already released`
      const qRoom = (questionId && rooms.holdingQuestion(questionId, s)) || s
      const answered = (id: string) => qRoom.room.messages().find(m => m.type === 'answer' && m.inReplyTo === id)
      if (questionId) { const an = answered(questionId); if (an) return `answered: ${formatMsg(an)}` }
      setPresence(s, { status: claimId ? `waiting for ${claimId}` : questionId ? `waiting for answer to ${questionId}` : 'waiting' })
      const result = await new Promise<string>(resolve => {
        const ws = rooms.all().find(x => x !== s) ?? null
        const finish = (r: string) => { clearTimeout(timer); s.room.claims.unobserve(onClaims); s.room.bus.unobserve(onBus); ws?.room.bus.unobserve(onWorkersBus); resolve(r) }
        const onWorkersBus = (ev: { changes: { delta: { insert?: unknown }[] } }) => {
          if (!ws) return
          for (const d of ev.changes.delta) for (const m of (d.insert ?? []) as Msg[]) {
            if (questionId && m.type === 'answer' && m.inReplyTo === questionId) return finish(`answered: ${formatMsg(m)}`)
            if (m.type === 'done' && m.to === ws.me.name) return finish(`worker done: ${formatMsg(m)}`)
            if (m.priority === 'interrupt' && forMe(ws, m)) return finish(`interrupt (workers room): ${formatMsg(m)}`)
            if (m.type === 'question' && m.to === ws.me.name) return finish(`question from a worker: ${formatMsg(m)}`)
          }
        }
        const timer = setTimeout(() => finish(`timeout after ${timeoutMs}ms: ${claimId ? `${claimId} still held` : questionId ? `no answer to ${questionId}` : 'nothing happened'}. Tell your human; proceed only where you do not depend on it.`), timeoutMs)
        const onClaims = () => { if (claimId && !s.room.claims.has(claimId)) finish(`released: ${claimId}`) }
        const onBus = (ev: { changes: { delta: { insert?: unknown }[] } }) => {
          for (const d of ev.changes.delta) for (const m of (d.insert ?? []) as Msg[]) {
            if (questionId && m.type === 'answer' && m.inReplyTo === questionId) return finish(`answered: ${formatMsg(m)}`)
            if (m.priority === 'interrupt' && forMe(s, m)) return finish(`interrupt: ${formatMsg(m)}`)
            if (m.type === 'done' && m.to === s.me.name) return finish(`worker done: ${formatMsg(m)}`)
            if (m.type === 'question' && m.to === s.me.name && !(questionId || claimId)) return finish(`question for you (answer it with room_send type=answer inReplyTo=${m.id}, then wait again): ${formatMsg(m)}`)
          }
        }
        s.room.claims.observe(onClaims); s.room.bus.observe(onBus); ws?.room.bus.observe(onWorkersBus)
      })
      setPresence(s, { status: 'idle' })
      return `${result}\ncall room_state before continuing.`
    }
  }
  return handlers
}
