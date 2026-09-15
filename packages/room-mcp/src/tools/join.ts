import { displayName, type NoteMsg } from '@room/shared'
import { clearChoice, chooseServer, describeWhere, markWarned, writeChoice } from '../choice.js'
import { getCredential, getPending, setPending } from '../credentials.js'
import { LOCAL, logout as doLogout, parseServer, pollLogin, refreshBrowserUrl, serverAuthConfig, startLogin } from '../session.js'
import { SHARE, RO, RW, int, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'

export const defs: ToolDef[] = [
  { name: 'room_login', annotations: RW, description: 'Log in to the room server. GitHub (device flow): the first call returns a one-time code and URL. OIDC (self-hosted servers with a company identity provider): the first call returns a URL to open. Show them to the user VERBATIM. Call again to wait for the login to confirm (blocks up to `wait` seconds, default 90; call again if still pending). Never ask the user for a token. Your participant name becomes your login (GitHub login or email).',
    inputSchema: { type: 'object', properties: { provider: { type: 'string', enum: ['github', 'oidc'], description: 'login provider (default: the server\'s first; github.com rooms need github)' }, wait: int('seconds to wait for confirmation on a follow-up call (default 90, max 600)'), server: str('override ws server URL') } } },
  { name: 'room_logout', annotations: RW, description: 'Forget the GitHub login for the room server on this machine (and revoke the session on the server).',
    inputSchema: { type: 'object', properties: { server: str('override ws server URL') } } },
  { name: 'room_create', annotations: RW, description: 'Open a room for this repo on the server, then join the room for the current branch. Do this once per repo (any teammate can); after that every branch of the repo has a room and sessions join automatically. Idempotent: on an already-open repo it just joins.',
    inputSchema: { type: 'object', properties: { room: str('override room name (default: <host/owner/repo>/<branch>)'), name: str('override your name'), server: str('override ws server URL'), dir: str('clone directory (default: cwd)'), share: SHARE } } },
  { name: 'room_join', annotations: RW, description: 'Join a room for this clone. where=local: a room on this machine only (no server, no login; the default). where=team: the team server (the user must ask for this: their uncommitted work in this clone becomes visible to the repo\'s room members); remembered for this clone so later sessions go there on their own. A ws(s) URL is a self-hosted server. Precedence: where > ROOM_SERVER > remembered choice > local. Returns who is here, their scopes, open claims, and the browser view URL. On a team server, fails if nobody has opened a room for the repo yet: room_create does that.',
    inputSchema: { type: 'object', properties: { where: str('local | team | ws(s)://server'), room: str('override room name (default: <host/owner/repo>/<branch>)'), name: str('override your name'), server: str('alias of where for a server URL'), dir: str('clone directory (default: cwd)'), share: SHARE } } },
  { name: 'room_leave', annotations: RW, description: 'Leave the room: releases your claims, clears your scope, stops the daemon (and the local workers room, if you opened one). Refused while workers you spawned are still running unless force=true, which dismisses them first. forget=true also clears the remembered room choice for this clone, so the next session starts local again.',
    inputSchema: { type: 'object', properties: { forget: { type: 'boolean', description: 'also forget the remembered choice (local/team) for this clone' }, force: { type: 'boolean', description: 'dismiss running workers first instead of refusing' } } } },
  { name: 'room_close', annotations: { ...RW, destructiveHint: true, idempotentHint: false }, description: 'DESTRUCTIVE: close the room for this whole repo, for everyone. Every branch room of the repo is removed from the server along with all uncommitted work people have shared into it, and every teammate is disconnected. Nothing in any clone changes. Only on the user\'s explicit request; room_create reopens later.',
    inputSchema: { type: 'object', properties: { confirm: { type: 'boolean', description: 'must be true' } }, required: ['confirm'] } }
]

export function handlers(state: HandlerState): Record<string, Handler> {
  const { ctx, S, serverOf, LOCAL_LOGIN, codeLine, doJoin, seen, rooms, cleanupMine, log, evictStale, loadAreas, shareLine, others, presences, myAreas, setPresence, areaLines, personLine, claimLine, runningWorkers, dismissWorker, closeWorkersRoom, doLeave, doClose } = state
  const handlers: Record<string, Handler> = {
    async room_login(a) {
      const server = serverOf(a)
      if (server === LOCAL) return LOCAL_LOGIN
      const cfg = await serverAuthConfig(server)
      if (!cfg.providers.length) return `${server} has no login provider; it accepts your local gh credentials (or a shared token), nothing to do`
      const provider = a.provider === 'github' || a.provider === 'oidc' ? a.provider : undefined
      if (provider && !cfg.providers.includes(provider)) return `${server} does not offer ${provider} login (available: ${cfg.providers.join(', ')})`
      const cred = getCredential(server)
      const pending = getPending(server)
      if (cred && !pending) return `already logged in to ${server} as ${cred.login}; room_logout to switch accounts`
      if (pending && (!provider || provider === pending.provider)) {
        const wait = Math.min(600, Math.max(5, typeof a.wait === 'number' ? a.wait : 90))
        const r = await pollLogin(server, pending, { maxMs: wait * 1000 })
        if ('login' in r) { setPending(server, undefined); return `logged in to ${server} as ${r.login}. ${ctx.getSession() ? '' : 'Next: room_join (or room_create if nobody has opened this repo).'}`.trim() }
        if ('error' in r) { setPending(server, undefined); return `login failed: ${r.error}. Call room_login to start again.` }
        return `still waiting: ${codeLine(pending)}`
      }
      const p = await startLogin(server, provider)
      setPending(server, { ...p, startedAt: Date.now() })
      return `${p.provider === 'oidc' ? 'Single sign-on' : 'GitHub'} login for ${server}. Tell the user exactly this: ${codeLine(p)}`
    },
    async room_logout(a) {
      const server = serverOf(a)
      if (server === LOCAL) return LOCAL_LOGIN
      setPending(server, undefined)
      const r = await doLogout(server)
      return r.removed ? `logged out of ${server}${r.login ? ` (was ${r.login})` : ''}${ctx.getSession() ? '; the current session stays connected until room_leave' : ''}` : `no login stored for ${server}`
    },
    async room_create(a) { return handlers.room_join({ ...a, create: true }) },
    async room_join(a) {
      const cur = ctx.getSession()
      if (cur) return `already in ${cur.roomName} as ${displayName(cur.me)}; room_leave first to switch`
      const dir = typeof a.dir === 'string' && a.dir ? a.dir : ctx.cwd
      const whereArg = typeof a.where === 'string' && a.where ? a.where : typeof a.server === 'string' && a.server ? a.server : undefined
      const choice = await chooseServer(dir, whereArg, process.env.ROOM_SERVER)
      if (a.create === true && choice.server === LOCAL && choice.rule !== 'argument') {
        // room_create with nothing chosen: opening a repo needs a server, and that is the team room.
        return 'room_create needs a server: call room_create with where="team" (the user must ask for it), or set ROOM_SERVER. With nothing configured this clone is in a local room, which needs no opening.'
      }
      const s = await doJoin({
        dir,
        name: typeof a.name === 'string' && a.name ? a.name : undefined,
        room: typeof a.room === 'string' && a.room ? a.room : undefined,
        server: choice.server,
        create: a.create === true,
        share: typeof a.share === 'string' && a.share ? a.share : undefined,
      })
      if (choice.rule === 'argument') { try { await writeChoice(dir, choice.where, s.me.name) } catch { /* not a repository? keep going */ } }
      for (const m of s.room.messages()) seen.add(m.id)
      rooms.add(s, 'primary')
      const stale = cleanupMine(s, 'stale from an earlier session')
      if (stale || s.room.scope(s.me.name)) log(`cleared ${stale} stale claim(s) and scope from an earlier session`)
      evictStale(s)
      await loadAreas(s)
      const out = [`${a.create && !s.local ? 'opened and joined' : 'joined'} ${s.roomName} as ${displayName(s.me)} (base ${(s.room.meta.base ?? '?').slice(0, 10)}, clone ${s.dir})`]
      // Never print a shared token: the chosen server may carry one as ?token=…
      out.push(`room: ${describeWhere(choice.server === LOCAL ? LOCAL : parseServer(choice.server).server)} — chosen by ${choice.rule === 'argument' ? 'your instruction (remembered for this clone)' : choice.rule === 'env' ? 'ROOM_SERVER' : choice.rule === 'remembered' ? 'the choice remembered for this clone (room_leave forget=true clears it)' : 'default'}`)
      if (!s.local && (choice.rule === 'argument' || choice.rule === 'remembered')) {
        const fresh = await markWarned(dir, s.dir).catch(() => true)
        if (fresh || choice.rule === 'argument') out.push(`note for your human: uncommitted work in this clone${choice.rule === 'remembered' ? ' (joined on the choice remembered for this repo)' : ''} is now visible to the members of ${s.roomName.slice(0, s.roomName.lastIndexOf('/'))}'s room.`)
      }
      if (s.local) out.push(`local room (no server): relay on ${s.local.url}${s.local.owned ? ' run by this session' : ''}. Only sessions on this machine in this clone or its worktrees can join; the browser view below is reachable from this machine only. ${a.create ? 'room_create needs a server: set ROOM_SERVER=hosted (or a URL) and call it again to open this repo for teammates.' : 'room_spawn dispatches worker agents into it; say "join the team room" (room_join where=team) to work with teammates instead.'}`)
      out.push(shareLine(s))
      const here = others(s).filter(n => presences(s).some(p => p.user.name === n))
      const mineA = myAreas(s)
      setPresence(s, { areas: mineA })
      out.push(...areaLines(s, mineA))
      out.push(here.length ? `here now: ${here.join(', ')}` : 'nobody else is here yet')
      for (const n of here) out.push(`  ${n}: ${personLine(s, n)}`)
      const away = others(s).filter(n => !here.includes(n) && s.room.changedPaths(n).length)
      for (const n of away) out.push(`  ${n} (offline): ${personLine(s, n)}`)
      const cs = s.room.openClaims()
      if (cs.length) { out.push(`open claims (${cs.length}):`); for (const c of cs) out.push(claimLine(s, c)) }
      out.push(`browser view: ${await refreshBrowserUrl(s)}`)
      out.push('next: room_scope(area, summary, paths) before you edit.')
      return out.join('\n')
    },
    async room_leave(a) {
      const s = S()
      const running = runningWorkers(s)
      if (running.length && a.force !== true) return `error: ${running.length} worker(s) still running: ${running.map(r => r.w.tag).join(', ')}. Wait for them (room_wait), room_dismiss them, or room_leave force=true to dismiss them all and leave.`
      for (const r of running) dismissWorker(r.s, r.w, 'the lead left the room')
      await closeWorkersRoom()
      const released = cleanupMine(s, 'left the room')
      rooms.remove(s)
      await doLeave(s)
      let forgot = ''
      if (a.forget === true) { const had = await clearChoice(s.dir).catch(() => false); forgot = had ? '; forgot the remembered room choice for this clone (next session starts local)' : '; nothing was remembered for this clone' }
      return `left ${s.roomName}; released ${released} claim(s)${forgot}`
    },
    async room_close(a) {
      const s = S()
      if (s.local) return 'this is a local room (no server): there is nothing to close. room_leave ends your session; the relay stops with the last session.'
      if (a.confirm !== true) return 'error: room_close removes every branch room of this repo and all shared uncommitted work for everyone; call with confirm=true only on the user\'s explicit request'
      const repo = s.roomName.slice(0, s.roomName.lastIndexOf('/'))
      await closeWorkersRoom()
      cleanupMine(s, 'closing the room')
      s.room.post<NoteMsg>(s.me, { type: 'note', text: `closing the room for ${repo}: every branch room and all shared work is being removed`, priority: 'interrupt' })
      rooms.remove(s)
      const closed = await doClose(s)
      await doLeave(s)
      return `closed ${repo} for everyone: removed ${closed.length ? closed.join(', ') : 'its rooms'}; room_create reopens it`
    }
  }
  return handlers
}
