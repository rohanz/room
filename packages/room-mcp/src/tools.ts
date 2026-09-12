import { createTwoFilesPatch } from 'diff'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { diff3Merge } from 'node-diff3'
import {
  RoomDoc, formatMsg, formatPlans, withLineNumbers, claimsOverlap, clampRange, describeClaim, displayName, rangesOverlap, scopeCovers, msgPaths, symbolRange,
} from '@room/shared'
import type {
  Claim, Identity, Presence, Msg, Plan, Priority, Scope,
  ChangedMsg, QuestionMsg, AnswerMsg, ClaimMsg, ReleaseMsg, ConflictMsg, NoteMsg, ScopeMsg, PlanMsg,
} from '@room/shared'
import { git, gitShow } from '@room/roomd/git'
import { joinSession, leaveSession, type JoinOptions, type Session } from './session.js'
import { HooksBridge } from './hooks-bridge.js'

export interface ToolDef {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  /** MCP tool annotations; Codex uses these to decide whether a call needs approval. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
}

/** Room tools only touch the shared room doc, never the user's files, so none is destructive. */
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }

export interface ToolCtx {
  /** Current session, or null before room_join. */
  getSession(): Session | null
  setSession(s: Session | null): void
  /** Working directory used by room_join when the caller passes none. */
  cwd: string
  /** Injectable for tests. */
  join?: (o: JoinOptions) => Promise<Session>
  leave?: (s: Session) => Promise<void>
  now?: () => number
  /** Injectable wake for tests (default: `codex queue`). */
  queue?: (threadId: string, text: string) => Promise<void>
  /** Diagnostics (inbox deliveries etc.); default stderr. */
  log?: (line: string) => void
}

export interface Tools {
  list(): ToolDef[]
  call(name: string, args: Record<string, unknown>): Promise<string>
  /** Attach the hooks bridge (state file + wake) to a session; idempotent. */
  attachHooks(s: Session): void
  /** Release claims, clear scope, stop the bridge and daemon (process exit path). */
  shutdown(): Promise<void>
  /** For sessions joined outside room_join (auto-join): clear stale state under my name. */
  clearStale(s: Session): number
}

const str = (d: string) => ({ type: 'string', description: d })
const int = (d: string) => ({ type: 'integer', description: d })
const strs = (d: string) => ({ type: 'array', items: { type: 'string' }, description: d })
const PLANS = {
  type: 'array',
  description: 'Changes you intend to make that others may depend on. Declare BEFORE editing.',
  items: { type: 'object', properties: {
    kind: { type: 'string', enum: ['rename', 'signature', 'delete', 'add'] },
    symbol: str('function/class/variable name as it is now'),
    detail: str('new name, new signature, or why'),
  }, required: ['kind', 'symbol'] },
}

export const DEFS: ToolDef[] = [
  { name: 'room_join', annotations: RW, description: 'Join the room for this clone. Room name is derived from the git origin + branch; your name from git config. Starts the sync daemon (push-only: nothing is ever written to your disk). Returns who is here, their scopes, open claims, and the browser view URL.',
    inputSchema: { type: 'object', properties: { room: str('override room name (default: <host/owner/repo>/<branch>)'), name: str('override your name'), server: str('override ws server URL'), dir: str('clone directory (default: cwd)') } } },
  { name: 'room_leave', annotations: RW, description: 'Leave the room: releases your claims, clears your scope, stops the daemon.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'room_scope', annotations: RW, description: 'Declare what you are working on: a one-word area (e.g. "auth"), a one-line summary, and the paths you expect to touch. Do this before editing. Replaces your previous scope. The reply ends with the area ledger: what others changed there and their open plans.',
    inputSchema: { type: 'object', properties: { area: str('one word, lowercase'), summary: str('one line'), paths: strs('files or directories you expect to touch') }, required: ['area', 'summary', 'paths'] } },
  { name: 'room_state', annotations: RO, description: 'Room overview: who is here and on what, per-area activity, open claims with plans, files changed by whom, recent bus. Call before editing and after any wait.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'room_read', annotations: RO, description: 'A file as a person sees it right now: base commit + their uncommitted edits (default: you). With line numbers, claims in the file, and the file ledger (recent changes by others, open plans).',
    inputSchema: { type: 'object', properties: { path: str('repo-relative path'), person: str('whose live version (default you)') }, required: ['path'] } },
  { name: 'room_diff', annotations: RO, description: 'Unified diff from the base commit to a person\'s live version, for one path or all their changed paths.',
    inputSchema: { type: 'object', properties: { path: str('optional path'), person: str('default you') } } },
  { name: 'room_who', annotations: RO, description: 'Who holds claims in a region of a file, whose scope covers it, and who has changed the file.',
    inputSchema: { type: 'object', properties: { path: str('repo-relative path'), from: int('first line, default 1'), to: int('last line, default EOF') }, required: ['path'] } },
  { name: 'room_claim', annotations: RW, description: 'Claim what you are about to edit, saying what you will do: either a symbol (function/class name; the room resolves its line range) or a line range. Declare renames/signature changes in `plans` so anyone who uses those symbols is told now. Reports overlaps (posting a conflict). Returns claimId.',
    inputSchema: { type: 'object', properties: { path: str('repo-relative path'), symbol: str('function/class to claim (preferred over from/to)'), from: int('first line (if no symbol)'), to: int('last line (if no symbol)'), intent: str('what you are about to do'), plans: PLANS }, required: ['path', 'intent'] } },
  { name: 'room_release', annotations: RW, description: 'Release a claim with a summary of what you did. Plans whose symbol is not mentioned in the summary (or in `done`) are reported as not done.',
    inputSchema: { type: 'object', properties: { claimId: str('claim id'), summary: str('what changed, one line'), done: strs('symbols from your plans that you completed') }, required: ['claimId'] } },
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
    inputSchema: { type: 'object', properties: { claimId: str('wait for this claim to be released'), questionId: str('wait for an answer to this question'), timeoutMs: int('default 30000, max 120000') } } },
  { name: 'room_done', annotations: RW, description: 'Mark your current task finished: releases any claims you still hold, clears your scope, and posts a one-line completion note. Call after your final room_preview_merge, before reporting to your human. Stay in the room for questions.',
    inputSchema: { type: 'object', properties: { summary: str('one line: what landed and the test result') }, required: ['summary'] } },
  { name: 'room_impact', annotations: RO, description: 'Dependency graph query. symbol: who defines it and which files use it, with who owns those files (scope, claims, uncommitted changes). path: what the file depends on (symbols defined elsewhere) and what depends on it. Use before renaming or changing a signature, and to see what you are waiting on.',
    inputSchema: { type: 'object', properties: { symbol: str('function/class/variable name'), path: str('repo-relative path') } } },
  { name: 'room_preview_merge', annotations: RO, description: 'Would your uncommitted changes and another person\'s combine cleanly? Three-way merge against the common base; nothing in any clone is written. Reports clean paths and conflicting hunks. With `run`, materialises the merged tree in a scratch directory and runs that command there (e.g. the tests), so you can verify code that depends on their unmerged work.',
    inputSchema: { type: 'object', properties: { person: str('the other person'), run: str('optional shell command to run in the merged tree, e.g. "uv run pytest -q"') }, required: ['person'] } },
]

const WAIT_DEFAULT = 30_000
const WAIT_MAX = 120_000
const STALE_MS = 10 * 60 * 1000

export function createTools(ctx: ToolCtx): Tools {
  const now = ctx.now ?? (() => Date.now())
  const log = ctx.log ?? ((l: string) => process.stderr.write(`room-mcp: ${l}\n`))
  const doJoin = ctx.join ?? joinSession
  const doLeave = ctx.leave ?? leaveSession

  // ---- per-session state --------------------------------------------------
  const seen = new Set<string>() // message ids already shown in the inbox (ids, not indexes: the bus is a concurrent array)
  const upgraded = new Set<string>() // "msgId:person" copies already posted
  const conflictPairs = new Set<string>() // sorted "a:b" claim-id pairs already reported
  let observedSession: Session | null = null
  let bridge: HooksBridge | null = null
  const attachHooks = (s: Session) => {
    if (bridge && (bridge as unknown as { s: Session }).s === s) return
    bridge?.stop()
    bridge = new HooksBridge(s, { forMe: m => forMe(s, m), isSeen: id => seen.has(id), log, queue: ctx.queue })
    bridge.start()
  }
  /** Two room_claim calls on different machines can both pass the overlap pre-check. When the
   *  other claim arrives, the owner of the lexicographically smaller id reports the conflict. */
  const observeClaims = (s: Session) => {
    if (observedSession === s) return
    observedSession = s
    s.room.claims.observe((ev, tr) => {
      if (tr.local) return
      for (const [id, ch] of ev.changes.keys) {
        if (ch.action !== 'add') continue
        const arrived = s.room.openClaims().find(c => c.id === id)
        if (!arrived || (arrived.by === s.me.name && arrived.byKind === s.me.kind)) continue
        for (const m of mine(s)) {
          if (!claimsOverlap(m, arrived)) continue
          const key = [m.id, arrived.id].sort().join(':')
          if (conflictPairs.has(key) || s.room.messages().some(x => x.type === 'conflict' && [x.claimId, x.otherClaimId].sort().join(':') === key)) { conflictPairs.add(key); continue }
          conflictPairs.add(key)
          if (m.id.localeCompare(arrived.id) > 0) continue
          const text = `concurrent overlapping claims: ${describeClaim(m)} and ${describeClaim(arrived)}`
          s.room.post<ConflictMsg>(s.me, { type: 'conflict', claimId: m.id, otherClaimId: arrived.id, path: m.path, text, to: arrived.by })
        }
      }
    })
  }

  const S = (): Session => {
    const s = ctx.getSession()
    if (!s) throw new NotJoined()
    return s
  }
  const isMe = (s: Session, p: { name: string; kind: string }) => p.name === s.me.name && p.kind === s.me.kind
  const mine = (s: Session) => s.room.openClaims().filter(c => c.by === s.me.name && c.byKind === s.me.kind)
  const others = (s: Session): string[] => {
    const names = new Set<string>()
    for (const k of s.room.scopes.keys()) names.add(k)
    for (const k of s.room.overlays.keys()) names.add(k)
    for (const p of presences(s)) names.add(p.user.name)
    names.delete(s.me.name)
    return Array.from(names).sort()
  }
  const presences = (s: Session): Presence[] =>
    Array.from(s.awareness.getStates().values()).filter((x): x is Presence => !!x && typeof x === 'object' && !!(x as Presence).user)
  const setPresence = (s: Session, patch: Partial<Presence>) => {
    const cur = (s.awareness.getLocalState() ?? {}) as Partial<Presence>
    s.awareness.setLocalState({ ...cur, ...patch, lastActive: now() })
  }
  const base = (s: Session) => s.room.meta.base ?? 'HEAD'
  /** The commit a person's overlay is a delta from (their own HEAD), falling back to the room base. */
  const baseFor = (s: Session, person: string) => s.room.baseOf(person) ?? base(s)
  const baseText = async (s: Session, path: string, person = s.me.name): Promise<string | undefined> => gitShow(s.dir, baseFor(s, person), path)
  /** A person's HEAD + their overlay; undefined if the file exists nowhere; null if they deleted it.
   *  Throws NeedFetch when their HEAD is not in this clone. */
  const liveText = async (s: Session, path: string, person: string): Promise<string | undefined | null> => {
    if (s.room.deleted.get(person)?.has(path)) return null
    const ov = s.room.text(path, person)
    if (ov !== undefined) return ov
    try { return await baseText(s, path, person) }
    catch (e) { throw new NeedFetch(person, baseFor(s, person), e instanceof Error ? e.message : String(e)) }
  }
  const lines = (t: string) => t.endsWith('\n') ? t.split('\n').length - 1 : t.split('\n').length

  // ---- inbox ----------------------------------------------------------------
  const forMe = (s: Session, m: Msg) => {
    if (m.from === s.me.name && m.fromKind === 'agent') return false
    if (m.to === s.me.name) return true
    if (m.type === 'base') return true // someone committed: everyone should know to pull
    if (m.type === 'conflict') return mine(s).some(c => c.id === m.claimId || c.id === m.otherClaimId)
    return false
  }
  const inbox = (s: Session): string => {
    const fresh: Msg[] = []
    for (const m of s.room.messages()) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      if (forMe(s, m)) fresh.push(m)
    }
    if (seen.size > 5000) { const keep = s.room.lastMessages(2000).map(m => m.id); seen.clear(); for (const k of keep) seen.add(k) }
    if (!fresh.length) return ''
    const rank: Record<Priority, number> = { interrupt: 0, notify: 1, fyi: 2 }
    fresh.sort((a, b) => rank[a.priority] - rank[b.priority] || a.at - b.at)
    s.room.markSeen(s.me.name, fresh.map(m => m.id))
    for (const m of fresh) log(`inbox → ${s.me.name}: [${m.priority}] ${formatMsg(m)}`)
    bridge?.scheduleWrite()
    return `[inbox ${fresh.length}]\n${fresh.map(m => `  ${m.priority.padEnd(9)} [${m.id}] ${formatMsg(m)}`).join('\n')}\n\n`
  }

  // ---- scope upgrade rule ---------------------------------------------------
  /** Who else is affected by these paths/symbols: scope covers a path, or their files mention a symbol. */
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
  /** Who is around a file: scope owner, claimants, changers. */
  const owners = (s: Session, f: string): string[] => {
    const out = new Set<string>()
    for (const sc of s.room.allScopes()) if (scopeCovers(sc, f)) out.add(sc.by)
    for (const c of s.room.claimsFor(f)) out.add(c.by)
    for (const p of s.room.whoChanged(f)) out.add(p)
    return Array.from(out).sort()
  }
  const describeUsers = (s: Session, files: string[]): string => files.map(f => { const o = owners(s, f).filter(x => x !== s.me.name); return o.length ? `${f} (${o.join(', ')})` : f }).join(', ')
  /** Open plans by others on symbols that files in my scope (or my changed files) reference. */
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
  /** A plan on a released-undone or re-declared claim: tell everyone who was shown the original, at interrupt. */
  const planChanged = (s: Session, c: Claim, plan: Plan, status: PlanMsg['status'], text: string, replacedBy?: Plan): string[] => {
    const deps = (c.msgId ? s.room.dependentsOf(c.msgId) : []).filter(p => p !== s.me.name)
    const base: Omit<PlanMsg, 'id' | 'at' | 'from' | 'fromKind' | 'priority'> = { type: 'plan', status, claimId: c.id, path: c.path, plan, text, ...(replacedBy ? { replacedBy } : {}) }
    const orig = s.room.post<PlanMsg>(s.me, base)
    for (const p of deps) s.room.post<PlanMsg>(s.me, { ...base, to: p, copyOf: orig.id })
    return deps.length ? [`plan ${status}: ${formatPlans([plan])} — told ${deps.map(d => `${d}'s agent`).join(', ')} (they were shown it)`] : [`plan ${status}: ${formatPlans([plan])} — nobody had been shown it`]
  }
  /** Release my claims (cancelling their plans) and clear my scope. `why` goes in the release summary. */
  const cleanupMine = (s: Session, why: string): number => {
    const released = mine(s)
    for (const c of released) {
      s.room.removeClaim(c.id)
      s.room.post<ReleaseMsg>(s.me, { type: 'release', claimId: c.id, path: c.path, summary: why, ...(c.plans?.length ? { unfulfilled: c.plans } : {}) })
      for (const pl of c.plans ?? []) planChanged(s, c, pl, 'cancelled', why)
    }
    s.room.clearScope(s.me.name)
    return released.length
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

  // ---- rendering helpers ----------------------------------------------------
  const claimLine = (s: Session, c: Claim) => {
    const stale = !presences(s).some(p => p.user.name === c.by) && now() - c.at > STALE_MS
    return `  - ${c.id}: ${describeClaim(c)}${isMe(s, { name: c.by, kind: c.byKind }) ? ' (yours)' : ''}${stale ? ' [stale: owner offline]' : ''}`
  }
  const ledgerLines = (s: Session, q: NonNullable<Parameters<RoomDoc['ledger']>[0]>, label: string): string[] => {
    const entries = s.room.ledger({ ...q, limit: q.limit ?? 10 }).filter(m => !(m.to && m.to !== s.me.name && m.from !== s.me.name))
    const plans = s.room.openClaims().filter(c => c.plans?.length && !(c.by === s.me.name) && (q.path ? c.path === q.path : true) && (q.area ? s.room.allScopes().some(sc => sc.area === q.area && scopeCovers(sc, c.path)) : true))
    const out = [`${label} ledger (${entries.length}):`]
    for (const m of entries) out.push(`  - ${new Date(m.at).toISOString().slice(11, 19)} ${formatMsg(m)}`)
    if (plans.length) { out.push('open plans by others:'); for (const c of plans) out.push(`  - ${c.by}'s agent in ${c.path}: ${formatPlans(c.plans!)}`) }
    return out
  }
  const scopeLine = (sc: Scope) => `${sc.area}: ${sc.summary} (${sc.paths.join(', ')})`
  /** One line about what a person is doing: live scope, or their last done note, plus unpushed changes. */
  const personLine = (s: Session, name: string): string => {
    const sc = s.room.scope(name)
    const p = presences(s).find(x => x.user.name === name && x.user.kind === 'agent') ?? presences(s).find(x => x.user.name === name)
    const changed = s.room.changedPaths(name)
    const lastDone = [...s.room.messages()].reverse().find((m): m is NoteMsg => m.from === name && m.type === 'note' && m.text.startsWith('done'))
    let what: string
    if (sc) what = `working on ${scopeLine(sc)}`
    else if (p?.status?.startsWith('done')) what = `${p.status}`
    else if (lastDone && (!p || p.status === 'idle' || p.status === 'synced')) what = `${lastDone.text} (${new Date(lastDone.at).toISOString().slice(11, 16)})`
    else what = p ? `${p.status ?? 'idle'}, no task declared` : 'offline'
    return `${what}${changed.length ? `; uncommitted, not yet pushed: ${changed.join(', ')}` : ''}`
  }

  // ---- handlers -------------------------------------------------------------
  const handlers: Record<string, (a: Record<string, unknown>) => Promise<string>> = {
    async room_join(a) {
      const cur = ctx.getSession()
      if (cur) return `already in ${cur.roomName} as ${displayName(cur.me)}; room_leave first to switch`
      const s = await doJoin({
        dir: typeof a.dir === 'string' && a.dir ? a.dir : ctx.cwd,
        name: typeof a.name === 'string' && a.name ? a.name : undefined,
        room: typeof a.room === 'string' && a.room ? a.room : undefined,
        server: typeof a.server === 'string' && a.server ? a.server : undefined,
      })
      ctx.setSession(s)
      for (const m of s.room.messages()) seen.add(m.id)
      observeClaims(s)
      attachHooks(s)
      const stale = cleanupMine(s, 'stale from an earlier session')
      if (stale || s.room.scope(s.me.name)) log(`cleared ${stale} stale claim(s) and scope from an earlier session`)
      const out = [`joined ${s.roomName} as ${displayName(s.me)} (base ${(s.room.meta.base ?? '?').slice(0, 10)}, clone ${s.dir})`]
      const here = others(s).filter(n => presences(s).some(p => p.user.name === n))
      out.push(here.length ? `here now: ${here.join(', ')}` : 'nobody else is here yet')
      for (const n of here) out.push(`  ${n}: ${personLine(s, n)}`)
      const away = others(s).filter(n => !here.includes(n) && s.room.changedPaths(n).length)
      for (const n of away) out.push(`  ${n} (offline): ${personLine(s, n)}`)
      const cs = s.room.openClaims()
      if (cs.length) { out.push(`open claims (${cs.length}):`); for (const c of cs) out.push(claimLine(s, c)) }
      out.push(`browser view: ${s.browserUrl}`)
      out.push('next: room_scope(area, summary, paths) before you edit.')
      return out.join('\n')
    },
    async room_leave() {
      const s = S()
      const released = cleanupMine(s, 'left the room')
      ctx.setSession(null)
      bridge?.stop(); bridge = null
      await doLeave(s)
      return `left ${s.roomName}; released ${released} claim(s)`
    },
    async room_scope(a) {
      const s = S()
      const area = String(a.area ?? '').trim().toLowerCase().split(/\s+/)[0]
      const summary = String(a.summary ?? '').trim()
      const paths = Array.isArray(a.paths) ? a.paths.filter((x): x is string => typeof x === 'string' && !!x) : []
      if (!area || !summary || !paths.length) return 'error: area, summary and paths are required'
      s.room.setScope({ by: s.me.name, byKind: s.me.kind, area, summary, paths })
      s.room.post<ScopeMsg>(s.me, { type: 'scope', area, summary, paths })
      setPresence(s, { status: `on ${area}: ${summary}` })
      const out = [`scope set: ${scopeLine({ area, summary, paths } as Scope)}`]
      const overlapping = s.room.allScopes().filter(sc => sc.by !== s.me.name && paths.some(p => scopeCovers(sc, p) || sc.paths.some(q => scopeCovers({ paths }, q))))
      for (const sc of overlapping) out.push(`overlaps ${sc.by}'s scope ${scopeLine(sc)} — coordinate before touching shared files`)
      out.push(...ledgerLines(s, { area, limit: 20 }, area))
      return out.join('\n')
    },
    async room_state() {
      const s = S()
      const m = s.room.meta
      const out: string[] = []
      out.push(`you: ${displayName(s.me)} in ${s.roomName} (base ${(m.base ?? '?').slice(0, 10)})`)
      const ps = presences(s)
      const names = new Set<string>([...ps.map(p => p.user.name), ...s.room.scopes.keys()])
      out.push(`participants (${names.size}):`)
      for (const n of Array.from(names).sort()) {
        const p = ps.find(x => x.user.name === n && x.user.kind === 'agent') ?? ps.find(x => x.user.name === n)
        const ago = p?.lastActive ? `active ${Math.max(0, Math.round((now() - p.lastActive) / 1000))}s ago` : 'offline'
        out.push(`  - ${n}${n === s.me.name ? ' (you)' : ''}: ${personLine(s, n)} · ${ago}`)
      }
      out.push(`browser view: ${s.browserUrl}`)
      const areas = s.room.areaSummary()
      if (areas.length) { out.push('areas:'); for (const l of areas) out.push(`  - ${l}`) }
      const cs = s.room.openClaims()
      out.push(`open claims (${cs.length}):`)
      for (const c of cs) out.push(claimLine(s, c))
      const changed = new Map<string, string[]>()
      for (const person of [s.me.name, ...others(s)]) { const ps2 = s.room.changedPaths(person); if (ps2.length) changed.set(person, ps2) }
      out.push('uncommitted changes:')
      if (!changed.size) out.push('  (none)')
      for (const [person, ps2] of changed) out.push(`  - ${person}: ${ps2.join(', ')}`)
      const waits = await waitingOn(s)
      if (waits.length) { out.push('waiting on (others\' planned changes to symbols you use):'); out.push(...waits) }
      const msgs = s.room.lastMessages(10).filter(x => !(x.to && x.to !== s.me.name && x.from !== s.me.name))
      out.push(`recent bus (${msgs.length}):`)
      for (const x of msgs) out.push(`  - [${x.id}] ${formatMsg(x)}`)
      return out.join('\n')
    },
    async room_read(a) {
      const s = S()
      if (typeof a.path !== 'string' || !a.path) return 'error: path is required'
      const p = a.path
      const person = typeof a.person === 'string' && a.person ? a.person : s.me.name
      const t = await liveText(s, p, person)
      if (t === null) return `${p}: deleted by ${person} (uncommitted)`
      if (t === undefined) return `error: ${p} exists neither at base nor in ${person}'s changes`
      const out = [`${p} as ${person} sees it (${lines(t)} lines${s.room.text(p, person) !== undefined ? ', uncommitted edits' : ', unchanged'} on their HEAD ${baseFor(s, person).slice(0, 10)})`]
      const who = s.room.whoChanged(p).filter(x => x !== person)
      if (who.length) out.push(`! also changed (uncommitted) by: ${who.join(', ')} — room_read with person= to see theirs`)
      for (const c of s.room.claimsFor(p)) out.push(`! claim ${c.id}: ${describeClaim(c)}`)
      out.push(withLineNumbers(t))
      out.push(...ledgerLines(s, { path: p, limit: 10 }, p))
      return out.join('\n')
    },
    async room_diff(a) {
      const s = S()
      const person = typeof a.person === 'string' && a.person ? a.person : s.me.name
      const one = async (p: string) => {
        const b = (await baseText(s, p)) ?? ''
        const l = await liveText(s, p, person)
        const live = l === null ? '' : l ?? b
        return live === b ? '' : createTwoFilesPatch(`a/${p}`, `b/${p}`, b, live, 'base', person, { context: 3 })
      }
      if (typeof a.path === 'string' && a.path) return (await one(a.path)) || `${a.path}: no difference between base and ${person}'s version`
      const parts: string[] = []
      for (const p of s.room.changedPaths(person)) { const d = await one(p); if (d) parts.push(d) }
      return parts.length ? parts.join('\n') : `${person} has no uncommitted changes`
    },
    async room_who(a) {
      const s = S()
      if (typeof a.path !== 'string' || !a.path) return 'error: path is required'
      const p = a.path
      const t = await liveText(s, p, s.me.name)
      const n = t ? lines(t) : 1
      const r = clampRange(Number(a.from ?? 1), Number(a.to ?? n), n)
      const out: string[] = []
      for (const c of s.room.claimsFor(p)) if (rangesOverlap(c.from, c.to, r.from, r.to)) out.push(`claim ${c.id}: ${describeClaim(c)}`)
      for (const sc of s.room.allScopes()) if (sc.by !== s.me.name && scopeCovers(sc, p)) out.push(`scope: ${sc.by} is on ${scopeLine(sc)}`)
      const who = s.room.whoChanged(p).filter(x => x !== s.me.name)
      if (who.length) out.push(`uncommitted changes by: ${who.join(', ')}`)
      return out.length ? `${p}:${r.from}-${r.to}\n${out.join('\n')}` : `${p}:${r.from}-${r.to}: no claims, no scopes, nobody else has changed it`
    },
    async room_claim(a) {
      const s = S()
      if (typeof a.path !== 'string' || !a.path) return 'error: path is required'
      if (typeof a.intent !== 'string' || !a.intent) return 'error: intent is required'
      const p = a.path, intent = a.intent
      const plans = parsePlans(a.plans)
      if (typeof plans === 'string') return plans
      const t = await liveText(s, p, s.me.name)
      const isNew = t === undefined || t === null
      const n = isNew ? 1 : lines(t)
      let range: { from: number; to: number }
      const symbol = typeof a.symbol === 'string' && a.symbol.trim() ? a.symbol.trim() : undefined
      if (symbol) {
        const r0 = isNew ? undefined : symbolRange(p, t!, symbol)
        if (!r0) return `error: could not find a definition of ${symbol} in ${p}; pass from/to instead`
        range = r0
      } else {
        if (!Number.isFinite(Number(a.from)) || !Number.isFinite(Number(a.to))) return 'error: pass symbol, or from and to'
        range = { from: Number(a.from), to: Number(a.to) }
      }
      const r = clampRange(range.from, range.to, n)
      const intentFull = symbol ? `${symbol}: ${intent}` : intent
      const overl = s.room.claimsFor(p).filter(c => !isMe(s, { name: c.by, kind: c.byKind }) && claimsOverlap(c, { path: p, ...r }))
      let claim!: Claim
      let msg!: ClaimMsg
      s.room.doc.transact(() => {
        claim = s.room.addClaim({ path: p, from: r.from, to: r.to, by: s.me.name, byKind: s.me.kind, intent: intentFull, ...(plans.length ? { plans } : {}) })
        msg = s.room.post<ClaimMsg>(s.me, { type: 'claim', claimId: claim.id, path: p, from_line: r.from, to_line: r.to, intent: intentFull, ...(plans.length ? { plans } : {}) })
        for (const o of overl) {
          const text = `${displayName(s.me)} claimed ${p}:${r.from}-${r.to} (${intentFull}) overlapping ${describeClaim(o)}`
          s.room.post<ConflictMsg>(s.me, { type: 'conflict', claimId: claim.id, otherClaimId: o.id, path: p, text, to: o.by })
        }
      }, s.me)
      s.room.setClaimMsg(claim.id, msg.id)
      s.daemon.touch()
      setPresence(s, { cursor: { path: p, from: r.from, to: r.to }, status: `editing ${symbol ?? `${p}:${r.from}-${r.to}`} — ${intent}` })
      const out = [`claimed ${claim.id}: ${describeClaim(claim)}${isNew ? ' (new file)' : ''}`]
      // A new plan on a symbol I already have an open plan for supersedes the old one.
      for (const pl of plans) {
        for (const other of mine(s)) {
          if (other.id === claim.id) continue
          const old = other.plans?.find(x => x.symbol === pl.symbol && (x.kind !== pl.kind || x.detail !== pl.detail))
          if (old) out.push(...planChanged(s, other, old, 'superseded', `replaced by ${formatPlans([pl])} in claim ${claim.id}`, pl))
        }
      }
      for (const o of overl) out.push(`CONFLICT: overlaps ${o.id} (${describeClaim(o)}). Conflict posted. Do not edit that region; ask ${o.by}'s agent or wait for release.`)
      if (s.graph && plans.length) {
        await s.graph.ready
        for (const pl of plans) {
          const users = s.graph.graph.usersOf(pl.symbol)
          out.push(users.length ? `impact: ${pl.symbol} is used in ${users.length} file(s): ${describeUsers(s, users)}` : `impact: ${pl.symbol} has no other users in the indexed graph`)
        }
      }
      const scopesHit = s.room.allScopes().filter(sc => sc.by !== s.me.name && scopeCovers(sc, p))
      for (const sc of scopesHit) out.push(`note: ${p} is inside ${sc.by}'s scope (${sc.area}); they will be told of your plans`)
      out.push(...await upgrade(s, msg, [p], plans.map(x => x.symbol)))
      return out.join('\n')
    },
    async room_release(a) {
      const s = S()
      if (typeof a.claimId !== 'string') return 'error: claimId is required'
      const c = s.room.claims.get(a.claimId)
      if (!c) return `error: no open claim ${a.claimId}`
      if (!isMe(s, { name: c.by, kind: c.byKind })) return `error: ${a.claimId} belongs to ${displayName({ name: c.by, kind: c.byKind })}`
      const summary = typeof a.summary === 'string' && a.summary ? a.summary : undefined
      const done = new Set(Array.isArray(a.done) ? a.done.filter((x): x is string => typeof x === 'string') : [])
      const unfulfilled = (c.plans ?? []).filter(pl => !done.has(pl.symbol) && !(summary ?? '').includes(pl.symbol) && !(pl.detail && (summary ?? '').includes(pl.detail)))
      s.room.removeClaim(c.id)
      s.room.post<ReleaseMsg>(s.me, { type: 'release', claimId: c.id, path: c.path, ...(summary ? { summary } : {}), ...(unfulfilled.length ? { unfulfilled } : {}) })
      s.daemon.touch()
      const next = mine(s)[0]
      setPresence(s, next
        ? { cursor: { path: next.path, from: next.from, to: next.to }, status: `editing ${next.path}:${next.from}-${next.to} — ${next.intent}` }
        : { cursor: undefined, status: s.room.scope(s.me.name) ? `on ${s.room.scope(s.me.name)!.area}` : 'idle' })
      const out = [`released ${c.id} (${c.path}:${c.from}-${c.to})${summary ? ` — ${summary}` : ''}`]
      if (unfulfilled.length) {
        out.push(`not done (declared but not in summary): ${formatPlans(unfulfilled)} — if you did them, room_send changed with symbols; if not, others were expecting them`)
        for (const pl of unfulfilled) out.push(...planChanged(s, c, pl, 'cancelled', summary ?? 'released without doing it'))
      }
      if (c.plans?.length && !unfulfilled.length) out.push(`reminder: announce with room_send type=changed symbols=[${c.plans.map(x => x.symbol).join(', ')}] so users of those symbols are told`)
      return out.join('\n')
    },
    async room_send(a) {
      const s = S()
      const text = typeof a.text === 'string' ? a.text : ''
      if (!text) return 'error: text is required'
      const to = typeof a.to === 'string' && a.to ? a.to : undefined
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
      return [`sent [${msg.id}] ${formatMsg(msg)}`, ...notes].join('\n')
    },
    async room_wait(a) {
      const s = S()
      const claimId = typeof a.claimId === 'string' && a.claimId ? a.claimId : undefined
      const questionId = typeof a.questionId === 'string' && a.questionId ? a.questionId : undefined
      const timeoutMs = Math.min(WAIT_MAX, Math.max(0, Number(a.timeoutMs ?? WAIT_DEFAULT) || WAIT_DEFAULT))
      if (claimId && !s.room.claims.has(claimId)) return `claim ${claimId} is already released`
      const answered = (id: string) => s.room.messages().find(m => m.type === 'answer' && m.inReplyTo === id)
      if (questionId) { const an = answered(questionId); if (an) return `answered: ${formatMsg(an)}` }
      setPresence(s, { status: claimId ? `waiting for ${claimId}` : questionId ? `waiting for answer to ${questionId}` : 'waiting' })
      const result = await new Promise<string>(resolve => {
        const finish = (r: string) => { clearTimeout(timer); s.room.claims.unobserve(onClaims); s.room.bus.unobserve(onBus); resolve(r) }
        const timer = setTimeout(() => finish(`timeout after ${timeoutMs}ms: ${claimId ? `${claimId} still held` : questionId ? `no answer to ${questionId}` : 'nothing happened'}. Tell your human; proceed only where you do not depend on it.`), timeoutMs)
        const onClaims = () => { if (claimId && !s.room.claims.has(claimId)) finish(`released: ${claimId}`) }
        const onBus = (ev: { changes: { delta: { insert?: unknown }[] } }) => {
          for (const d of ev.changes.delta) for (const m of (d.insert ?? []) as Msg[]) {
            if (questionId && m.type === 'answer' && m.inReplyTo === questionId) return finish(`answered: ${formatMsg(m)}`)
            if (m.priority === 'interrupt' && forMe(s, m)) return finish(`interrupt: ${formatMsg(m)}`)
          }
        }
        s.room.claims.observe(onClaims); s.room.bus.observe(onBus)
      })
      setPresence(s, { status: 'idle' })
      return `${result}\ncall room_state before continuing.`
    },
    async room_done(a) {
      const s = S()
      const summary = String(a.summary ?? '').trim()
      if (!summary) return 'error: summary is required'
      const sc = s.room.scope(s.me.name)
      const released = cleanupMine(s, `done: ${summary}`)
      s.room.post<NoteMsg>(s.me, { type: 'note', text: `done${sc ? ` (${sc.area})` : ''}: ${summary}` })
      setPresence(s, { cursor: undefined, status: `done: ${summary.slice(0, 60)}` })
      s.daemon.touch()
      return `marked done${sc ? ` (${sc.area})` : ''}; released ${released} claim(s), scope cleared. You are still in the room and will be woken for questions.`
    },
    async room_impact(a) {
      const s = S()
      if (!s.graph) return 'error: no symbol graph in this session'
      await s.graph.ready
      const g = s.graph.graph
      const out: string[] = []
      if (typeof a.symbol === 'string' && a.symbol) {
        const i = g.impact(a.symbol)
        out.push(`${a.symbol}: defined in ${i.definedIn.length ? describeUsers(s, i.definedIn) : 'nowhere indexed'}`)
        out.push(i.usedIn.length ? `used in ${i.usedIn.length} file(s): ${describeUsers(s, i.usedIn)}` : 'used by no other indexed file')
        for (const c of s.room.openClaims()) if (c.plans?.some(pl => pl.symbol === a.symbol)) out.push(`open plan: ${describeClaim(c)}`)
      } else if (typeof a.path === 'string' && a.path) {
        if (!g.has(a.path)) return `${a.path} is not in the graph (not a source file, too large, or not at base/overlays)`
        const deps = g.dependenciesOf(a.path), dependents = g.dependentsOf(a.path)
        out.push(`${a.path} depends on ${deps.length} symbol(s) defined elsewhere:`)
        for (const d of deps.slice(0, 40)) out.push(`  - ${d.symbol} from ${describeUsers(s, d.definedIn)}`)
        out.push(`${a.path} defines ${dependents.length} symbol(s) used elsewhere:`)
        for (const d of dependents.slice(0, 40)) out.push(`  - ${d.symbol} used in ${describeUsers(s, d.usedIn)}`)
      } else return 'error: pass symbol or path'
      return out.join('\n')
    },
    async room_preview_merge(a) {
      const s = S()
      const person = typeof a.person === 'string' && a.person ? a.person : ''
      if (!person || person === s.me.name) return 'error: person is required (someone other than you)'
      const myBase = baseFor(s, s.me.name), theirBase = baseFor(s, person)
      let ancestor = myBase
      if (theirBase !== myBase) {
        try { ancestor = (await git(s.dir, ['merge-base', myBase, theirBase])).trim() }
        catch { return `error: ${person}'s HEAD ${theirBase.slice(0, 10)} is not in this clone; git fetch, then retry` }
      }
      const committedBetween = theirBase === myBase ? [] : (await git(s.dir, ['diff', '--name-only', ancestor, theirBase])).split('\n').filter(Boolean)
      const paths = Array.from(new Set([...s.room.changedPaths(s.me.name), ...s.room.changedPaths(person), ...committedBetween])).sort()
      if (!paths.length) return `neither you nor ${person} has changes relative to ${ancestor.slice(0, 10)}`
      const clean: string[] = [], conflicts: string[] = [], onlyOne: string[] = []
      const merged = new Map<string, string | null>() // path -> merged text, null = deleted
      for (const p of paths) {
        const b = (await gitShow(s.dir, ancestor, p)) ?? ''
        const m = await liveText(s, p, s.me.name), t = await liveText(s, p, person)
        const mineT = m === null ? '' : m ?? b, theirs = t === null ? '' : t ?? b
        if (mineT === b || theirs === b) {
          onlyOne.push(`${p} (${mineT === b ? person : 'you'} only)`)
          const side = mineT === b ? t : m
          merged.set(p, side === null ? null : side ?? b)
          continue
        }
        const res = diff3Merge(mineT.split('\n'), b.split('\n'), theirs.split('\n'))
        const hunks = res.filter(r => 'conflict' in r)
        if (!hunks.length) { clean.push(p); merged.set(p, res.flatMap(r => r.ok ?? []).join('\n')); continue }
        let line = 1
        const detail: string[] = []
        for (const r of res) {
          if (r.ok) { line += r.ok.length; continue }
          const c = r.conflict
          if (!c) continue
          detail.push(`  around line ${line}: you changed ${c.a.length} line(s), ${person} changed ${c.b.length} line(s)`)
          line += c.o.length
        }
        conflicts.push(`${p}\n${detail.join('\n')}`)
      }
      const out = [`preview merge of your changes with ${person}'s (common ancestor ${ancestor.slice(0, 10)}${theirBase !== myBase ? `; ${person} is on ${theirBase.slice(0, 10)}, you on ${myBase.slice(0, 10)}` : ''}):`]
      if (onlyOne.length) out.push(`touched by one side only (merge trivially): ${onlyOne.join(', ')}`)
      if (clean.length) out.push(`both changed, merge cleanly: ${clean.join(', ')}`)
      if (conflicts.length) out.push(`CONFLICTS:\n${conflicts.join('\n')}`)
      else out.push('no conflicts')
      const run = typeof a.run === 'string' && a.run.trim() ? a.run.trim() : ''
      if (run) {
        if (conflicts.length) out.push(`not running "${run}": resolve the conflicts first`)
        else out.push(await runInMergedTree(s, ancestor, merged, run))
      }
      return out.join('\n')
    },
  }

  return {
    list: () => DEFS,
    attachHooks,
    clearStale: (s: Session) => cleanupMine(s, 'stale from an earlier session'),
    async shutdown() {
      const s = ctx.getSession()
      if (!s) return
      try { cleanupMine(s, 'session ended') } catch { /* best effort */ }
      ctx.setSession(null)
      bridge?.stop(); bridge = null
      await doLeave(s)
    },
    async call(name, args) {
      const h = handlers[name]
      if (!h) return `error: unknown tool ${name}`
      const s = ctx.getSession()
      if (s && !s.provider.synced && name !== 'room_leave') return 'error: room not synced yet, retry'
      if (s) observeClaims(s)
      try {
        const body = await h(args ?? {})
        const s2 = ctx.getSession()
        if (s2 && name !== 'room_join') s2.daemon.touch()
        return s2 && name !== 'room_join' ? inbox(s2) + body : body
      } catch (e) {
        if (e instanceof NotJoined) return 'error: not in a room. Call room_join first.'
        if (e instanceof NeedFetch) return `error: ${e.person}'s HEAD ${e.sha.slice(0, 10)} is not in this clone (${e.detail}); run git fetch, then retry`
        return `error: ${e instanceof Error ? e.message : String(e)}`
      }
    },
  }
}

class NotJoined extends Error {}

/** Materialise ancestor + merged files in a scratch dir (sharing .venv/node_modules from my clone) and run a command there. */
async function runInMergedTree(s: Session, ancestor: string, merged: Map<string, string | null>, cmd: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-merge-'))
  try {
    await new Promise<void>((resolve, reject) => {
      const p = execFile('sh', ['-c', `git -C "${s.dir}" archive ${ancestor} | tar -x -C "${dir}"`], { timeout: 60_000 }, err => err ? reject(err) : resolve())
      p.unref?.()
    })
    for (const [rel, text] of merged) {
      const abs = path.resolve(dir, rel)
      if (!abs.startsWith(dir)) continue
      if (text === null) { fs.rmSync(abs, { force: true }); continue }
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, text)
    }
    for (const shared of ['.venv', 'node_modules']) {
      const src = path.join(s.dir, shared)
      if (fs.existsSync(src) && !fs.existsSync(path.join(dir, shared))) fs.symlinkSync(src, path.join(dir, shared))
    }
    const result = await new Promise<{ code: number | null; out: string }>(resolve => {
      execFile('sh', ['-c', cmd], { cwd: dir, timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ROOM_MERGED_TREE: dir } }, (err, stdout, stderr) => {
        const raw = err ? (err as { code?: unknown }).code : 0
        resolve({ code: typeof raw === 'number' ? raw : err ? 1 : 0, out: `${stdout}${stderr}` })
      })
    })
    const tail = result.out.trim().split('\n').slice(-25).join('\n')
    return `ran "${cmd}" in the merged tree (${merged.size} file(s) applied over ${ancestor.slice(0, 10)}): exit ${result.code}\n${tail}`
  } catch (e) {
    return `could not run in merged tree: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
class NeedFetch extends Error { constructor(public person: string, public sha: string, public detail: string) { super(detail) } }

function parsePlans(v: unknown): Plan[] | string {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) return 'error: plans must be an array'
  const out: Plan[] = []
  for (const x of v) {
    if (!x || typeof x !== 'object') return 'error: each plan needs kind and symbol'
    const o = x as Record<string, unknown>
    if (!['rename', 'signature', 'delete', 'add'].includes(String(o.kind)) || typeof o.symbol !== 'string' || !o.symbol) return 'error: each plan needs kind (rename|signature|delete|add) and symbol'
    out.push({ kind: o.kind as Plan['kind'], symbol: o.symbol, ...(typeof o.detail === 'string' && o.detail ? { detail: o.detail } : {}) })
  }
  return out
}

export { msgPaths }
