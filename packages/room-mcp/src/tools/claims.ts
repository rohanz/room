import { ConflictWatcher } from '../conflicts.js'
import { git, gitShow } from '@room/roomd/git'
import type { Session } from '../session.js'
import { claimsOverlap, clampRange, describeClaim, displayName, formatPlans, scopeCovers, symbolRange, type Claim, type ClaimMsg, type ConflictMsg, type Plan, type PlanMsg, type ReleaseMsg } from '@room/shared'
import { PLANS, RO, RW, int, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'

export const defs: ToolDef[] = [
  { name: 'room_claim', annotations: RW, description: 'Claim what you are about to edit, saying what you will do: either a symbol (function/class name; the room resolves its line range) or a line range. Declare renames/signature changes in `plans` so anyone who uses those symbols is told now. Reports overlaps (posting a conflict). Returns claimId.',
    inputSchema: { type: 'object', properties: { path: str('repo-relative path'), symbol: str('function/class to claim (preferred over from/to)'), from: int('first line (if no symbol)'), to: int('last line (if no symbol)'), intent: str('what you are about to do'), plans: PLANS }, required: ['path', 'intent'] } },
  { name: 'room_release', annotations: RW, description: 'Release a claim with a summary of what you did. Plans whose symbol is not mentioned in the summary (or in `done`) are reported as not done.',
    inputSchema: { type: 'object', properties: { claimId: str('claim id'), summary: str('what changed, one line'), done: strs('symbols from your plans that you completed') }, required: ['claimId'] } }
]

export function handlers(state: HandlerState): Record<string, Handler> {
  const { S, liveText, lines, isMe, mine, planChanged, setPresence, describeUsers, loadAreas, ownerHints, areasOf, upgrade } = state
  const handlers: Record<string, Handler> = {
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
      await loadAreas(s)
      out.push(...ownerHints(s, [areasOf(s).areaOf(p)]))
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
    }
  }
  return handlers
}


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


export function install(state: HandlerState): void {
  const { conflictPairs, mine, log, ctx, liveText, baseFor, now } = state
  const observeClaims = (s: Session) => {
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
  const planChanged = (s: Session, c: Claim, plan: Plan, status: PlanMsg['status'], text: string, replacedBy?: Plan): string[] => {
      const deps = (c.msgId ? s.room.dependentsOf(c.msgId) : []).filter(p => p !== s.me.name)
      const base: Omit<PlanMsg, 'id' | 'at' | 'from' | 'fromKind' | 'priority'> = { type: 'plan', status, claimId: c.id, path: c.path, plan, text, ...(replacedBy ? { replacedBy } : {}) }
      const orig = s.room.post<PlanMsg>(s.me, base)
      for (const p of deps) s.room.post<PlanMsg>(s.me, { ...base, to: p, copyOf: orig.id })
      return deps.length ? [`plan ${status}: ${formatPlans([plan])} — told ${deps.map(d => `${d}'s agent`).join(', ')} (they were shown it)`] : [`plan ${status}: ${formatPlans([plan])} — nobody had been shown it`]
    }

  const startConflictWatcher = (s: import('../session.js').Session): ConflictWatcher => {
    const watcher = new ConflictWatcher({
      room: s.room, me: s.me, log, debounceMs: ctx.conflictDebounceMs,
      liveText: (p, person) => liveText(s, p, person),
      baseText: (sha, p) => gitShow(s.dir, sha, p),
      baseFor: person => baseFor(s, person),
      mergeBase: async (a, b) => (await git(s.dir, ['merge-base', a, b])).trim(),
      isPresent: person => Array.from(s.awareness.getStates().values()).some(state => state?.user?.name === person),
    })
    watcher.start()
    return watcher
  }
  Object.assign(state, { observeClaims, planChanged, startConflictWatcher })
}
