import { releaseClaimsOnDone } from './claims.js'
import { claudeWakeNote } from '../prompt.js'
import { roomNameParts, type Claim, type NoteMsg } from '@room/shared'
import { resolve } from 'node:path'
import { localRoomName } from '@room/roomd/local'
import { handlers as scopeHandlers } from './scope.js'
import { git } from '@room/roomd/git'
import { DEFAULT_SERVER, NoRoom, NotLoggedIn, deriveRoomName, normalizeLocalRoomName, resolveServer, type JoinOptions, type Session } from '../session.js'
import { displayName } from '@room/shared'
import { clearChoice, describeWhere, markWarned, writeChoice } from '../choice.js'
import { configureCredentials, getCredential, getPending, setPending } from '../credentials.js'
import { LOCAL, logout as doLogout, parseServer, pollLogin, refreshBrowserUrl, serverAuthConfig, startLogin } from '../session.js'
import { SHARE, RO, RW, int, str, type Handler, type HandlerState, type ToolDef } from './context.js'
import { resolveConfig, sharingDescription } from '../config.js'
import { handlers as shareHandlers } from './share.js'
import { exportRoomLedger } from '../prs.js'

export const defs: ToolDef[] = [
  { name: 'room_login', annotations: RW, description: 'Sign in; show the returned code/URL verbatim, then call again to wait. action=logout revokes and forgets the account.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['login', 'logout'] }, provider: { type: 'string', enum: ['github', 'oidc'] }, wait: int('wait seconds, default 90, max 600'), server: str('server URL'), credentials: str('credentials file') } } },
  { name: 'room_create', annotations: RW, description: 'Open this repo on a team server and join. confirm=true authorizes opening it for members with push access.',
    inputSchema: { type: 'object', properties: { confirm: { type: 'boolean' }, where: str('team | server URL'), room: str('room name override'), name: str('name override'), server: str('alias of where'), dir: str('clone; default cwd'), share: SHARE } } },
  { name: 'room_join', annotations: RW, description: 'Join local or a requested team server; remember explicit choices for this clone and its worktrees. Priority: argument, ROOM_SERVER, ROOM_URL, remembered, local.',
    inputSchema: { type: 'object', properties: { where: str('local | team | server URL'), room: str('room name override'), name: str('name override'), server: str('alias of where'), dir: str('clone; default cwd'), share: SHARE } } },
  { name: 'room_leave', annotations: RW, description: 'Leave and release your work claims. force dismisses running workers; forget clears this clone’s remembered destination.',
    inputSchema: { type: 'object', properties: { forget: { type: 'boolean' }, force: { type: 'boolean' } } } },
  { name: 'room_close', annotations: { ...RW, destructiveHint: true, idempotentHint: false }, description: 'On explicit request, export history then delete local room memory or all branch rooms for everyone on the team server. Leaves clone files intact.',
    inputSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] } },
  { name: 'room_export', annotations: RO, description: 'Write room history to a Markdown ledger.',
    inputSchema: { type: 'object', properties: { path: str('output; default .room/ledger/<room>-<timestamp>.md') } } }
]

const disclosures = new WeakMap<Session, { pending?: string; prepared?: Promise<void>; delivered?: boolean }>()

function sharingSentence(s: Session): string {
  const server = parseServer(s.roomUrl.slice(0, s.roomUrl.lastIndexOf('/'))).server
  const parts = roomNameParts(s.roomName)
  const repo = parts.branch ? s.roomName.slice(0, -(parts.branch.length + 1)) : s.roomName
  return `note for your human: this clone now shares ${sharingDescription(s.daemon.share ?? s.shareRequested ?? 'intent')} with members of ${repo} on ${server}; use room_share level=intent for plans only or level=declared to limit files to your declared area.`
}

/** Establish whether this session has a disclosure pending without consuming its one delivery. */
export async function prepareTeamSharingDisclosure(s: Session): Promise<void> {
  let state = disclosures.get(s)
  if (!state) { state = {}; disclosures.set(s, state) }
  if (state.prepared || state.delivered) return state.prepared
  state.prepared = (async () => {
    if (s.local) { state!.delivered = true; return }
    const server = parseServer(s.roomUrl.slice(0, s.roomUrl.lastIndexOf('/'))).server
    const share = s.daemon.share ?? s.shareRequested ?? 'intent'
    if (await markWarned(s.dir, s.dir, server, share).catch(() => true)) state!.pending = sharingSentence(s)
    else state!.delivered = true
  })()
  await state.prepared
}

/** The exact hook-context sentence, or nothing when this boundary needs no disclosure. */
export function pendingTeamSharingDisclosure(s: Session): string | undefined {
  return disclosures.get(s)?.pending
}

/** Mark a hook-delivered sentence so a later Room tool reply cannot repeat it. */
export function markTeamSharingDisclosureDelivered(s: Session): void {
  const state = disclosures.get(s) ?? {}
  delete state.pending
  state.delivered = true
  disclosures.set(s, state)
}

/** One human disclosure per worktree and destination, including automatic and solo joins. */
export async function teamSharingNote(s: Session): Promise<string | undefined> {
  await prepareTeamSharingDisclosure(s)
  const note = pendingTeamSharingDisclosure(s)
  if (note) markTeamSharingDisclosureDelivered(s)
  return note
}

/** Join s's room again as s did, without opening the repo again. */
export function rejoinOptions(s: Session, credentialsPath?: string): JoinOptions {
  return { dir: s.dir, credentialsPath, name: s.me.owner ?? s.me.name, tag: s.me.label, room: s.roomName, server: s.local ? LOCAL : s.roomUrl.slice(0, s.roomUrl.lastIndexOf('/')), share: s.shareRequested, token: s.token }
}

export function handlers(state: HandlerState): Record<string, Handler> {
  const { ctx, now, S, serverOf, LOCAL_LOGIN, codeLine, doJoin, seen, rooms, cleanupMine, log, evictStale, loadAreas, shareLine, hasCompany, others, presences, myAreas, setPresence, areaLines, personLine, claimLine, runningWorkers, dismissWorker, closeWorkersRoom, doLeave, doClose } = state
  async function configureLogin(a: Record<string, unknown>) {
    const config = await resolveConfig({ dir: ctx.cwd ?? process.cwd(), args: { credentials: typeof a.credentials === 'string' ? a.credentials : ctx.config?.credentialsPath } })
    configureCredentials(config.credentialsPath)
    ctx.config = { ...config, ...ctx.config, credentialsPath: config.credentialsPath }
  }
  const handlers: Record<string, Handler> = {
    async room_login(a) {
      await configureLogin(a)
      const server = serverOf(a)
      if (server === LOCAL) return LOCAL_LOGIN
      if (a.action === 'logout') {
        setPending(server, undefined)
        const r = await doLogout(server)
        return r.removed ? `logged out of ${server}${r.login ? ` (was ${r.login})` : ''}${ctx.getSession() ? '; the current session stays connected until room_leave' : ''}` : `no login stored for ${server}`
      }
      const cfg = await serverAuthConfig(server)
      if (!cfg.providers.length) return `${server} has no login provider: non-GitHub rooms are admitted by its shared token (or open), and github.com rooms cannot be joined there; nothing to log in to`
      const provider = a.provider === 'github' || a.provider === 'oidc' ? a.provider : undefined
      if (provider && !cfg.providers.includes(provider)) return `${server} does not offer ${provider} login (available: ${cfg.providers.join(', ')})`
      const cred = getCredential(server)
      const pending = getPending(server)
      if (cred && !pending) return `already logged in to ${server} as ${cred.login}; room_login action=logout to switch accounts`
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
    async room_create(a) { return handlers.room_join({ ...a, where: a.where ?? a.server ?? 'team', create: true }) },
    async room_join(a) {
      const cur = ctx.getSession()
      const currentReply = async () => {
        const sharing = a.share !== undefined ? await shareHandlers(state).room_share({ level: a.share }) : ''
        const note = cur ? await teamSharingNote(cur) : undefined
        return [note, sharing, await scopeHandlers(state).room_state({ link: cur ? state.hasCompany(cur).company : false })].filter(Boolean).join('\n')
      }
      if (cur && a.create !== true && a.where === undefined && a.server === undefined && a.room === undefined && a.dir === undefined) {
        return currentReply()
      }
      const dir = typeof a.dir === 'string' && a.dir ? a.dir : cur?.dir ?? ctx.cwd ?? process.cwd()
      const whereArg = typeof a.where === 'string' && a.where ? a.where : typeof a.server === 'string' && a.server ? a.server : undefined
      const resolved = await resolveConfig({ dir, env: process.env, args: { credentialsPath: ctx.config?.credentialsPath, where: whereArg, name: typeof a.name === 'string' ? a.name : undefined, room: typeof a.room === 'string' ? a.room : undefined, share: typeof a.share === 'string' ? a.share : undefined } })
      const choice = { server: resolved.server, where: resolved.where, rule: resolved.whereRule }
      const requestedRoom = typeof a.room === 'string' ? a.room : resolved.room
      const targetRoom = choice.server === LOCAL
        ? requestedRoom !== undefined ? normalizeLocalRoomName(requestedRoom) : await localRoomName(dir)
        : resolved.room ?? (await deriveRoomName(dir)).roomName
      if (cur) {
        const sameServer = choice.server === LOCAL ? !!cur.local
          : !cur.local && parseServer(choice.server).server === parseServer(cur.roomUrl.slice(0, cur.roomUrl.lastIndexOf('/'))).server
        if (sameServer && targetRoom === cur.roomName && resolve(dir) === cur.dir) {
          return currentReply()
        }
        const running = runningWorkers(cur)
        if (running.length) return `error: ${running.length} worker(s) are running in ${cur.roomName}; they would be left behind. Wait for them, room_collect(discard=true) them, or stay in this room.`
      }
      if (typeof a.name === 'string' && a.name.trim() && choice.server !== LOCAL) {
        const server = parseServer(choice.server).server
        const cfg = await serverAuthConfig(server)
        const login = cfg.mode === 'device' ? getCredential(server)?.login : undefined
        if (login) return `error: name is your GitHub login on this server (${login}); use ROOM_TAG for a second agent`
      }
      if (cur) {
        await closeWorkersRoom()
        cleanupMine(cur, 'moved to another room')
        rooms.remove(cur)
        await doLeave(cur)
      }
      let s: Session
      try { s = await doJoin({
        dir,
        credentialsPath: resolved.credentialsPath,
        name: resolved.name,
        room: choice.server === LOCAL ? targetRoom : resolved.room,
        server: choice.server,
        create: a.create === true,
        confirm: a.confirm === true,
        share: resolved.share,
      }) } catch (e) {
        if (e instanceof NotLoggedIn) return `error: not logged in to ${e.server}. Call room_login server=${JSON.stringify(e.server)}, show its code/URL, then call room_login with the same server again to wait; retry room_join where=${JSON.stringify(e.server)} afterward.`
        if (!(e instanceof NoRoom)) throw e
        const repo = e.roomName.startsWith('github.com/') ? e.roomName.split('/').slice(1, 3).join('/') : e.roomName.slice(0, e.roomName.lastIndexOf('/'))
        return `No room for ${repo} on ${e.server ?? parseServer(choice.server).server} yet. Ask the user whether to open one (anyone with push access can; after that every branch of the repo has a room and sessions join automatically). Call room_create with confirm=true only after they say yes.`
      }
      if (choice.rule === 'argument') { try { await writeChoice(dir, choice.where, s.me.name, s.shareRequested) } catch { /* not a repository? keep going */ } }
      s.shareWarning = resolved.shareWarning ?? s.shareWarning
      for (const m of s.room.messages()) seen.add(m.id)
      rooms.add(s, 'primary')
      const stale = cleanupMine(s, 'stale from an earlier session')
      if (stale || s.room.scope(s.me.name)) log(`cleared ${stale} stale claim(s) and scope from an earlier session`)
      evictStale(s)
      await loadAreas(s)
      const out = [`${a.create && !s.local ? 'opened and joined' : 'joined'} ${s.roomName} as ${displayName(s.me)} (base ${(s.room.meta.base ?? '?').slice(0, 10)}, clone ${s.dir})`]
      if (cur) out.unshift(`moved from ${cur.roomName} to ${s.roomName}; links to the old room no longer show this session.`)
      out.push(`room: ${describeWhere(choice.server === LOCAL ? LOCAL : parseServer(choice.server).server)} — chosen by ${choice.rule === 'argument' ? 'your instruction (remembered for this clone and its worktrees)' : choice.rule === 'env' ? resolved.whereEnv : choice.rule === 'remembered' ? 'the choice remembered for this clone (room_leave forget=true clears it)' : 'default'}`)
      const note = await teamSharingNote(s)
      if (note) out.push(note)
      const company = hasCompany(s)
      if (!company.company) {
        out.push(shareLine(s))
        out.push('alone here; the room stays quiet until someone joins')
        return out.join('\n')
      }
      if (s.local) out.push(`local room (no server): relay on ${s.local.url}${s.local.owned ? ' run by this session' : ''}. Only sessions on this machine in this clone or its worktrees can join; the browser view below is reachable from this machine only. ${a.create ? 'room_create needs a server: set ROOM_SERVER=hosted (or a URL) and call it again to open this repo for teammates.' : 'room_spawn dispatches worker agents into it; say "join the room" (room_join where=team) to work with teammates instead.'}`)
      out.push(shareLine(s))
      const publisher = s.awareness.getLocalState()?.publishUnder
      if (typeof publisher === 'string' && publisher !== s.me.name) out.push(`Your file changes are published under ${publisher}'s name because both sessions watch this folder; claims say which lines are whose.`)
      const here = others(s).filter(n => presences(s).some(p => p.user.name === n))
      const mineA = myAreas(s)
      setPresence(s, { areas: mineA })
      out.push(...areaLines(s, mineA))
      out.push(here.length ? `here now: ${here.join(', ')}` : 'nobody else is here yet')
      for (const n of here) out.push(`  ${n}: ${personLine(s, n)}`)
      const away = others(s).filter(n => !here.includes(n) && s.room.changedPaths(n).length)
      for (const n of away) out.push(`  ${n} (offline): ${personLine(s, n)}`)
      if (s.autoTagNote) { out.push(s.autoTagNote); delete s.autoTagNote }
      const cs = s.room.openClaims()
      if (cs.length) { out.push(`open claims (${cs.length}):`); for (const c of cs) out.push(claimLine(s, c)) }
      out.push(`browser view: ${await refreshBrowserUrl(s)}`)
      out.push('next: room_scope(area, summary, paths) before you edit.')
      const wakeNote = here.length ? claudeWakeNote(s, 'company') : ''
      if (wakeNote) out.push(wakeNote)
      return out.join('\n')
    },
    async room_leave(a) {
      const s = S()
      const running = runningWorkers(s)
      if (running.length && a.force !== true) return `error: ${running.length} worker(s) still running: ${running.map(r => r.w.tag).join(', ')}. Wait for them (room_wait), room_collect(discard=true) them, or room_leave force=true to dismiss them all and leave.`
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
      if (s.local) {
        if (a.confirm !== true) return 'error: this is a local room (no server): room_close forgets its saved history (timeline, finished-worker records) on this machine; call with confirm=true only on the user\'s explicit request'
        if (runningWorkers(s).length) return 'error: dismiss running workers before closing the local room'
        const ledger = exportRoomLedger(s, { now: now() })
        if (!s.local.forget) throw new Error('local relay does not support forgetting memory; restart the session')
        await s.local.forget()
        await closeWorkersRoom()
        cleanupMine(s, 'closing the local room')
        rooms.remove(s)
        await doLeave(s)
        return `local room (no server): forgot the saved history of ${s.roomName} on this machine; exported its ledger to ${ledger.path} (${ledger.lines} lines) first; left the room`
      }
      if (a.confirm !== true) return 'error: room_close removes every branch room of this repo and all shared uncommitted work for everyone; call with confirm=true only on the user\'s explicit request'
      const ledger = exportRoomLedger(s, { now: now() })
      const repo = s.roomName.slice(0, s.roomName.lastIndexOf('/'))
      await closeWorkersRoom()
      cleanupMine(s, 'closing the room')
      s.room.post<NoteMsg>(s.me, { type: 'note', text: `closing the room for ${repo}: every branch room and all shared work is being removed`, priority: 'interrupt' })
      rooms.remove(s)
      const closed = await doClose(s)
      await doLeave(s)
      return `closed ${repo} for everyone: removed ${closed.length ? closed.join(', ') : 'its rooms'}; exported the ledger to ${ledger.path} (${ledger.lines} lines); room_create reopens it`
    },
    async room_export(a) {
      const s = S()
      const ledger = exportRoomLedger(s, { path: typeof a.path === 'string' && a.path ? a.path : undefined, now: now() })
      return `exported room ledger to ${ledger.path} (${ledger.lines} lines)`
    }
  }
  return handlers
}


export function install(state: HandlerState): void {
  const { ctx, log, doJoin, doLeave, seen, rooms, now, presences, mine, planChanged } = state
  const blockedBranch = new WeakMap<Session, string>()
  const followBranch = async (): Promise<string> => {
      const s = ctx.getSession()
      if (!s || !s.roomName.includes('/') || s.pinnedRoom) return ''
      let branch = ''
      try { branch = (await git(s.dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() } catch { return '' }
      if (!branch || branch === 'HEAD') return ''
      const current = roomNameParts(s.roomName).branch
      if (!current) return ''
      if (branch === current) return ''
      const running = state.runningWorkers(s)
      if (running.length) {
        if (blockedBranch.get(s) === branch) return ''
        blockedBranch.set(s, branch)
        return `[room] your clone switched to branch ${branch}, but ${running.length} worker(s) are running and would be left behind; staying in ${s.roomName}. Wait for them or room_collect(discard=true) them before moving.`
      }
      const repo = s.roomName.slice(0, -(current.length + 1))
      const target = `${repo}/${branch}`
      log(`branch changed ${current} -> ${branch}; moving room`)
      try {
        const n = await doJoin({ ...rejoinOptions(s, ctx.config?.credentialsPath), room: target })
        delete n.pinnedRoom
        cleanupMine(s, `switched branch to ${branch}`)
        rooms.remove(s)
        await doLeave(s)
        for (const m of n.room.messages()) seen.add(m.id)
        rooms.add(n, 'primary'); cleanupMine(n, 'stale from an earlier session')
        return `[room] your clone switched to branch ${branch}: left ${current}, joined ${target}. Scope and claims were reset; declare a scope before editing.`
      } catch (e) {
        return `[room] your clone switched to branch ${branch} but joining ${target} failed: ${e instanceof Error ? e.message : String(e)}. Call room_join.`
      }
    }
  const envStaleDays = Number(process.env.ROOM_STALE_DAYS)
  const STALE_MS = (ctx.config?.staleDays ?? (Number.isFinite(envStaleDays) && envStaleDays > 0 ? envStaleDays : 7)) * 24 * 60 * 60 * 1000
  const evictStale = (s: Session): string[] => {
      const here = new Set(presences(s).map(p => p.user.name))
      const gone: string[] = []
      for (const person of Array.from(s.room.overlays.keys())) {
        if (person === s.me.name || here.has(person)) continue
        const age = s.room.overlayAge(person, now())
        if (age === undefined || age < STALE_MS) continue
        const n = s.room.clearOverlays(person)
        const days = Math.round(age / 86_400_000)
        s.room.post<NoteMsg>(s.me, { type: 'note', text: `evicted stale uncommitted work of ${person} (${n} file${n === 1 ? '' : 's'}; last seen ${days} day${days === 1 ? '' : 's'} ago)`, priority: 'fyi' })
        log(`evicted ${person}'s ${n} stale overlay file(s), ${days} days old`)
        gone.push(person)
      }
      return gone
    }
  const cleanupMine = (s: Session, _why: string, keep?: (c: Claim) => boolean): number => releaseClaimsOnDone(s, keep)
  const serverOf = (a: Record<string, unknown>) => { const r = resolveServer(typeof a.server === 'string' && a.server ? a.server : ctx.config?.server ?? process.env.ROOM_SERVER); return r === LOCAL ? LOCAL : parseServer(r).server }
  const LOCAL_LOGIN = `no server configured: local rooms need no login. Set ROOM_SERVER=hosted (or a server URL, or pass server=...) to log in to a team server (${DEFAULT_SERVER} is the hosted one)`
  const codeLine = (p: { provider?: string; verification_uri?: string; user_code?: string; url?: string; expires_in: number }) => p.provider === 'oidc' || p.url
      ? `Open ${p.url} in a browser and sign in (valid ${Math.round(p.expires_in / 60)} min). Then call room_login again to wait for the login to confirm.`
      : `Open ${p.verification_uri} and enter the code ${p.user_code} (valid ${Math.round(p.expires_in / 60)} min). Then call room_login again to wait for GitHub to confirm.`
  Object.assign(state, { followBranch, evictStale, cleanupMine, serverOf, LOCAL_LOGIN, codeLine })
}
