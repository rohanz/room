import { formatMsg, formatPlans, messageEndsWait, messageForMe, scopeCovers, type AnswerMsg, type ChangedMsg, type Msg, type NoteMsg, type Priority, type QuestionMsg, type WorkerStatus } from '@room/shared'
import type { Session } from '../session.js'
import { syncHookSeen } from '../hooks-bridge.js'
import { isPrName } from '../prs.js'
import { RO, RW, int, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'

const WAIT_DEFAULT = 30_000
const WAIT_MAX = 120_000

export const defs: ToolDef[] = [
  { name: 'room_send', annotations: RW, description: 'Ask an agent (to), answer (inReplyTo), or post a note. Changes are detected automatically.',
    inputSchema: { type: 'object', properties: {
      type: { type: 'string', enum: ['changed', 'question', 'answer', 'note'] },
      to: str('recipient; omit to broadcast'),
      text: str('message text / change summary'),
      paths: strs('paths touched (changed)'),
      symbols: strs('changed symbols'),
      inReplyTo: str('question id (answer)'),
      priority: { type: 'string', enum: ['fyi', 'notify', 'interrupt'], description: 'urgency override' },
    }, required: ['type', 'text'] } },
  { name: 'room_wait', annotations: RO, description: 'Wait for an answer, claim release, worker completion or interrupt; returns the event or timeout.',
    inputSchema: { type: 'object', properties: { claimId: str('claim id'), questionId: str('question id'), timeoutMs: int('default 30000, max 120000') } } }
]

export function handlers(state: HandlerState): Record<string, Handler> {
  const { S, rooms, myWorkers, workerAlive, presences, now, upgrade, setPresence, forMe, seen } = state
  const offline = (s: Session) => !!s.closed || !s.provider.synced || (s.provider as { wsconnected?: boolean }).wsconnected === false
  const unavailableQuestions = new Map<string, string>()
  const knownNames = (s: Session): Set<string> => new Set([
    s.me.name, ...presences(s).map(p => p.user.name), ...s.room.colors.keys(), ...s.room.scopes.keys(), ...s.room.overlays.keys(), ...s.room.deleted.keys(),
    ...s.room.openClaims().map(c => c.by), ...Array.from(s.room.workers.values(), w => w.name),
    ...s.room.retiredWorkers().map(w => w.name), ...s.room.messages().map(m => m.from),
  ].filter(n => !isPrName(n)))
  const recipientNotice = (s: Session, name: string): { text: string; terminal: boolean } | undefined => {
    const present = presences(s).some(p => p.user.name === name)
    const worker = s.room.workerOf(name)
    // A live generation supersedes any archive under the same participant name.
    const retired = !worker && s.room.retiredWorkers().filter(w => w.name === name).sort((a, b) => b.retiredAt - a.retiredAt)[0]
    const exited = worker && (worker.exitCode !== undefined || (s.local ? !workerAlive(s, worker) : worker.status !== 'running' && !present))
    // Headless workers never read another message after reporting a terminal status.
    const terminalStatuses = { running: false, done: true, failed: true, dismissed: true } satisfies Record<WorkerStatus, boolean>
    const terminal = worker && terminalStatuses[worker.status]
    if (retired || exited || terminal) {
      const record = retired || worker!
      const finished = record.finishedAt
      const ago = finished === undefined ? '' : ` ${Math.max(0, Math.floor((now() - finished) / 60_000))}m ago`
      const summary = record.summary?.replace(/\s+/g, ' ').trim() || 'no summary recorded'
      const verb = retired || exited ? 'finished' : `reported ${worker!.status}`
      return { text: `${name} ${verb}${ago} and will not answer; its summary: ${summary}`, terminal: true }
    }
    if (presences(s).some(p => p.user.name === name && p.wakeUnavailable === true)) return { text: `${name} cannot be woken in this session; it will see this at its next turn`, terminal: false }
    if (present || worker) return undefined
    const known = knownNames(s)
    if (known.has(name)) return { text: `${name} is offline; it will see this when it returns`, terminal: false }
    if (offline(s)) return undefined // A disconnected room cannot establish that a name is unknown.
    return { text: `nobody called ${name} is or was in this room; participants: ${[...known].sort().join(', ')}`, terminal: true }
  }
  const unavailableQuestion = (s: Session, questionId: string): string | undefined => {
    const cached = unavailableQuestions.get(questionId)
    if (cached) return cached
    const question = s.room.messages().find(m => m.id === questionId && m.type === 'question')
    if (!question?.to) return undefined
    const notice = recipientNotice(s, question.to)
    if (!notice?.terminal) return undefined
    unavailableQuestions.set(questionId, notice.text)
    if (unavailableQuestions.size > 256) unavailableQuestions.delete(unavailableQuestions.keys().next().value!)
    return notice.text
  }
  const handlers: Record<string, Handler> = {
    async room_send(a) {
      const lead = S()
      const requestedTo = typeof a.to === 'string' && a.to ? a.to : undefined
      // A reply to a worker's question, or a message to a worker, belongs in the workers room.
      const wsr = rooms.workers()
      const byQuestion = typeof a.inReplyTo === 'string' && a.inReplyTo ? rooms.holdingQuestion(a.inReplyTo, lead) : undefined
      const workerMatches = requestedTo ? rooms.all().flatMap(room => myWorkers(room)
        .filter(w => w.tag === requestedTo).map(worker => ({ room, worker }))) : []
      if (workerMatches.length > 1) {
        const names = [...new Set(workerMatches.map(x => x.worker.name))].sort()
        return `error: worker tag ${requestedTo} is ambiguous; use a full name: ${names.join(', ')}`
      }
      const resolvedWorker = workerMatches[0]
      const to = resolvedWorker?.worker.name ?? requestedTo
      const exactWorkerRoom = to && wsr && wsr !== lead && (myWorkers(wsr).some(w => w.name === to) || wsr.room.retiredWorkers().some(w => w.name === to)) ? wsr : undefined
      const s = byQuestion ?? resolvedWorker?.room ?? exactWorkerRoom ?? lead
      const text = typeof a.text === 'string' ? a.text : ''
      if (!text) return 'error: text is required'
      if (to === s.me.name) return `error: you cannot message yourself. To ask ${s.me.name} (your human), say it in your reply.`
      if (to && !rooms.all().some(room => knownNames(room).has(to))) {
        const valid = [...new Set(rooms.all().flatMap(room => [...knownNames(room)]))].sort()
        return `error: nobody called ${to} is or was in this room; participants: ${valid.join(', ')}`
      }
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
      const notice = msg.to ? recipientNotice(s, msg.to) : undefined
      if (notice) notes.push(msg.type === 'question' && notice.terminal ? unavailableQuestion(s, msg.id)! : notice.text)
      if (msg.type === 'question' && !notice?.terminal) notes.push(`room_wait questionId=${msg.id} to block for the answer`)
      s.daemon.touch()
      return [`sent [${msg.id}] ${formatMsg(msg)}${(s !== lead) ? ' (in the workers room)' : ''}`, ...notes, ...(offline(s) ? ['offline: queued/not delivered'] : [])].join('\n')
    },
    async room_wait(a) {
      const s = S()
      const claimId = typeof a.claimId === 'string' && a.claimId ? a.claimId : undefined
      const questionId = typeof a.questionId === 'string' && a.questionId ? a.questionId : undefined
      const timeoutMs = Math.min(WAIT_MAX, Math.max(0, Number(a.timeoutMs ?? WAIT_DEFAULT) || WAIT_DEFAULT))
      if (claimId && !s.room.claims.has(claimId)) return `claim ${claimId} is already released`
      const qRoom = (questionId && rooms.holdingQuestion(questionId, s)) || s
      const answered = (id: string) => qRoom.room.messages().find(m => messageEndsWait(m, { questionId: id, me: qRoom.me.name, answersOnly: true }))
      const received = (x: Session, m: Msg) => { seen.add(m.id); x.room.markSeen(x.me.name, [m.id]); state.scheduleInboxWrite() }
      if (questionId) { const an = answered(questionId); if (an) { received(qRoom, an); return `answered: ${formatMsg(an)}` } }
      if (questionId) { const notice = unavailableQuestion(qRoom, questionId); if (notice) return notice }
      const waitResult = (x: Session, m: Msg, workersRoom = false): string | undefined => {
        if (messageEndsWait(m, { claimId, questionId, me: x.me.name, workersRoom })) {
          received(x, m)
          if (m.type === 'answer') return `answered: ${formatMsg(m)}`
          if (m.type === 'done') return `worker done: ${formatMsg(m)}`
          if (m.type === 'merge-conflict') return formatMsg(m)
          if (m.type === 'question') return `${workersRoom ? 'question from a worker' : `question for you (answer it with room_send type=answer inReplyTo=${m.id}, then wait again)`}: ${formatMsg(m)}`
          return `${workersRoom ? 'workers room' : 'message for you'}: ${formatMsg(m)}`
        }
        if (m.priority === 'interrupt' && forMe(x, m)) { received(x, m); return `${workersRoom ? 'workers room: ' : ''}${formatMsg(m)}` }
      }
      for (const x of [s, ...rooms.all().filter(x => x !== s)]) {
        const workersRoom = x !== s
        for (const m of x.room.messages()) {
          if (seen.has(m.id) || x.room.seen(x.me.name).has(m.id)) continue
          const ended = waitResult(x, m, workersRoom)
          if (ended) return ended
        }
      }
      if (offline(s)) return 'offline: queued/not delivered; room_wait cannot observe new messages until reconnected'
      setPresence(s, { status: claimId ? `waiting for ${claimId}` : questionId ? `waiting for answer to ${questionId}` : 'waiting' })
      const result = await new Promise<string>(resolve => {
        const ws = rooms.all().find(x => x !== s) ?? null
        const finish = (r: string) => { clearTimeout(timer); s.room.claims.unobserve(onClaims); s.room.bus.unobserve(onBus); ws?.room.bus.unobserve(onWorkersBus); qRoom.room.doc.off('update', onRecipient); resolve(r) }
        const onRecipient = () => {
          if (!questionId) return
          const notice = unavailableQuestion(qRoom, questionId)
          if (notice) finish(notice)
        }
        const onWorkersBus = (ev: { changes: { delta: { insert?: unknown }[] } }) => {
          if (!ws) return
          for (const d of ev.changes.delta) for (const m of (d.insert ?? []) as Msg[]) {
            const ended = waitResult(ws, m, true)
            if (ended) return finish(ended)
          }
        }
        const timer = setTimeout(() => {
          const running = [...new Map(rooms.all().flatMap(room => myWorkers(room)).filter(w => w.status === 'running' && w.exitCode === undefined).map(w => [w.name, w])).values()]
          finish(running.length
            ? `nothing yet; ${running.length} worker${running.length === 1 ? '' : 's'} still running (${running.map(w => w.tag).join(', ')}); nothing needs you`
            : `timeout after ${timeoutMs}ms: ${claimId ? `${claimId} still held` : questionId ? `no answer to ${questionId}` : 'nothing happened'}. Continue independent work or wait again.`)
        }, timeoutMs)
        const onClaims = () => { if (claimId && !s.room.claims.has(claimId)) finish(`released: ${claimId}`) }
        const onBus = (ev: { changes: { delta: { insert?: unknown }[] } }) => {
          for (const d of ev.changes.delta) for (const m of (d.insert ?? []) as Msg[]) {
            const ended = waitResult(s, m)
            if (ended) return finish(ended)
          }
        }
        s.room.claims.observe(onClaims); s.room.bus.observe(onBus); ws?.room.bus.observe(onWorkersBus)
        if (questionId) { qRoom.room.doc.on('update', onRecipient); onRecipient() }
      })
      setPresence(s, { status: 'idle' })
      return result
    }
  }
  return handlers
}


export function install(state: HandlerState): void {
  const { seen, rooms, log, scheduleInboxWrite, mine, msgInMyAreas, others, upgraded } = state
  const forMe = (s: Session, m: Msg) => messageForMe(s.me, m, { claims: mine(s), inMyAreas: x => msgInMyAreas(s, x) })
  const inbox = (s: Session): string => {
      const fresh: Msg[] = []
      const ws = rooms.workers()
      const sources = [s, ...(ws && ws !== s ? [ws] : [])]
      for (const source of sources) {
        syncHookSeen(source)
        const delivered: string[] = []
        for (const m of source.room.messages()) {
          if (seen.has(m.id) || source.room.seen(source.me.name).has(m.id)) continue
          seen.add(m.id)
          if (!forMe(source, m)) continue
          delivered.push(m.id)
          fresh.push(source === s ? m : { ...m, ...('text' in m ? { text: `[workers room] ${m.text}` } : {}) } as Msg)
        }
        source.room.markSeen(source.me.name, delivered)
      }
      if (seen.size > 5000) { const keep = s.room.lastMessages(2000).map(m => m.id); seen.clear(); for (const k of keep) seen.add(k) }
      if (!fresh.length) return ''
      const rank: Record<Priority, number> = { interrupt: 0, notify: 1, fyi: 2 }
      fresh.sort((a, b) => rank[a.priority] - rank[b.priority] || a.at - b.at)
      for (const m of fresh) log(`inbox → ${s.me.name}: ${formatMsg(m)}`)
      scheduleInboxWrite()
      return `[inbox ${fresh.length}]\n${fresh.map(m => `  [${m.id}] ${formatMsg(m)}`).join('\n')}\n\n`
    }
  const affected = async (s: Session, paths: string[], symbols: string[]): Promise<Map<string, string>> => {
      const out = new Map<string, string>()
      for (const person of others(s)) {
        const sc = s.room.scope(person)
        const hitPath = sc && paths.find(p => scopeCovers(sc, p))
        if (hitPath) { out.set(person, `scope ${sc.area} covers ${hitPath}`); continue }
        if (!symbols.length) continue
        // Files that use the symbol (graph), owned by this person: in their scope, changed by them, or claimed by them.
        let hit: string | undefined
        if (s.graph) {
          await s.graph.ready
          for (const sym of symbols) {
            const f = s.graph.graph.usersOf(sym).find(u => ownsFile(s, person, u))
            if (f) { hit = `${f} uses ${sym}`; break }
          }
        } else {
          for (const f of s.room.changedPaths(person)) {
            const t = s.room.text(f, person) ?? ''
            const sym = symbols.find(x => t.includes(x))
            if (sym) { hit = `${f} uses ${sym}`; break }
          }
        }
        if (hit) out.set(person, hit)
      }
      return out
    }
  const ownsFile = (s: Session, person: string, f: string): boolean => {
      const sc = s.room.scope(person)
      return (!!sc && scopeCovers(sc, f)) || s.room.changedPaths(person).includes(f) || s.room.openClaims().some(c => c.by === person && c.path === f)
    }
  const owners = (s: Session, f: string): string[] => {
      const out = new Set<string>()
      for (const sc of s.room.allScopes()) if (!isPrName(sc.by) && scopeCovers(sc, f)) out.add(sc.by)
      for (const c of s.room.claimsFor(f)) out.add(c.by)
      for (const p of s.room.whoChanged(f)) out.add(p)
      return Array.from(out).sort()
    }
  const describeUsers = (s: Session, files: string[]): string => files.map(f => {
      const o = owners(s, f).filter(x => x !== s.me.name)
      const prs = s.room.allScopes().filter(sc => isPrName(sc.by) && scopeCovers(sc, f)).map(sc => `PR #${sc.by.slice(3)}`)
      if (prs.length) return `${f} (${o.length ? `${o.join(', ')}, ` : 'base, '}also touched by ${prs.join(', ')})`
      return o.length ? `${f} (${o.join(', ')})` : f
    }).join(', ')
  const waitingOn = async (s: Session): Promise<string[]> => {
      if (!s.graph) return []
      await s.graph.ready
      const g = s.graph.graph
      const sc = s.room.scope(s.me.name)
      const myFiles = new Set(s.room.changedPaths(s.me.name))
      if (sc) for (const f of allIndexed(s)) if (scopeCovers(sc, f)) myFiles.add(f)
      const needed = new Map<string, string[]>()
      for (const f of myFiles) for (const d of g.dependenciesOf(f)) { const arr = needed.get(d.symbol) ?? []; arr.push(f); needed.set(d.symbol, arr) }
      const out: string[] = []
      for (const c of s.room.openClaims()) {
        if (c.by === s.me.name || !c.plans?.length) continue
        for (const pl of c.plans) {
          const files = needed.get(pl.symbol)
          if (files) out.push(`  - ${c.by}'s agent plans ${pl.kind} ${pl.symbol}${pl.detail ? ` → ${pl.detail}` : ''} in ${c.path} (claim ${c.id}); you use it in ${Array.from(new Set(files)).join(', ')}`)
        }
      }
      return out
    }
  const allIndexed = (s: Session): string[] => {
      const set = new Set<string>()
      for (const sc of s.room.allScopes()) for (const p of sc.paths) set.add(p)
      // The graph does not expose its file list; approximate via scope paths + changed paths + graph users/definers reached through them.
      for (const person of [s.me.name, ...others(s)]) for (const p of s.room.changedPaths(person)) set.add(p)
      return Array.from(set).filter(p => s.graph!.graph.has(p))
    }
  const upgrade = async (s: Session, m: Msg, paths: string[], symbols: string[]): Promise<string[]> => {
      const notes: string[] = []
      for (const [person, why] of await affected(s, paths, symbols)) {
        if (m.to === person) continue
        const key = `${m.id}:${person}`
        if (upgraded.has(key)) continue
        upgraded.add(key)
        const { id: _id, at: _at, from: _f, fromKind: _k, ...body } = m as Msg & Record<string, unknown>
        s.room.post(s.me, { ...(body as object), to: person, priority: 'notify', copyOf: m.id } as never)
        notes.push(`notified ${person}'s agent (${why})`)
      }
      return notes
    }
  Object.assign(state, { forMe, inbox, describeUsers, waitingOn, upgrade })
}
