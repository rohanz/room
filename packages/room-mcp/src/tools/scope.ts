import { sharingDescription } from '../config.js'
import { checkoutPublisher, publisherLine } from './share.js'
import { claudeWakeNote } from '../prompt.js'
import { offlineSince } from '../connection.js'
import { sameCheckoutSession } from '../company.js'
import { coordinationPaths, neighbours, participantsView, manifestChangers, manifestKey, manifestPaths } from '@room/shared'
import { activityLabel, idleLabel, Areas, CODEOWNERS_PATHS, RoomDoc, areaMembershipSummary, claimLine as formatClaimLine, clampRange, claimInMyLines, claimsOverlap, describeClaim, displayName, participantIdentityLine, splitParticipants, formatMsg, formatPlans, isAgentic, msgPaths, otherAreasLine, personLine as formatPersonLine, rangesOverlap, scopeCovers, scopeLine as formatScopeLine, sharesArea, summarizeFiles, workerLines as formatWorkerLines, type Claim, type Msg, type NoteMsg, type Scope, type ScopeMsg } from '@room/shared'
import { git, gitShow } from '@room/roomd/git'
import { workerChangedPaths } from '@room/roomd/baseline'
import { localWorkerView } from '../worker-projector.js'
import type { LocalWorker } from '../worker-status.js'
import { describeWhere } from '../choice.js'
import { parseServer, refreshBrowserUrl, type Session } from '../session.js'
import { LOCAL } from '../session.js'
import { isPrName } from '../prs.js'
import { trustedWorker, RO, RW, int, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'


export const defs: ToolDef[] = [
  { name: 'room_scope', annotations: RW, description: 'Declare your task and paths once when working with others.',
    inputSchema: { type: 'object', properties: { area: str('one word, lowercase'), summary: str('one line'), paths: strs('files or directories you expect to touch') }, required: ['area', 'summary', 'paths'] } },
  { name: 'room_state', annotations: RO, description: 'Show sharing, participants and overlapping work. Use path for file ownership, link for the browser URL.',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean' }, path: str('file ownership'), from: int('first line'), to: int('last line'), link: { type: 'boolean' } } } },
]

/** A stopped worker may have lost its overlay while its worktree still holds edits. */
async function workerChangedCount(s: Session, worker: LocalWorker, processGone: boolean): Promise<number> {
  const overlayCount = manifestPaths(s.room, worker.name).length
  const trusted = await trustedWorker(s, worker.name)
  if (!trusted) return overlayCount
  if (!processGone && trusted.status === 'running' && overlayCount > 0) return overlayCount
  try {
    return (await workerChangedPaths(trusted)).length
  } catch (error) {
    if (error instanceof Error && error.message.includes('timed out')) throw new Error(`worker ${worker.tag} changed-file count unavailable: ${error.message}`)
    return overlayCount // A removed or inaccessible worktree is still shown from room state.
  }
}

const formatRoomMessage = (s: Session, m: Msg): string => formatMsg(m, { scopes: s.room.allScopes(), messages: s.room.messages(), claims: s.room.openClaims() })

export function handlers(state: HandlerState): Record<string, Handler> {
  const { S, loadAreas, areasOf, areasFor, setPresence, scopeLine, areaLines, ledgerLines, rooms, others, presences, myAreas, inMyAreas, now, personLine, claimLine, isMe, waitingOn, msgInMyAreas, prLines, myWorkers, workerPaths, readText, lines, shareOf } = state
  const pathState: Handler = async a => {
      const s = S()
      if (typeof a.path !== 'string' || !a.path) return 'error: path is required'
      const p = a.path
      const t = await readText(s, p, s.me.name)
      const n = t ? lines(t) : 1
      const r = clampRange(Number(a.from ?? 1), Number(a.to ?? n), n)
      const out: string[] = []
      // Workers in the local workers room hold their own claims and scopes there: show both rooms.
      const inRooms = [s, ...rooms.all().filter(x => x !== s)]
      const tagged = (x: Session, line: string) => x === s ? line : `${line} (workers room)`
      const who = new Map<string, 'shared' | 'not shared'>()
      for (const x of inRooms) {
        const nb = neighbours(participantsView(x.room, x.awareness, now()), s.me.name)
        for (const c of x.room.openClaims()) {
          if (c.by !== s.me.name && !nb.has(c.by)) continue
          // A teammate's line claim is in their text: map it into mine (reporooms §B6).
          if (c.path !== p || c.by === s.me.name || typeof t !== 'string') {
            if (claimsOverlap(c, { path: p, ...r })) out.push(tagged(x, `claim ${c.id}: ${describeClaim(c)}`))
            continue
          }
          const theirs = await readText(x, p, c.by).catch(() => undefined)
          const mapped = claimInMyLines(c, theirs ?? undefined, t)
          if (!rangesOverlap(mapped.from, mapped.to, r.from, r.to)) continue
          const moved = mapped.approximate ? ` (your lines ${mapped.from}-${mapped.to}, approximate)` : mapped.from !== c.from || mapped.to !== c.to ? ` (your lines ${mapped.from}-${mapped.to})` : ''
          out.push(tagged(x, `claim ${c.id}: ${describeClaim(c)}${moved}`))
        }
        for (const sc of x.room.allScopes()) if ((nb.has(sc.by) || isPrName(sc.by)) && scopeCovers(sc, p)) out.push(tagged(x, `scope: ${sc.by} is on ${scopeLine(sc)}`))
        for (const n of manifestChangers(x.room, p)) if (nb.has(n) && !sameCheckoutSession(s, n)) {
          const fence = x.room.manifestHead.get(n)?.fence
          const entry = fence ? x.room.manifest.get(manifestKey(n, fence))?.get(p) : undefined
          who.set(n, entry?.state === 'shared' ? 'shared' : 'not shared')
        }
      }
      if (who.size) out.push(`uncommitted changes by: ${[...who].sort(([a], [b]) => a.localeCompare(b)).map(([n, state]) => `${n} (${state})`).join(', ')}`)
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
      const areas = areasOf(s).areasOf([...paths, ...manifestPaths(s.room, s.me.name)])
      s.room.setScope({ by: s.me.name, byKind: s.me.kind, area, summary, paths, areas })
      await s.policyStore.declare(paths)
      await rooms?.project?.()
      const posted = await s.post<ScopeMsg>(s.me, { type: 'scope', area, summary, paths })
      setPresence(s, { status: `on ${area}: ${summary}`, areas })
      const out = [`scope set: ${scopeLine({ area, summary, paths } as Scope)}`, ...posted.ok ? [] : [`scope notice ${posted.text}`]]
      out.push(...areaLines(s, areas))
      const nb = neighbours(participantsView(s.room, s.awareness, now()), s.me.name)
      const overlapping = s.room.allScopes().filter(sc => (nb.has(sc.by) || isPrName(sc.by)) && paths.some(p => scopeCovers(sc, p) || sc.paths.some(q => scopeCovers({ paths }, q))))
      for (const sc of overlapping) out.push(`overlaps ${sc.by}'s scope ${scopeLine(sc)} — coordinate before touching shared files`)
      out.push(...ledgerLines(s, { area, limit: 20 }, area, posted.msg.id))
      return out.join('\n')
    },
    async room_state(a) {
      const s = S()
      await loadAreas(s)
      const m = s.room.meta
      const publisher = publisherLine(s)
      const people = new Set(presences(s).filter(p => p.user.name !== s.me.name && !sameCheckoutSession(s, p.user.name) && !isPrName(p.user.name)).map(p => p.user.owner ?? p.user.name)).size
      const out: string[] = [s.local ? 'local: nothing leaves this machine' : publisher
        ? `team room: ${publisher} (${people} other people in the room)`
        : `team room: sharing ${sharingDescription(shareOf(s, s.me.name))} with ${people} people`]
      if (s.local && publisher) out.push(publisher)
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
      const myPaths = [...(s.room.scope(s.me.name)?.paths ?? []), ...manifestPaths(s.room, s.me.name), ...myClaims.map(c => c.path)]
      const overlapsMyPath = (p: string) => myPaths.some(q => scopeCovers({ paths: [q] }, p) || scopeCovers({ paths: [p] }, q))
      const pathInView = (p: string) => all || overlapsMyPath(p) || mineA.includes(areasOf(s).areaOf(p))
      const nb = neighbours(participantsView(s.room, s.awareness, now()), s.me.name)
      const nearby = coordinationPaths(s.room, nb, s.me.name)
      const inView = (person: string) => {
        if (all || person === s.me.name || sameCheckoutSession(s, person)) return true
        if (nearby.some(entry => entry.by === person && entry.reason !== 'claim' && overlapsMyPath(entry.path))) return true
        const theirs = s.room.openClaims().filter(c => c.by === person)
        return theirs.some(c => myClaims.some(m => claimsOverlap(c, m)))
      }
      const groups = splitParticipants({
        presences: ps, workers: s.room.acceptedWorkerViews(), retiredWorkers: s.room.retiredWorkers(),
        scopes: [...s.room.scopes.entries()], overlayPeople: [...s.room.manifestHead.keys()],
        changesByPerson: new Map(), claims: s.room.openClaims(), now: now(),
      })
      const retiredNames = new Set(s.room.retiredWorkers().map(worker => worker.name))
      const everyone = [s.me.name, ...nb.names().filter(name => !retiredNames.has(name) || s.room.acceptedWorkerViewOf(name))].sort()
      const names = everyone.filter(inView)
      const hidden = everyone.filter(n => !inView(n))
      const activeCount = groups.active.filter(p => names.includes(p.name)).length
      const offlineCount = groups.offlineTeammates.filter(p => names.includes(p.name)).length
      out.push(all ? `areas: ${mineA.length ? mineA.join(', ') : 'none yet'} (showing all)` : `your areas: ${mineA.join(', ')} (room_state all=true for everything)`)
      out.push(`participants${all ? '' : ' overlapping your work'} (${activeCount} active${offlineCount ? `, ${offlineCount} offline teammate${offlineCount === 1 ? '' : 's'}` : ''}):`)
      for (const n of names) {
        const p = ps.find(x => x.user.name === n && isAgentic(x.user.kind)) ?? ps.find(x => x.user.name === n)
        const worker = s.room.acceptedWorkerViewOf(n)
        const own = worker && myWorkers(s).find(w => w.id === worker.id)
        const idle = p && !worker ? idleLabel(p.idleMin, s.room.openClaims().filter(c => c.by === n).length) : undefined
        const ago = idle ?? (p || worker ? activityLabel(p?.lastActive, now(), { worker, processGone: !!own && !state.workerAlive(s, own) }) : 'offline')
        const who = participantIdentityLine(ps, n, worker, s.room.scope(n)?.byKind ?? s.room.openClaims().find(c => c.by === n)?.byKind)
        if (sameCheckoutSession(s, n)) {
          const declaredScope = s.room.scope(n)
          out.push(`  - ${who}: another session in this checkout${n === checkoutPublisher(s) ? '; publishes this checkout' : ''}${declaredScope ? `; scope ${scopeLine(declaredScope)}` : ''} · ${ago}`)
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
      const areaScopes = s.room.allScopes().filter(sc => nb.has(sc.by) && (all || inView(sc.by)) || sc.by === s.me.name)
      const summary = s.room.areaSummary().filter(l => areaScopes.some(sc => l.startsWith(`${sc.area} (`)))
      if (summary.length) { out.push('activity by scope area:'); for (const l of summary) out.push(`  - ${l}`) }
      const cs = s.room.openClaims().filter(c => c.by === s.me.name || nb.has(c.by))
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
          ? [...new Set([s.me.name, ...presences(s).map(p => p.user.name).filter(n => sameCheckoutSession(s, n))].flatMap(n => manifestPaths(s.room, n)))]
          : manifestPaths(s.room, person)
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
      for (const x of msgs) out.push(`  - [${x.id}] ${formatRoomMessage(s, x)}`)
      out.push(...prLines(s)) // open PRs targeting this branch: intent from GitHub, never filtered by area
      out.push(...formatWorkerLines(await Promise.all(myWorkers(s).flatMap(worker => { const view = localWorkerView(s, worker.id); return view ? [{ worker, view }] : [] }).map(async ({ worker, view }) => { const processGone = worker.status === 'running' && !state.workerAlive(s, worker); return { worker: view, dir: worker.dir, lastActive: presences(s).filter(p => p.user.name === worker.name).reduce((at, p) => Math.max(at, p.lastActive ?? 0), worker.startedAt), processGone, changedCount: await workerChangedCount(s, worker, processGone), last: (() => { const message = s.room.messages().filter(x => x.from === worker.name).slice(-1)[0]; return message ? formatRoomMessage(s, message) : undefined })(), now: now() } })), { all: a.all === true, retiredWorkers: s.room.retiredWorkers().filter(w => w.lead === s.me.name) }))
      const ws = wsRoom
      if (ws) {
        out.push(`workers room ${ws.roomName}: your team scope covers ${workerPaths().length} path(s) from these workers; their claims appear in the team room under your name`)
        out.push(...formatWorkerLines(await Promise.all(myWorkers(ws).flatMap(worker => { const view = localWorkerView(ws, worker.id); return view ? [{ worker, view }] : [] }).map(async ({ worker, view }) => { const processGone = worker.status === 'running' && !state.workerAlive(ws, worker); return { worker: view, dir: worker.dir, processGone, changedCount: await workerChangedCount(ws, worker, processGone), last: (() => { const message = ws.room.messages().filter(x => x.from === worker.name).slice(-1)[0]; return message ? formatRoomMessage(ws, message) : undefined })(), now: now() } })), { all: a.all === true, retiredWorkers: ws.room.retiredWorkers().filter(w => w.lead === ws.me.name) }))
      }
      return a.all === true ? out.join('\n') : compactState(out, summarizedClaims)
    },

  }
  return handlers
}


export function createAreas(deps: Pick<HandlerState, 'ctx' | 'log' | 'base' | 'presences' | 'others' | 'shareOf' | 'now' | 'isMe'>): Pick<HandlerState, 'loadAreas' | 'areasOf' | 'areasFor' | 'myAreas' | 'inMyAreas' | 'areaLines' | 'ownerHints' | 'msgInMyAreas' | 'claimLine' | 'ledgerLines' | 'scopeLine' | 'personLine'> {
  const { ctx, log, base, presences, others, shareOf, now, isMe } = deps
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
      if (person !== s.me.name && !neighbours(participantsView(s.room, s.awareness, now()), s.me.name).has(person)) return []
      const sc = s.room.scope(person)
      const paths = [...(sc?.paths ?? []), ...manifestPaths(s.room, person), ...(person === s.me.name ? presences(s).filter(p => sameCheckoutSession(s, p.user.name)).flatMap(p => manifestPaths(s.room, p.user.name)) : [])]
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
  const ledgerLines = (s: Session, q: NonNullable<Parameters<RoomDoc['ledger']>[0]>, label: string, excludeId?: string): string[] => {
      const entries = s.room.ledger({ ...q, limit: q.limit ?? 10 }).filter(m => m.id !== excludeId && !(m.to && m.to !== s.me.name && m.from !== s.me.name))
      const plans = s.room.openClaims().filter(c => c.plans?.length && !(c.by === s.me.name) && (q.path ? c.path === q.path : true) && (q.area ? s.room.allScopes().some(sc => sc.area === q.area && scopeCovers(sc, c.path)) : true))
      const out = [`${label} ledger (${entries.length}):`]
      for (const m of entries) out.push(`  - ${new Date(m.at).toISOString().slice(11, 19)} ${formatRoomMessage(s, m)}`)
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
          ? [...new Set([name, ...presences(s).map(p => p.user.name).filter(n => sameCheckoutSession(s, n))].flatMap(n => manifestPaths(s.room, n)))]
          : manifestPaths(s.room, name),
        messages: s.room.messages().filter((m): m is NoteMsg => m.type === 'note'),
        share: shareOf(s, name),
        heldCount: (() => { const head = s.room.manifestHead.get(name); return head ? [...s.room.manifest.get(`${name}\u0000${head.fence}`)?.values() ?? []].filter(entry => entry.fence === head.fence && entry.state === 'held').length : 0 })(),
        excludedCount: s.room.manifestHead.get(name)?.excluded.length ?? 0,
      })
    }
  return { loadAreas, areasOf, areasFor, myAreas, inMyAreas, areaLines, ownerHints, msgInMyAreas, claimLine, ledgerLines, scopeLine, personLine }
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
