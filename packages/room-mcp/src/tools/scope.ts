import { clampRange, describeClaim, describeIdentity, displayName, formatMsg, isAgentic, rangesOverlap, scopeCovers, type Scope, type ScopeMsg } from '@room/shared'
import { describeWhere } from '../choice.js'
import { parseServer, refreshBrowserUrl, type Session } from '../session.js'
import { LOCAL } from '../session.js'
import { workerLines } from '../workers.js'
import { RO, RW, int, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'

export const defs: ToolDef[] = [
  { name: 'room_scope', annotations: RW, description: 'Declare what you are working on: a one-word area (e.g. "auth"), a one-line summary, and the paths you expect to touch. Do this before editing. Replaces your previous scope. The reply ends with the area ledger: what others changed there and their open plans.',
    inputSchema: { type: 'object', properties: { area: str('one word, lowercase'), summary: str('one line'), paths: strs('files or directories you expect to touch') }, required: ['area', 'summary', 'paths'] } },
  { name: 'room_state', annotations: RO, description: 'Room overview: who is here and on what, per-area activity, open claims with plans, files changed by whom, recent bus. Filtered to the areas you are in (your scope paths + changed paths; areas come from CODEOWNERS or top-level dirs) with one summary line for the rest; all=true shows everything. Call before editing and after any wait.',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'show every area, not just yours' } } } },
  { name: 'room_who', annotations: RO, description: 'Who holds claims in a region of a file, whose scope covers it, and who has changed the file.',
    inputSchema: { type: 'object', properties: { path: str('repo-relative path'), from: int('first line, default 1'), to: int('last line, default EOF') }, required: ['path'] } }
]

export function handlers(state: HandlerState): Record<string, Handler> {
  const { S, loadAreas, areasOf, areasFor, setPresence, scopeLine, areaLines, ledgerLines, rooms, others, presences, myAreas, inMyAreas, now, personLine, claimLine, isMe, waitingOn, msgInMyAreas, prLines, myWorkers, workerPaths, liveText, lines } = state
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
      const out: string[] = []
      const wsRoom = rooms.workers()
      out.push(`room: ${describeWhere(s.local ? LOCAL : parseServer(s.roomUrl.slice(0, s.roomUrl.lastIndexOf('/'))).server)}${wsRoom ? `; workers room: local (${wsRoom.roomName}, this machine only)` : ''}`)
      out.push(`you: ${displayName(s.me)} in ${s.roomName} (base ${(m.base ?? '?').slice(0, 10)})`)
      // Folder-scoped view: only people, claims and changes in my areas, unless all=true (or I am in none yet).
      const mineA = myAreas(s)
      const all = a.all === true || !mineA.length
      const ps = presences(s)
      const inView = (person: string) => all || person === s.me.name || inMyAreas(s, person)
      const pathInView = (p: string) => all || mineA.includes(areasOf(s).areaOf(p))
      const everyone = Array.from(new Set<string>([s.me.name, ...others(s)].filter(n => ps.some(p => p.user.name === n) || s.room.scopes.has(n)))).sort()
      const names = everyone.filter(inView)
      const hidden = everyone.filter(n => !inView(n))
      out.push(all ? `areas: ${mineA.length ? mineA.join(', ') : 'none yet'} (showing all)` : `your areas: ${mineA.join(', ')} (room_state all=true for everything)`)
      out.push(`participants${all ? '' : ' in your areas'} (${names.length}):`)
      for (const n of names) {
        const p = ps.find(x => x.user.name === n && isAgentic(x.user.kind)) ?? ps.find(x => x.user.name === n)
        const ago = p?.lastActive ? `active ${Math.max(0, Math.round((now() - p.lastActive) / 1000))}s ago` : 'offline'
        const who = p ? describeIdentity(p.user) : n
        const theirs = areasFor(s, n)
        out.push(`  - ${who}${n === s.me.name ? ' (you)' : ''}: ${personLine(s, n)}${theirs.length ? ` · areas ${theirs.join(', ')}` : ''} · ${ago}`)
      }
      if (hidden.length) {
        const otherAreas = new Set<string>()
        for (const n of hidden) for (const x of areasFor(s, n)) if (!mineA.includes(x)) otherAreas.add(x)
        out.push(`  ${hidden.length} other${hidden.length === 1 ? '' : 's'} in ${otherAreas.size} other area${otherAreas.size === 1 ? '' : 's'}${otherAreas.size ? ` (${Array.from(otherAreas).sort().join(', ')})` : ''}`)
      }
      out.push(`browser view: ${await refreshBrowserUrl(s)}`)
      const areaScopes = all ? s.room.allScopes() : s.room.allScopes().filter(sc => inView(sc.by))
      const summary = s.room.areaSummary().filter(l => areaScopes.some(sc => l.startsWith(`${sc.area} (`)))
      if (summary.length) { out.push('activity by scope area:'); for (const l of summary) out.push(`  - ${l}`) }
      const cs = s.room.openClaims().filter(c => pathInView(c.path) || isMe(s, { name: c.by, kind: c.byKind }))
      const hiddenClaims = s.room.openClaims().length - cs.length
      out.push(`open claims${all ? '' : ' in your areas'} (${cs.length}${hiddenClaims ? `, ${hiddenClaims} elsewhere` : ''}):`)
      for (const c of cs) out.push(claimLine(s, c))
      const changed = new Map<string, string[]>()
      let hiddenChanged = 0
      for (const person of [s.me.name, ...others(s)]) {
        const ps2 = s.room.changedPaths(person).filter(p => person === s.me.name || pathInView(p))
        hiddenChanged += s.room.changedPaths(person).length - ps2.length
        if (ps2.length) changed.set(person, ps2)
      }
      out.push(`uncommitted changes${all ? '' : ' in your areas'}${hiddenChanged ? ` (${hiddenChanged} file${hiddenChanged === 1 ? '' : 's'} elsewhere)` : ''}:`)
      if (!changed.size) out.push('  (none)')
      for (const [person, ps2] of changed) out.push(`  - ${person}: ${ps2.join(', ')}`)
      const waits = await waitingOn(s)
      if (waits.length) { out.push('waiting on (others\' planned changes to symbols you use):'); out.push(...waits) }
      const msgs = s.room.lastMessages(all ? 10 : 30)
        .filter(x => !(x.to && x.to !== s.me.name && x.from !== s.me.name))
        .filter(x => all || x.to === s.me.name || x.from === s.me.name || x.type === 'base' || msgInMyAreas(s, x))
        .slice(-10)
      out.push(`recent bus${all ? '' : ' in your areas'} (${msgs.length}):`)
      for (const x of msgs) out.push(`  - [${x.id}] ${formatMsg(x)}`)
      out.push(...prLines(s)) // open PRs targeting this branch: intent from GitHub, never filtered by area
      out.push(...workerLines(myWorkers(s), n => { const last = s.room.messages().filter(x => x.from === n).slice(-1)[0]; return last ? formatMsg(last) : undefined }, n => s.room.changedPaths(n).length, now()))
      const ws = wsRoom
      if (ws) {
        out.push(`workers room ${ws.roomName}: your team scope covers ${workerPaths().length} path(s) from these workers; their claims appear in the team room under your name`)
        out.push(...workerLines(myWorkers(ws), n => { const last = ws.room.messages().filter(x => x.from === n).slice(-1)[0]; return last ? formatMsg(last) : undefined }, n => ws.room.changedPaths(n).length, now()))
      }
      return out.join('\n')
    },
    async room_who(a) {
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
        for (const c of x.room.claimsFor(p)) if (rangesOverlap(c.from, c.to, r.from, r.to)) out.push(tagged(x, `claim ${c.id}: ${describeClaim(c)}`))
        for (const sc of x.room.allScopes()) if (sc.by !== s.me.name && scopeCovers(sc, p)) out.push(tagged(x, `scope: ${sc.by} is on ${scopeLine(sc)}`))
        for (const n of x.room.whoChanged(p)) if (n !== s.me.name) who.add(n)
      }
      if (who.size) out.push(`uncommitted changes by: ${Array.from(who).sort().join(', ')}`)
      return out.length ? `${p}:${r.from}-${r.to}\n${out.join('\n')}` : `${p}:${r.from}-${r.to}: no claims, no scopes, nobody else has changed it`
    }
  }
  return handlers
}
