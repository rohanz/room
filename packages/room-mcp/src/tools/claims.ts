import { createWriteIntentReader } from '../hooks-bridge.js'
import { ConflictWatcher } from '../conflicts.js'
import { sameCheckoutSession } from '../company.js'
import { git, gitShow } from '@room/roomd/git'
import type { Session } from '../session.js'
import { ensureLanguages, parseFile } from '../parse/engine.js'
import { coversPath, nearPath, claimsOverlap, clampRange, describeClaim, displayName, formatPlans, scopeCovers, symbolRange, type Claim, type ClaimMsg, type ConflictMsg, type Plan, type PlanMsg, type NoteMsg, type ReleaseMsg } from '@room/shared'
import { PLANS, RO, RW, int, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'

export const defs: ToolDef[] = [
  { name: 'room_claim', annotations: RW, description: 'Claim only where another participant is near. Use a directory ending /, symbol, or lines. Declare public API plans.',
    inputSchema: { type: 'object', properties: { path: str('repo-relative path'), symbol: str('definition name'), from: int('first line'), to: int('last line'), intent: str('intent'), plans: PLANS }, required: ['path', 'intent'] } },
  { name: 'room_release', annotations: RW, description: 'Release early; room_done releases remaining claims. List completed plan symbols in done.',
    inputSchema: { type: 'object', properties: { claimId: str('claim id'), summary: str('what changed, one line'), done: strs('completed symbols') }, required: ['claimId'] } }
]

export function handlers(state: HandlerState): Record<string, Handler> {
  const { S, liveText, lines, isMe, mine, planChanged, setPresence, describeUsers, loadAreas, ownerHints, areasOf, upgrade } = state
  const handlers: Record<string, Handler> = {
    async room_claim(a) {
      const s = S()
      if (typeof a.path !== 'string' || !a.path) return 'error: path is required'
      if (typeof a.intent !== 'string' || !a.intent) return 'error: intent is required'
      const p = a.path, intent = a.intent
      const nearby = [
        ...s.room.allScopes().flatMap(sc => sc.paths.map(path => ({ by: sc.by, path, reason: 'scope' as const }))),
        ...s.room.openClaims().map(c => ({ by: c.by, path: c.path, reason: 'claim' as const })),
        ...[...new Set([...s.room.overlays.keys(), ...s.room.deleted.keys()])].flatMap(by => s.room.changedPaths(by).map(path => ({ by, path, reason: 'changed' as const }))),
      ]
      if (!nearPath(p, nearby.filter(entry => entry.by !== s.me.name && !sameCheckoutSession(s, entry.by))).length) return `${p}: no claim needed; nobody else is near this path`
      const plans = parsePlans(a.plans)
      if (typeof plans === 'string') return plans
      const directory = p.endsWith('/')
      if (directory && a.symbol) return 'error: directory claims do not take a symbol'
      if (directory) {
        const scopeHits = s.room.allScopes().flatMap(sc => sc.by === s.me.name || sameCheckoutSession(s, sc.by) ? [] : sc.paths
          .filter(path => coversPath(p, path)).map(path => `${sc.by}'s scope includes ${path}`))
        const claimHits = s.room.openClaims().flatMap(c => isMe(s, { name: c.by, kind: c.byKind }) || sameCheckoutSession(s, c.by) || !coversPath(p, c.path)
          ? [] : [`${c.by}'s claim includes ${c.path}`])
        const hits = [...scopeHits, ...claimHits]
        if (hits.length) return `cannot claim ${p}: it would cover another participant's declared work (${hits.join('; ')}). Claim narrower files instead.`
      }
      const t = directory ? undefined : await liveText(s, p, s.me.name)
      const isNew = t === undefined || t === null
      const n = isNew ? 1 : lines(t)
      let range: { from: number; to: number }
      const symbol = typeof a.symbol === 'string' && a.symbol.trim() ? a.symbol.trim() : undefined
      if (directory) {
        range = { from: 1, to: Number.MAX_SAFE_INTEGER }
      } else if (symbol) {
        if (!isNew) await ensureLanguages([p])
        const r0 = isNew ? undefined : symbolRange(p, t!, symbol, parseFile)
        if (!r0) return `error: could not find a definition of ${symbol} in ${p}; pass from/to instead`
        range = r0
      } else {
        if (!Number.isFinite(Number(a.from)) || !Number.isFinite(Number(a.to))) return 'error: pass symbol, or from and to'
        range = { from: Number(a.from), to: Number(a.to) }
      }
      const r = directory ? range : clampRange(range.from, range.to, n)
      const intentFull = symbol ? `${symbol}: ${intent}` : intent
      const overl = s.room.openClaims().filter(c => !isMe(s, { name: c.by, kind: c.byKind }) && !sameCheckoutSession(s, c.by) && claimsOverlap(c, { path: p, ...r }))
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
      const out = [`claimed ${claim.id}: ${describeClaim(claim)}${isNew && !directory ? ' (new file)' : ''}`]
      // A new plan on a symbol I already have an open plan for supersedes the old one.
      let superseded = 0
      for (const pl of plans) {
        for (const other of mine(s)) {
          if (other.id === claim.id) continue
          const old = other.plans?.find(x => x.symbol === pl.symbol && (x.kind !== pl.kind || x.detail !== pl.detail))
          if (old) {
            s.room.claims.set(other.id, { ...other, plans: other.plans!.filter(x => x !== old) })
            superseded++
          }
        }
      }
      if (superseded) s.room.post<NoteMsg>(s.me, { type: 'note', priority: 'fyi', text: `${s.me.name} superseded ${superseded} plan(s)` })
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

/** Quietly end an owner's selected claims; collection can retain the scope for ongoing work. */
export function releaseClaimsOnDone(s: Session, keep?: (claim: Claim) => boolean, name = s.me.name, clearScope = true): number {
  const released = s.room.openClaims().filter(c => c.by === name && c.byKind !== 'human' && !keep?.(c))
  s.room.doc.transact(() => {
    for (const c of released) s.room.removeClaim(c.id)
    const plans = released.reduce((n, c) => n + (c.plans?.length ?? 0), 0)
    if (released.length) s.room.post<NoteMsg>(s.me, { type: 'note', priority: 'fyi', text: `${name} released ${released.length} claim(s)${plans ? `; ended ${plans} plan(s)` : ''}` })
    if (clearScope) s.room.clearScope(name)
  }, s.me)
  return released.length
}

function postPlanChange(s: Session, c: Claim, plan: Plan, status: PlanMsg['status'], text: string, replacedBy?: Plan, priority?: PlanMsg['priority']): string[] {
  const deps = (c.msgId ? s.room.dependentsOf(c.msgId) : []).filter(p => p !== s.me.name)
  const base = { type: 'plan' as const, status, claimId: c.id, path: c.path, plan, text, ...(replacedBy ? { replacedBy } : {}), priority: priority ?? 'interrupt' }
  const orig = s.room.post<PlanMsg>(s.me, { ...base, priority: 'fyi' })
  for (const p of deps) s.room.post<PlanMsg>(s.me, { ...base, to: p, copyOf: orig.id })
  return deps.length ? [`plan ${status}: ${formatPlans([plan])} — told ${deps.map(d => `${d}'s agent`).join(', ')} (they were shown it)`] : [`plan ${status}: ${formatPlans([plan])} — nobody had been shown it`]
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
          if (!arrived || (arrived.by === s.me.name && arrived.byKind === s.me.kind) || sameCheckoutSession(s, arrived.by)) continue
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
  const planChanged = postPlanChange

  const startConflictWatcher = (s: import('../session.js').Session): ConflictWatcher => {
    const watcher = new ConflictWatcher({
      room: s.room, me: s.me, log, debounceMs: ctx.conflictDebounceMs,
      writeIntent: createWriteIntentReader(s.dir),
      coLocated: person => {
        const states = [...s.awareness.getStates().values()]
        const mine = s.awareness.getLocalState()?.watchedDirectory
        return !!mine && states.some(state => state?.user?.name === person && state.watchedDirectory === mine)
      },
      liveText: (p, person) => liveText(s, p, person),
      baseText: (sha, p) => gitShow(s.dir, sha, p),
      baseFor: person => baseFor(s, person),
      mergeBase: async (a, b) => (await git(s.dir, ['merge-base', a, b])).trim(),
      graph: () => s.graph?.graph,
      isPresent: person => Array.from(s.awareness.getStates().values()).some(state => state?.user?.name === person),
    })
    watcher.start()
    return watcher
  }
  Object.assign(state, { observeClaims, planChanged, startConflictWatcher })
}
