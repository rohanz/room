import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createTwoFilesPatch } from 'diff'
import type { Awareness } from 'y-protocols/awareness'
import {
  RoomDoc, formatMsg, withLineNumbers, claimsOverlap, clampRange, describeClaim, displayName, rangesOverlap,
} from '@room/shared'
import type { Claim, Identity, Presence, Msg, ChangedMsg, QuestionMsg, AnswerMsg, ClaimMsg, ReleaseMsg, ConflictMsg } from '@room/shared'

const exec = promisify(execFile)

export interface ToolDef {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  /** MCP tool annotations; Codex uses these to decide whether a call needs approval. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
}

/** Every room tool only touches the shared room doc (never the user's files or the network), so none is destructive. */
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }

export interface ToolCtx {
  room: RoomDoc
  me: Identity
  dir: string
  awareness?: Awareness
  /** injectable for tests */
  sleep?: (ms: number) => Promise<void>
}

export interface Tools {
  list(): ToolDef[]
  call(name: string, args: Record<string, unknown>): Promise<string>
}

const str = (d: string) => ({ type: 'string', description: d })
const int = (d: string) => ({ type: 'integer', description: d })

const DEFS: ToolDef[] = [
  { name: 'room_state', annotations: RO, description: 'Room overview: meta, participants (with cursors/status), open claims, last 10 bus messages, unread count. Call this before editing anything.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'room_read_live', annotations: RO, description: 'Current live room text of a file with line numbers, plus claims and cursors in it.',
    inputSchema: { type: 'object', properties: { path: str('repo-relative path') }, required: ['path'] } },
  { name: 'room_read_committed', annotations: RO, description: 'File content at HEAD of the local clone (git show HEAD:path).',
    inputSchema: { type: 'object', properties: { path: str('repo-relative path') }, required: ['path'] } },
  { name: 'room_diff', annotations: RO, description: 'Unified diff from committed (HEAD) to live room text, for one path or all changed paths.',
    inputSchema: { type: 'object', properties: { path: str('optional repo-relative path') } } },
  { name: 'room_who', annotations: RO, description: 'Who is active (cursor) or holds claims overlapping a file region.',
    inputSchema: { type: 'object', properties: { path: str('repo-relative path'), from: int('first line (1-based), default 1'), to: int('last line, default EOF') }, required: ['path'] } },
  { name: 'room_claim', annotations: RW, description: 'Claim a line range before editing it. Reports overlaps with other parties (and posts a conflict). Returns claimId.',
    inputSchema: { type: 'object', properties: { path: str('repo-relative path'), from: int('first line'), to: int('last line'), intent: str('what you are about to do') }, required: ['path', 'from', 'to', 'intent'] } },
  { name: 'room_release', annotations: RW, description: 'Release a claim you hold, optionally with a summary of what you did.',
    inputSchema: { type: 'object', properties: { claimId: str('claim id'), summary: str('optional summary') }, required: ['claimId'] } },
  { name: 'room_send', annotations: RW, description: 'Post a bus message: changed (paths+summary), question (to someone), or answer (inReplyTo a question).',
    inputSchema: { type: 'object', properties: {
      type: { type: 'string', enum: ['changed', 'question', 'answer'] },
      to: str('recipient person name (their agent); empty = broadcast'),
      text: str('message text / change summary'),
      paths: { type: 'array', items: { type: 'string' }, description: 'paths touched (changed)' },
      inReplyTo: str('message id being answered (answer)'),
    }, required: ['type', 'text'] } },
  { name: 'room_wait', annotations: RO, description: 'Sleep up to 30 seconds, e.g. to let a human finish in your region, then call room_state again.',
    inputSchema: { type: 'object', properties: { seconds: int('1-30') } } },
]

export function createTools(ctx: ToolCtx): Tools {
  const { room, me, dir } = ctx
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  let seenBus = room.bus.length

  const presences = (): Presence[] => {
    if (!ctx.awareness) return []
    return Array.from(ctx.awareness.getStates().values()).filter((s): s is Presence => !!s && typeof s === 'object' && !!(s as Presence).user)
  }
  const isMe = (p: { name: string; kind: string }) => p.name === me.name && p.kind === me.kind
  const myClaims = () => room.openClaims().filter(c => c.by === me.name && c.byKind === me.kind)

  const setPresence = (patch: Partial<Presence>) => {
    const a = ctx.awareness
    if (!a) return
    const cur = (a.getLocalState() ?? {}) as Partial<Presence>
    a.setLocalState({ ...cur, ...patch })
  }

  const requireFile = (path: unknown): string | { err: string } => {
    if (typeof path !== 'string' || !path) return { err: 'error: path is required' }
    if (!room.hasFile(path)) return { err: `error: ${path} is not in the room (known: ${room.paths().slice(0, 20).join(', ') || 'none'})` }
    return path
  }

  const activityIn = (path: string, from: number, to: number): string[] => {
    const lines: string[] = []
    for (const c of room.claimsFor(path)) if (rangesOverlap(c.from, c.to, from, to)) lines.push(`claim ${c.id}: ${describeClaim(c)}`)
    for (const p of presences()) {
      if (!p.cursor || p.cursor.path !== path) continue
      if (!rangesOverlap(p.cursor.from, p.cursor.to, from, to)) continue
      lines.push(`cursor: ${displayName(p.user)} at ${path}:${p.cursor.from}-${p.cursor.to}${p.status ? ` (${p.status})` : ''}`)
    }
    return lines
  }

  const gitShow = async (path: string): Promise<string | null> => {
    try { const { stdout } = await exec('git', ['-C', dir, 'show', `HEAD:${path}`], { maxBuffer: 8 * 1024 * 1024 }); return stdout }
    catch { return null }
  }
  const diffOne = async (path: string): Promise<string> => {
    const live = room.text(path) ?? ''
    const committed = (await gitShow(path)) ?? ''
    if (live === committed) return ''
    return createTwoFilesPatch(`a/${path}`, `b/${path}`, committed, live, 'HEAD', 'live', { context: 3 })
  }

  const handlers: Record<string, (a: Record<string, unknown>) => Promise<string>> = {
    async room_state() {
      const m = room.meta
      const out: string[] = []
      out.push(`you: ${displayName(me)}`)
      out.push(`meta: repo=${m.repo ?? '?'} branch=${m.branch ?? '?'} base=${(m.base ?? '?').slice(0, 10)} files=${room.paths().length}`)
      const ps = presences()
      out.push(`participants (${ps.length}):`)
      for (const p of ps) {
        const cur = p.cursor ? ` cursor=${p.cursor.path}:${p.cursor.from}-${p.cursor.to}` : ''
        out.push(`  - ${displayName(p.user)}${isMe(p.user) ? ' (you)' : ''} [${p.user.kind}]${p.status ? ` status=${p.status}` : ''}${cur}`)
      }
      const cs = room.openClaims()
      out.push(`open claims (${cs.length}):`)
      for (const c of cs) out.push(`  - ${c.id}: ${describeClaim(c)}${c.by === me.name && c.byKind === me.kind ? ' (yours)' : ''}`)
      const msgs = room.lastMessages(10)
      out.push(`last ${msgs.length} bus messages:`)
      for (const x of msgs) out.push(`  - [${x.id}] ${formatMsg(x)}`)
      const unread = Math.max(0, room.bus.length - seenBus)
      seenBus = room.bus.length
      out.push(`unread since your last room_state: ${unread}`)
      return out.join('\n')
    },
    async room_read_live(a) {
      const p = requireFile(a.path); if (typeof p !== 'string') return p.err
      const text = room.text(p) ?? ''
      const act = activityIn(p, 1, Number.MAX_SAFE_INTEGER)
      return `${p} (${room.lineCount(p)} lines)\n${act.length ? act.map(l => `! ${l}`).join('\n') + '\n' : ''}${withLineNumbers(text)}`
    },
    async room_read_committed(a) {
      if (typeof a.path !== 'string' || !a.path) return 'error: path is required'
      const s = await gitShow(a.path)
      return s === null ? `error: ${a.path} is not at HEAD in ${dir}` : withLineNumbers(s)
    },
    async room_diff(a) {
      if (typeof a.path === 'string' && a.path) {
        const d = await diffOne(a.path)
        return d || `${a.path}: no difference between HEAD and live`
      }
      const parts: string[] = []
      for (const p of room.paths()) { const d = await diffOne(p); if (d) parts.push(d) }
      return parts.length ? parts.join('\n') : 'no differences between HEAD and live'
    },
    async room_who(a) {
      const p = requireFile(a.path); if (typeof p !== 'string') return p.err
      const n = room.lineCount(p)
      const r = clampRange(Number(a.from ?? 1), Number(a.to ?? n), n)
      const act = activityIn(p, r.from, r.to)
      return act.length ? `${p}:${r.from}-${r.to}\n${act.join('\n')}` : `${p}:${r.from}-${r.to}: nobody active, no claims`
    },
    async room_claim(a) {
      if (typeof a.path !== 'string' || !a.path) return 'error: path is required'
      const p = a.path
      if (typeof a.intent !== 'string' || !a.intent) return 'error: intent is required'
      // A file that does not exist yet can still be claimed (intent: "create it"); range collapses to 1-1.
      const isNew = !room.hasFile(p)
      const n = isNew ? 1 : room.lineCount(p)
      const r = clampRange(Number(a.from), Number(a.to), n)
      if (!Number.isFinite(r.from)) return 'error: from/to must be numbers'
      const others = room.claimsFor(p).filter(c => !(c.by === me.name && c.byKind === me.kind) && claimsOverlap(c, { path: p, ...r }))
      const claim = room.addClaim({ path: p, from: r.from, to: r.to, by: me.name, byKind: me.kind, intent: a.intent })
      room.post<ClaimMsg>(me, { type: 'claim', claimId: claim.id, path: p, from_line: r.from, to_line: r.to, intent: a.intent })
      setPresence({ cursor: { path: p, from: r.from, to: r.to }, status: `editing ${p} ${r.from}-${r.to}: ${a.intent}` })
      const out = [`claimed ${claim.id}: ${describeClaim(claim)}${isNew ? ' (new file, not in room yet)' : ''}`]
      for (const o of others) {
        const text = `${displayName(me)} claimed ${p}:${r.from}-${r.to} (${a.intent}) overlapping ${describeClaim(o)}`
        room.post<ConflictMsg>(me, { type: 'conflict', claimId: claim.id, otherClaimId: o.id, path: p, text })
        out.push(`CONFLICT: overlaps ${o.id} (${describeClaim(o)}) — conflict posted to bus. Stop and check with your human before editing.`)
      }
      return out.join('\n')
    },
    async room_release(a) {
      if (typeof a.claimId !== 'string') return 'error: claimId is required'
      const c = room.claims.get(a.claimId)
      if (!c) return `error: no open claim ${a.claimId}`
      if (!(c.by === me.name && c.byKind === me.kind)) return `error: ${a.claimId} belongs to ${displayName({ name: c.by, kind: c.byKind })}`
      room.removeClaim(c.id)
      const summary = typeof a.summary === 'string' && a.summary ? a.summary : undefined
      room.post<ReleaseMsg>(me, { type: 'release', claimId: c.id, path: c.path, ...(summary ? { summary } : {}) })
      const next = myClaims()[0]
      setPresence(next
        ? { cursor: { path: next.path, from: next.from, to: next.to }, status: `editing ${next.path} ${next.from}-${next.to}: ${next.intent}` }
        : { cursor: undefined, status: 'idle' })
      return `released ${c.id} (${c.path}:${c.from}-${c.to})${summary ? ` — ${summary}` : ''}`
    },
    async room_send(a) {
      const text = typeof a.text === 'string' ? a.text : ''
      if (!text) return 'error: text is required'
      const to = typeof a.to === 'string' && a.to ? a.to : undefined
      if (to === me.name) return `error: you cannot message yourself. To ask ${me.name} (your human) something, just say it in your reply; room_send is for other people's agents.`
      let msg: Msg
      switch (a.type) {
        case 'changed': {
          const paths = Array.isArray(a.paths) ? a.paths.filter((x): x is string => typeof x === 'string') : []
          if (!paths.length) return 'error: changed requires paths'
          msg = room.post<ChangedMsg>(me, { type: 'changed', paths, summary: text, ...(to ? { to } : {}) })
          break
        }
        case 'question':
          msg = room.post<QuestionMsg>(me, { type: 'question', text, ...(to ? { to } : {}) })
          break
        case 'answer': {
          if (typeof a.inReplyTo !== 'string' || !a.inReplyTo) return 'error: answer requires inReplyTo'
          const orig = room.messages().find(m => m.id === a.inReplyTo)
          const dest = to ?? orig?.from
          if (!dest) return 'error: answer requires to (could not infer from inReplyTo)'
          msg = room.post<AnswerMsg>(me, { type: 'answer', to: dest, inReplyTo: a.inReplyTo, text })
          break
        }
        default: return `error: type must be changed|question|answer (got ${String(a.type)})`
      }
      seenBus = Math.max(seenBus, room.bus.length) // own message is not unread
      return `sent [${msg.id}] ${formatMsg(msg)}`
    },
    async room_wait(a) {
      const s = Math.min(30, Math.max(0, Number(a.seconds ?? 5) || 0))
      const before = room.bus.length
      await sleep(s * 1000)
      const arrived = room.bus.length - before
      return `waited ${s}s; ${arrived} new bus message(s) arrived — call room_state`
    },
  }

  return {
    list: () => DEFS,
    async call(name, args) {
      const h = handlers[name]
      if (!h) return `error: unknown tool ${name}`
      try { return await h(args ?? {}) }
      catch (e) { return `error: ${e instanceof Error ? e.message : String(e)}` }
    },
  }
}
