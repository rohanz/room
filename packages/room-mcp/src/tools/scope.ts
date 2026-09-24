import { sharingDescription } from '../config.js'
import { claudeWakeNote } from '../prompt.js'
import { offlineSince } from '../connection.js'
import { sameCheckoutSession } from '../company.js'
import { activityLabel, Areas, CODEOWNERS_PATHS, RoomDoc, areaMembershipSummary, claimLine as formatClaimLine, clampRange, claimsOverlap, describeClaim, displayName, participantIdentityLine, splitParticipants, formatMsg, formatPlans, isAgentic, msgPaths, otherAreasLine, personLine as formatPersonLine, rangesOverlap, scopeCovers, scopeLine as formatScopeLine, sharesArea, summarizeFiles, workerLines as formatWorkerLines, type Claim, type Msg, type NoteMsg, type Scope, type ScopeMsg } from '@room/shared'
import { git, gitShow } from '@room/roomd/git'
import { workerChangedPaths } from '@room/roomd/baseline'
import { describeWhere } from '../choice.js'
import { parseServer, refreshBrowserUrl, type Session } from '../session.js'
import { LOCAL } from '../session.js'
import { isPrName } from '../prs.js'
import { RO, RW, int, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'


export const defs: ToolDef[] = [
  { name: 'room_scope', annotations: RW, description: 'Declare your task and paths once when working with others.',
    inputSchema: { type: 'object', properties: { area: str('one word, lowercase'), summary: str('one line'), paths: strs('files or directories you expect to touch') }, required: ['area', 'summary', 'paths'] } },
  { name: 'room_state', annotations: RO, description: 'Show sharing, participants and overlapping work. Use path for file ownership, link for the browser URL.',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean' }, path: str('file ownership'), from: int('first line'), to: int('last line'), link: { type: 'boolean' } } } },
]

/** A stopped worker may have lost its overlay while its worktree still holds edits. */
async function workerChangedCount(s: Session, worker: import('@room/shared').Worker, processGone: boolean): Promise<number> {
  const overlayCount = s.room.changedPaths(worker.name).length
  if (!processGone && worker.status === 'running' && s.room.overlays.has(worker.name)) return overlayCount
  try {
    return (await workerChangedPaths(worker)).length
  } catch (error) {
    if (error instanceof Error && error.message.includes('timed out')) throw new Error(`worker ${worker.tag} changed-file count unavailable: ${error.message}`)
    return overlayCount // A removed or inaccessible worktree is still shown from room state.
  }
}

export function handlers(state: HandlerState): Record<string, Handler> {
  const { S, loadAreas, areasOf, areasFor, setPresence, scopeLine, areaLines, ledgerLines, rooms, others, presences, myAreas, inMyAreas, now, personLine, claimLine, isMe, waitingOn, msgInMyAreas, prLines, myWorkers, workerPaths, liveText, lines, shareOf } = state
  const pathState: Handler = async a => {
      const s = S()
      if (typeof a.path !== 'string' || !a.path) return 'error: path is required'
      const p = a.path
      const t = await liveText(s, p, s.me.name)
      const n = t ? lines(t) : 1
      const r = clampRange(Number(a.from ?? 1), Number(a.to ?? n), n)
      const out: string[] = []
      // Workers in the local workers room hold their own claims and scopes there: show both rooms.
      const inRooms = [s, ...rooms.all().filter(x => x !== s)]
      const tagged = (x: Session, line: string) => x === s ? line : `${line} (workers room)`
      const who = new Set<string>()
      for (const x of inRooms) {
        for (const c of x.room.openClaims()) if (claimsOverlap(c, { path: p, ...r })) out.push(tagged(x, `claim ${c.id}: ${describeClaim(c)}`))
        for (const sc of x.room.allScopes()) if (sc.by !== s.me.name && scopeCovers(sc, p)) out.push(tagged(x, `scope: ${sc.by} is on ${scopeLine(sc)}`))
        for (const n of x.room.whoChanged(p)) if (n !== s.me.name && !sameCheckoutSession(s, n)) who.add(n)
      }
      if (who.size) out.push(`uncommitted changes by: ${Array.from(who).sort().join(', ')}`)
      return out.length ? `${p}:${r.from}-${r.to}\n${out.join('\n')}` : `${p}:${r.from}-${r.to}: no claims, no scopes, nobody else has changed it`
  }
  const handlers: Record<string, Handler> = {
    async room_scope(a) {
      const s = S()
      const area = String(a.area ?? '').trim().toLowerCase().split(/\s+/)[0]
      const summary = String(a.summary ?? '').trim()
      const paths = Array.isArray(a.paths) ? a.paths.filter((x): x is string => typeof x === 'string' && !!x) : []
      if (!area || !summary || !paths.length) return 'error: area, summary and paths are required'
      await loadAreas(s)
      const areas = areasOf(s).areasOf([...paths, ...s.room.changedPaths(s.me.name)])
      s.room.setScope({ by: s.me.name, byKind: s.me.kind, area, summary, paths, areas })
      s.room.post<ScopeMsg>(s.me, { type: 'scope', area, summary, paths })
      setPresence(s, { status: `on ${area}: ${summary}`, areas })
      const out = [`scope set: ${scopeLine({ area, summary, paths } as Scope)}`]
      out.push(...areaLines(s, areas))
      const overlapping = s.room.allScopes().filter(sc => sc.by !== s.me.name && paths.some(p => scopeCovers(sc, p) || sc.paths.some(q => scopeCovers({ paths }, q))))
      for (const sc of overlapping) out.push(`overlaps ${sc.by}'s scope ${scopeLine(sc)} — coordinate before touching shared files`)
      out.push(...ledgerLines(s, { area, limit: 20 }, area))
      return out.join('\n')
    },
    async room_state(a) {
      const s = S()
      await loadAreas(s)
      const m = s.room.meta
      const out: string[] = [s.local ? 'local: nothing leaves this machine' : `team room: sharing ${sharingDescription(shareOf(s, s.me.name))} with ${new Set(presences(s).filter(p => p.user.name !== s.me.name && !sameCheckoutSession(s, p.user.name) && !isPrName(p.user.name)).map(p => p.user.owner ?? p.user.name)).size} people`]
      if (state.hasCompany(s).company) {
        const wakeNote = claudeWakeNote(s, 'company')
        if (wakeNote) out.unshift(wakeNote)
      }
      if (typeof a.path === 'string' && a.path) { out.push(await pathState(a)); if (a.link === true) out.push(`browser view: ${await refreshBrowserUrl(s)}`); return out.join('\n') }
      const wsRoom = rooms.workers()
      const since = offlineSince(s, now)
      if (since !== undefined) {
        const server = s.local ? LOCAL : parseServer(s.roomUrl.slice(0, s.roomUrl.lastIndexOf('/'))).server
        out.push(`OFFLINE: not connected to ${server} since ${new Date(since).toISOString()}; showing the last known state in ${s.roomName}`)
      }
      out.push(`room: ${s.roomName} — ${describeWhere(s.local ? LOCAL : parseServer(s.roomUrl.slice(0, s.roomUrl.lastIndexOf('/'))).server)}${wsRoom ? `; workers room: local (${wsRoom.roomName}, this machine only)` : ''}`)
      const ps = presences(s)
      out.push(`you: ${participantIdentityLine(ps, s.me.name)} in ${s.roomName} (base ${(m.base ?? '?').slice(0, 10)})`)
      // Folder-scoped view: only people, claims and changes in my areas, unless all=true (or I am in none yet).
      const mineA = myAreas(s)
      const all = a.all === true || !mineA.length
      const myClaims = s.room.openClaims().filter(c => c.by === s.me.name)
      const myPaths = [...(s.room.scope(s.me.name)?.paths ?? []), ...s.room.changedPaths(s.me.name), ...myClaims.map(c => c.path)]
      const overlapsMyPath = (p: string) => myPaths.some(q => scopeCovers({ paths: [q] }, p) || scopeCovers({ paths: [p] }, q))
      const pathInView = (p: string) => all || overlapsMyPath(p) || mineA.includes(areasOf(s).areaOf(p))
      const inView = (person: string) => {
        if (all || person === s.me.name || sameCheckoutSession(s, person)) return true
        const sc = s.room.scope(person)
        if (sc?.paths.some(overlapsMyPath)) return true
        const theirs = s.room.openClaims().filter(c => c.by === person)
        return theirs.some(c => myClaims.some(m => claimsOverlap(c, m)))
      }
      const groups = splitParticipants({
        presences: ps, workers: [...s.room.workers.values()], retiredWorkers: s.room.retiredWorkers(),
        scopes: [...s.room.scopes.entries()], overlayPeople: [...s.room.overlays.keys()],
        changesByPerson: new Map(), claims: s.room.openClaims(), now: now(),
      })
      const everyone = [...groups.active, ...groups.offlineTeammates].map(p => p.name).filter(n => !isPrName(n)).sort()
      const names = everyone.filter(inView)
      const hidden = everyone.filter(n => !inView(n))
      const activeCount = groups.active.filter(p => names.includes(p.name)).length
      const offlineCount = groups.offlineTeammates.filter(p => names.includes(p.name)).length
      out.push(all ? `areas: ${mineA.length ? mineA.join(', ') : 'none yet'} (showing all)` : `your areas: ${mineA.join(', ')} (room_state all=true for everything)`)
      out.push(`participants${all ? '' : ' overlapping your work'} (${activeCount} active${offlineCount ? `, ${offlineCount} offline teammate${offlineCount === 1 ? '' : 's'}` : ''}):`)
      for (const n of names) {
        const p = ps.find(x => x.user.name === n && isAgentic(x.user.kind)) ?? ps.find(x => x.user.name === n)
        const worker = s.room.workerOf(n)
        const ago = p || worker ? activityLabel(p?.lastActive, now(), { worker, processGone: worker !== undefined && !state.workerAlive(s, worker) }) : 'offline'
        const who = participantIdentityLine(ps, n, worker, s.room.scope(n)?.byKind ?? s.room.openClaims().find(c => c.by === n)?.byKind)
        if (sameCheckoutSession(s, n)) {
          const declaredScope = s.room.scope(n)
          out.push(`  - ${who}: another session in this checkout${declaredScope ? `; scope ${scopeLine(declaredScope)}` : ''} · ${ago}`)
          continue
        }
        const theirs = areasFor(s, n)
        const areaSummary = areaMembershipSummary(theirs)
        out.push(`  - ${who}${n === s.me.name ? ' (you)' : ''}: ${personLine(s, n)}${areaSummary ? ` · ${areaSummary}` : ''} · ${ago}`)
      }
      if (hidden.length) {
        const label = (name: string) => displayName({ name, kind: (ps.find(p => p.user.name === name && isAgentic(p.user.kind)) ?? ps.find(p => p.user.name === name))?.user.kind ?? s.room.scope(name)?.byKind ?? s.room.openClaims().find(c => c.by === name)?.byKind ?? 'human' })
        out.push(`  ${hidden.length} others: ${hidden.map(label).join(', ')} (all:true for detail)`)
      }
      if (a.link === true) out.push(`browser view: ${await refreshBrowserUrl(s)}`)
      const areaScopes = all ? s.room.allScopes() : s.room.allScopes().filter(sc => inView(sc.by))
      const summary = s.room.areaSummary().filter(l => areaScopes.some(sc => l.startsWith(`${sc.area} (`)))
      if (summary.length) { out.push('activity by scope area:'); for (const l of summary) out.push(`  - ${l}`) }
      const cs = s.room.openClaims()
      out.push(`open claims (${cs.length}):`)
      const byPerson = new Map<string, Claim[]>()
      for (const c of cs) { const claims = byPerson.get(c.by) ?? []; claims.push(c); byPerson.set(c.by, claims) }
      let summarizedClaims = 0
      for (const [person, claims] of [...byPerson].sort(([a], [b]) => a === s.me.name ? -1 : b === s.me.name ? 1 : a.localeCompare(b))) {
        const full = claims.filter(c => a.all === true || c.by === s.me.name || overlapsMyPath(c.path))
        const rest = claims.filter(c => !full.includes(c))
        out.push(`  ${person}: ${claims.length} claim(s)${rest.length ? ` · ${commonDirectory(rest.map(c => c.path))}` : ''}`)
        for (const c of full) out.push(claimLine(s, c))
        summarizedClaims += rest.length
      }
      const changed = new Map<string, string[]>()
      let hiddenChanged = 0
      for (const person of [s.me.name, ...others(s).filter(n => !sameCheckoutSession(s, n))]) {
        const paths = person === s.me.name
          ? [...new Set([s.me.name, ...presences(s).map(p => p.user.name).filter(n => sameCheckoutSession(s, n))].flatMap(n => s.room.changedPaths(n)))]
          : s.room.changedPaths(person)
        const ps2 = paths.filter(p => person === s.me.name || pathInView(p))
        hiddenChanged += paths.length - ps2.length
        if (ps2.length) changed.set(person, ps2)
      }
      out.push(`uncommitted changes${all ? '' : ' in your areas'}${hiddenChanged ? ` (${hiddenChanged} file${hiddenChanged === 1 ? '' : 's'} elsewhere)` : ''}:`)
      if (!changed.size) out.push('  (none)')
      for (const [person, ps2] of changed) {
        const files = summarizeFiles(ps2)
        out.push(`  - ${person}: ${files.count > 5
          ? `${files.count} files${files.dominant ? `, mostly ${files.dominant.folder} (${files.dominant.count})` : ''}: ${files.named.map(file => file.label).join(', ')} ...`
          : ps2.join(', ')}`)
      }
      const skipped = s.daemon.skipped?.() ?? { size: [], budget: [] }
      if (skipped.size.length) out.push(`  ${skipped.size.length} of your changed files are not shared: too large`)
      if (skipped.budget.length) out.push(`  ${skipped.budget.length} of your changed files are not shared: sharing budget exceeded`)
      const waits = await waitingOn(s)
      if (waits.length) { out.push('waiting on (others\' planned changes to symbols you use):'); out.push(...waits) }
      const msgs = s.room.lastMessages(all ? 10 : 30)
        .filter(x => !(x.to && x.to !== s.me.name && x.from !== s.me.name))
        .filter(x => all || x.to === s.me.name || x.from === s.me.name || x.type === 'base' || msgInMyAreas(s, x))
        .slice(-10)
      out.push(`recent bus${all ? '' : ' in your areas'} (${msgs.length}):`)
      for (const x of msgs) out.push(`  - [${x.id}] ${formatMsg(x)}`)
      out.push(...prLines(s)) // open PRs targeting this branch: intent from GitHub, never filtered by area
      out.push(...formatWorkerLines(await Promise.all(myWorkers(s).map(async worker => { const processGone = worker.status === 'running' && !state.workerAlive(s, worker); return { worker, lastActive: presences(s).filter(p => p.user.name === worker.name).reduce((at, p) => Math.max(at, p.lastActive ?? 0), worker.startedAt), processGone, changedCount: await workerChangedCount(s, worker, processGone), last: (() => { const message = s.room.messages().filter(x => x.from === worker.name).slice(-1)[0]; return message ? formatMsg(message) : undefined })(), now: now() } })), { all: a.all === true, retiredWorkers: s.room.retiredWorkers().filter(w => w.lead === s.me.name) }))
      const ws = wsRoom
      if (ws) {
        out.push(`workers room ${ws.roomName}: your team scope covers ${workerPaths().length} path(s) from these workers; their claims appear in the team room under your name`)
        out.push(...formatWorkerLines(await Promise.all(myWorkers(ws).map(async worker => { const processGone = worker.status === 'running' && !state.workerAlive(ws, worker); return { worker, processGone, changedCount: await workerChangedCount(ws, worker, processGone), last: (() => { const message = ws.room.messages().filter(x => x.from === worker.name).slice(-1)[0]; return message ? formatMsg(message) : undefined })(), now: now() } })), { all: a.all === true, retiredWorkers: ws.room.retiredWorkers().filter(w => w.lead === ws.me.name) }))
      }
      return a.all === true ? out.join('\n') : compactState(out, summarizedClaims)
    },

  }
  return handlers
}


export function install(state: HandlerState): void {
  const { ctx, log, base, presences, others, shareOf, now, isMe } = state
  const STALE_MS = (ctx.config?.staleDays ?? 7) * 24 * 60 * 60 * 1000
  const areaIndex = new WeakMap<Session, Areas>()
  const loadAreas = async (s: Session): Promise<Areas> => {
      const hit = areaIndex.get(s)
      if (hit) return hit
      let areas = Areas.topLevel()
      for (const p of CODEOWNERS_PATHS) {
        let text: string | undefined
        try { text = await gitShow(s.dir, base(s), p) } catch { text = undefined }
        if (text !== undefined) { areas = Areas.fromCodeowners(text); log(`areas from ${p}: ${areas.areas.join(', ') || '(none)'}`); break }
      }
      areaIndex.set(s, areas)
      return areas
    }
  const areasOf = (s: Session): Areas => areaIndex.get(s) ?? Areas.topLevel()
  const areasFor = (s: Session, person: string): string[] => {
      const sc = s.room.scope(person)
      const paths = [...(sc?.paths ?? []), ...s.room.changedPaths(person), ...(person === s.me.name ? presences(s).filter(p => sameCheckoutSession(s, p.user.name)).flatMap(p => s.room.changedPaths(p.user.name)) : [])]
      const stored = sc?.areas ?? presences(s).find(p => p.user.name === person)?.areas ?? []
      return Array.from(new Set([...stored, ...areasOf(s).areasOf(paths)])).sort()
    }
  const myAreas = (s: Session): string[] => areasFor(s, s.me.name)
  const inMyAreas = (s: Session, person: string): boolean => sharesArea(myAreas(s), areasFor(s, person))
  const alsoIn = (s: Session, areas: string[]): string[] => others(s).filter(n => !sameCheckoutSession(s, n))
      .map(n => ({ n, shared: areasFor(s, n).filter(a => areas.includes(a)) }))
      .filter(x => x.shared.length)
      .map(x => `${x.n} (${x.shared.join(', ')})`)
  const ownerHints = (s: Session, areas: string[]): string[] => {
      const ax = areasOf(s)
      const login = s.me.owner ?? s.me.name
      return areas.filter(a => ax.ownersOf(a).length && !ax.owns(login, a)).map(a => `owners of ${a}: ${ax.ownersOf(a).join(', ')} — not enforced; ask them if you change their contract`)
    }
  const areaLines = (s: Session, areas: string[]): string[] => {
      if (!areas.length) return ['areas: none yet (declare a scope or change a file)']
      const out = [`areas: ${areas.join(', ')} (${areasOf(s).source === 'codeowners' ? 'from CODEOWNERS' : 'top-level dirs; no CODEOWNERS'})`]
      const also = alsoIn(s, areas)
      out.push(also.length ? `also in your areas: ${also.join('; ')}` : 'nobody else is in your areas')
      out.push(...ownerHints(s, areas))
      return out
    }
  const msgInMyAreas = (s: Session, m: Msg): boolean => {
      const mineA = myAreas(s)
      if (!mineA.length) return true
      const paths = msgPaths(m)
      if (paths.length) return areasOf(s).areasOf(paths).some(a => mineA.includes(a))
      return sharesArea(mineA, areasFor(s, m.from))
    }
  const claimLine = (s: Session, c: Claim) => {
      const stale = !presences(s).some(p => p.user.name === c.by) && now() - c.at > STALE_MS
      return formatClaimLine(c, { yours: isMe(s, { name: c.by, kind: c.byKind }), stale })
    }
  const ledgerLines = (s: Session, q: NonNullable<Parameters<RoomDoc['ledger']>[0]>, label: string): string[] => {
      const entries = s.room.ledger({ ...q, limit: q.limit ?? 10 }).filter(m => !(m.to && m.to !== s.me.name && m.from !== s.me.name))
      const plans = s.room.openClaims().filter(c => c.plans?.length && !(c.by === s.me.name) && (q.path ? c.path === q.path : true) && (q.area ? s.room.allScopes().some(sc => sc.area === q.area && scopeCovers(sc, c.path)) : true))
      const out = [`${label} ledger (${entries.length}):`]
      for (const m of entries) out.push(`  - ${new Date(m.at).toISOString().slice(11, 19)} ${formatMsg(m)}`)
      if (plans.length) { out.push('open plans by others:'); for (const c of plans) out.push(`  - ${c.by}'s agent in ${c.path}: ${formatPlans(c.plans!)}`) }
      return out
    }
  const scopeLine = formatScopeLine
  const personLine = (s: Session, name: string): string => {
      return formatPersonLine({
        name,
        scope: s.room.scope(name),
        presences: presences(s),
        changedPaths: name === s.me.name
          ? [...new Set([name, ...presences(s).map(p => p.user.name).filter(n => sameCheckoutSession(s, n))].flatMap(n => s.room.changedPaths(n)))]
          : s.room.changedPaths(name),
        messages: s.room.messages().filter((m): m is NoteMsg => m.type === 'note'),
        share: shareOf(s, name),
      })
    }
  Object.assign(state, { loadAreas, areasOf, areasFor, myAreas, inMyAreas, areaLines, ownerHints, msgInMyAreas, claimLine, ledgerLines, scopeLine, personLine })
}

function commonDirectory(paths: string[]): string {
  const parts = paths.map(p => p.split('/').slice(0, -1))
  const prefix = parts[0] ?? []
  let n = 0
  while (n < prefix.length && parts.every(p => p[n] === prefix[n])) n++
  return n ? prefix.slice(0, n).join('/') + '/' : './'
}

function compactState(lines: string[], summarizedClaims: number): string {
  const max = 7800
  const kept: string[] = []
  let length = 0, omitted = 0
  for (const line of lines) {
    if (length + line.length + 1 > max) { omitted++; continue }
    kept.push(line); length += line.length + 1
  }
  if (omitted || summarizedClaims) kept.push(`omitted: ${summarizedClaims} unrelated claim details, ${omitted} state lines; room_state all=true for everything, room_state path=... for a path.`)
  return kept.join('\n')
}
