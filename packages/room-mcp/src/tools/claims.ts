import { ConflictSet } from '../conflict-set.js'
import { sameCheckoutSession } from '../company.js'
import { authorizesText, claimDigest } from '@room/roomd'
import type { Session } from '../session.js'
import { ensureLanguages, parseFile } from '../parse/engine.js'
import { coordinationPaths, neighbours, coversPath, nearPath, claimsOverlap, claimInMyLines, clampRange, describeClaim, displayName, formatPlans, scopeCovers, symbolRange, participantsView, snapshotPath, snapshotStillCurrent, versionOf, type Claim, type ClaimMsg, type Plan, type PlanMsg, type NoteMsg, type ReleaseMsg } from '@room/shared'
import { PLANS, RO, RW, int, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'
import { carriedFrom } from '../worker-registry.js'
import { readBoundedCheckoutText, readBoundedHistoricalText } from './disk-text.js'

export const defs: ToolDef[] = [
  { name: 'room_claim', annotations: RW, description: 'Claim only where another participant is near. File: symbol, or from and to (whole file: from=1, to=last line). Directory: path ending /. Declare public API plans.',
    inputSchema: { type: 'object', properties: { path: str('repo-relative path; directory ends /'), symbol: str('definition name, or from/to'), from: int('first line'), to: int('last line'), intent: str('intent'), plans: PLANS }, required: ['path', 'intent'] } },
  { name: 'room_release', annotations: RW, description: 'Release early; room_done releases remaining claims. List completed plan symbols in done.',
    inputSchema: { type: 'object', properties: { claimId: str('claim id'), summary: str('what changed, one line'), done: strs('completed symbols') }, required: ['claimId'] } }
]

export function handlers(state: HandlerState): Record<string, Handler> {
  const { S, readText, lines, isMe, mine, planChanged, setPresence, describeUsers, loadAreas, ownerHints, areasOf, upgrade } = state
  const handlers: Record<string, Handler> = {
    async room_claim(a) {
      const s = S()
      if (typeof a.path !== 'string' || !a.path) return 'error: path is required'
      if (typeof a.intent !== 'string' || !a.intent) return 'error: intent is required'
      const p = a.path, intent = a.intent
      const nb = neighbours(participantsView(s.room, s.awareness, Date.now()), s.me.name)
      const nearby = coordinationPaths(s.room, nb, s.me.name)
      if (!nearPath(p, nearby.filter(entry => entry.reason !== 'changed' || !sameCheckoutSession(s, entry.by))).length) return `${p}: no claim needed; nobody else is near this path`
      const plans = parsePlans(a.plans)
      if (typeof plans === 'string') return plans
      const directory = p.endsWith('/')
      if (directory && a.symbol) return 'error: directory claims do not take a symbol'
      if (directory) {
        const scopeHits = s.room.allScopes().flatMap(sc => sc.by === s.me.name || !nearby.some(n => n.by === sc.by && n.reason === 'scope') ? [] : sc.paths
          .filter(path => coversPath(p, path)).map(path => `${sc.by}'s scope includes ${path}`))
        const claimHits = s.room.openClaims().flatMap(c => isMe(s, { name: c.by, kind: c.byKind }) || !nb.has(c.by) || !coversPath(p, c.path)
          ? [] : [`${c.by}'s claim includes ${c.path}`])
        const hits = [...scopeHits, ...claimHits]
        if (hits.length) return `cannot claim ${p}: it would cover another participant's declared work (${hits.join('; ')}). Claim narrower files instead.`
      }
      const t = directory ? undefined : await readText(s, p, s.me.name)
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
        if (!Number.isFinite(Number(a.from)) || !Number.isFinite(Number(a.to))) return `error: file claims need symbol or both from and to; to claim all of ${p}, pass from=1 and to=<last line>`
        range = { from: Number(a.from), to: Number(a.to) }
      }
      const r = directory ? range : clampRange(range.from, range.to, n)
      const localDigest = !isNew && !directory ? claimDigest(t!, r.from, r.to) : undefined
      const claimedHash = authorizesText(s.policyStore.policy, p) ? localDigest : undefined
      const intentFull = symbol ? `${symbol}: ${intent}` : intent
      const claim = s.room.addClaim({ path: p, from: r.from, to: r.to, by: s.me.name, byKind: s.me.kind, intent: intentFull, ...(plans.length ? { plans } : {}), ...(claimedHash ? { claimedHash } : {}) }, s.me)
      if (localDigest) s.daemon.rememberClaimDigest(claim.id, localDigest)
      const posting = s.post<ClaimMsg>(s.me, { type: 'claim', claimId: claim.id, path: p, from_line: r.from, to_line: r.to, intent: intentFull, ...(plans.length ? { plans } : {}) })
      s.room.setClaimMsg(claim.id, posting.id)
      const posted = await posting
      await new ConflictSet(s, s.me.name, s, state.log, 0).reconcile('claim').catch(e => state.log(`claim conflicts: ${String(e)}`))
      s.daemon.touch()
      setPresence(s, { cursor: { path: p, from: r.from, to: r.to }, status: `editing ${symbol ?? `${p}:${r.from}-${r.to}`} — ${intent}` })
      const out = [`claimed ${claim.id}: ${describeClaim(claim)}${isNew && !directory ? ' (new file)' : ''}`, ...posted.ok ? [] : [`claim notice ${posted.text}`]]
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
      if (superseded) await s.post<NoteMsg>(s.me, { type: 'note', priority: 'fyi', text: `${s.me.name} superseded ${superseded} plan(s)` })
      const overlappingPaths = s.room.openClaims().filter(c => c.id !== claim.id && nb.has(c.by) &&
        !isMe(s, { name: c.by, kind: c.byKind }) &&
        claimsOverlap({ path: c.path, from: 1, to: Number.MAX_SAFE_INTEGER }, { path: p, from: 1, to: Number.MAX_SAFE_INTEGER }))
      const overlaps = (await Promise.all(overlappingPaths.map(async c => ({
        claim: c, range: await claimRangeInMyText(s, c, t ?? ''),
      })))).filter(({ claim: c, range }) => claimsOverlap({ path: c.path, ...range }, { path: p, ...r }))
      for (const { claim: o, range } of overlaps)
        out.push(`CONFLICT: overlaps ${o.id} (${describeClaim(o)}${range.approximate ? '; approximate lines' : ''}). Ask ${o.by}'s agent or wait for release.`)
      if (s.graph && plans.length) {
        await s.graph.ready
        for (const pl of plans) {
          const users = s.graph.graph.usersOf(pl.symbol)
          out.push(users.length ? `impact: ${pl.symbol} is used in ${users.length} file(s): ${describeUsers(s, users)}` : `impact: ${pl.symbol} has no other users in the indexed graph`)
        }
      }
      const scopesHit = s.room.allScopes().filter(sc => sc.by !== s.me.name && nearby.some(n => n.by === sc.by && n.reason === 'scope') && scopeCovers(sc, p))
      for (const sc of scopesHit) out.push(`note: ${p} is inside ${sc.by}'s scope (${sc.area}); they will be told of your plans`)
      await loadAreas(s)
      out.push(...ownerHints(s, [areasOf(s).areaOf(p)]))
      if (posted.ok) out.push(...await upgrade(s, posted.msg, [p], plans.map(x => x.symbol)))
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
      const posted = await s.post<ReleaseMsg>(s.me, { type: 'release', claimId: c.id, path: c.path, ...(summary ? { summary } : {}), ...(unfulfilled.length ? { unfulfilled } : {}) })
      s.daemon.touch()
      const next = mine(s)[0]
      setPresence(s, next
        ? { cursor: { path: next.path, from: next.from, to: next.to }, status: `editing ${next.path}:${next.from}-${next.to} — ${next.intent}` }
        : { cursor: undefined, status: s.room.scope(s.me.name) ? `on ${s.room.scope(s.me.name)!.area}` : 'idle' })
      const out = [`released ${c.id} (${c.path}:${c.from}-${c.to})${summary ? ` — ${summary}` : ''}`, ...posted.ok ? [] : [`release notice ${posted.text}`]]
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

/** A foreign claim names lines in its owner's text, not in this checkout. */
async function claimRangeInMyText(s: Session, claim: Claim, myText: string): Promise<{ from: number; to: number; approximate: boolean }> {
  if (claim.path.endsWith('/')) return { from: claim.from, to: claim.to, approximate: false }
  for (let attempt = 0; attempt < 2; attempt++) {
    const view = participantsView(s.room, s.awareness, Date.now())
    const raw = snapshotPath(s.room, claim.by, view, claim.path)
    const owner = raw?.head.publisher ? snapshotPath(s.room, raw.head.publisher, view, claim.path) : raw
    const version = await versionOf(owner, claim.path, {
      gitAt: (sha, path) => readBoundedHistoricalText(s.dir, sha, path),
      known: blob => readBoundedCheckoutText(s.dir, blob, claim.path, 'utf8', false).catch(() => undefined),
    })
    const currentView = participantsView(s.room, s.awareness, Date.now())
    if (raw && !snapshotStillCurrent(s.room, raw, currentView)) continue
    if (owner && owner !== raw && !snapshotStillCurrent(s.room, owner, currentView)) continue
    const ownerText = version.kind === 'text' ? version.text : version.kind === 'base' ? version.text : version.kind === 'deleted' ? '' : undefined
    return claimInMyLines(claim, ownerText, myText)
  }
  return claimInMyLines(claim, undefined, myText)
}

/** Quietly end an owner's selected claims; collection can retain the scope for ongoing work. The fyi note is posted, not awaited. */
export function releaseClaimsOnDone(s: Session, keep?: (claim: Claim) => boolean, name = s.me.name, clearScope = true): number {
  const released = s.room.openClaims().filter(c => c.by === name && c.byKind !== 'human' && !keep?.(c))
  s.room.doc.transact(() => {
    for (const c of released) s.room.removeClaim(c.id)
    if (clearScope) s.room.clearScope(name)
  }, s.me)
  const plans = released.reduce((n, c) => n + (c.plans?.length ?? 0), 0)
  if (released.length) void s.post<NoteMsg>(s.me, { type: 'note', priority: 'fyi', text: `${name} released ${released.length} claim(s)${plans ? `; ended ${plans} plan(s)` : ''}` })
  return released.length
}

function postPlanChange(s: Session, c: Claim, plan: Plan, status: PlanMsg['status'], text: string, replacedBy?: Plan, priority?: PlanMsg['priority']): string[] {
  const deps = (c.msgId ? s.room.dependentsOf(c.msgId) : []).filter(p => p !== s.me.name)
  const base = { type: 'plan' as const, status, claimId: c.id, path: c.path, plan, text, ...(replacedBy ? { replacedBy } : {}), priority: priority ?? 'interrupt' }
  // Ids are known before the hub answers, so the copies name the original; posts never throw.
  const orig = s.post<PlanMsg>(s.me, { ...base, priority: 'fyi' })
  for (const p of deps) void s.post<PlanMsg>(s.me, { ...base, to: p, copyOf: orig.id }, { auto: true })
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


export function createClaims(deps: Pick<HandlerState, 'log' | 'ctx'>): Pick<HandlerState, 'planChanged' | 'startConflictSet'> {
  const { log, ctx } = deps
  const planChanged = postPlanChange
  const startConflictSet = (s: Session): ConflictSet => {
    const set = new ConflictSet(s, s.me.name, s, log, ctx.conflictDebounceMs, person => carriedFrom(s.dir, person))
    set.start()
    return set
  }
  return { planChanged, startConflictSet }
}
