import { releaseClaimsOnDone } from './claims.js'
import { claudeWakeNote } from '../prompt.js'
import { manifestPaths, participantRecord, scopeLine, type Claim, type NoteMsg } from '@room/shared'
import { resolve } from 'node:path'
import { localRoomName } from '@room/roomd/local'
import { handlers as scopeHandlers } from './scope.js'
import { DEFAULT_SERVER, NoRoom, NotLoggedIn, closeRoom, deriveRoomName, normalizeLocalRoomName, parseServer, resolveAuth, resolveServer, type JoinOptions, type Session } from '../session.js'
import { displayName } from '@room/shared'
import { sameCheckoutSession } from '../company.js'
import { clearChoice, describeWhere, writeChoice } from '../choice.js'
import { configureCredentials, getCredential, getPending, setPending } from '../credentials.js'
import { LOCAL, logout as doLogout, pollLogin, refreshBrowserUrl, serverAuthConfig, startLogin } from '../session.js'
import { SHARE, RO, RW, int, str, type Handler, type HandlerState, type ToolDef } from './context.js'
import type { Ledger } from '../ledger.js'
import type { ShareLevel } from '@room/roomd'
import { resolveConfig, sharingDescription, sharingHumanChoices } from '../config.js'
import { handlers as shareHandlers, publisherLine } from './share.js'
import { exportArchiveLedger, exportRoomLedger } from '../prs.js'
import { decideLeave, workerRealState } from '../worker-state.js'

export const defs: ToolDef[] = [
  { name: 'room_login', annotations: RW, description: 'Sign in; show the returned code/URL verbatim, then call again to wait. action=logout revokes and forgets the account.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['login', 'logout'] }, provider: { type: 'string', enum: ['github', 'oidc'] }, wait: int('wait seconds, default 90, max 600'), server: str('server URL'), credentials: str('credentials file') } } },
  { name: 'room_create', annotations: RW, _meta: { 'anthropic/requiresUserInteraction': true }, description: 'Open this repo on a team server and join. confirm=true authorizes opening it for members with push access.',
    inputSchema: { type: 'object', properties: { confirm: { type: 'boolean' }, where: str('team | server URL'), room: str('room name override'), name: str('name override'), server: str('alias of where'), dir: str('clone; default cwd'), share: SHARE } } },
  { name: 'room_join', annotations: RW, description: 'Join local or a requested team server; remember explicit choices for this clone and its worktrees. Priority: argument, ROOM_SERVER, ROOM_URL, remembered, local.',
    inputSchema: { type: 'object', properties: { where: str('local | team | server URL'), room: str('room name override'), name: str('name override'), server: str('alias of where'), dir: str('clone; default cwd'), share: SHARE, takeover: { type: 'boolean', description: 'take a local name only when its process identity is unknown' } } } },
  { name: 'room_leave', annotations: RW, description: 'Leave and release your work claims. force dismisses running workers; forget clears this clone’s remembered destination.',
    inputSchema: { type: 'object', properties: { forget: { type: 'boolean' }, force: { type: 'boolean' } } } },
  { name: 'room_close', annotations: { ...RW, destructiveHint: true, idempotentHint: false }, _meta: { 'anthropic/requiresUserInteraction': true }, description: 'On explicit request, export history then delete the repository room for everyone on all branches, or local memory. Leaves clone files intact.',
    inputSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] } },
  { name: 'room_export', annotations: RO, description: 'Export current ledger or room=<legacy> archive to Markdown.',
    inputSchema: { type: 'object', properties: { room: str('legacy branch room'), path: str('output Markdown path') } } }
]

const disclosures = new WeakMap<Session, { pending?: string; level?: ShareLevel; prepared?: Promise<void>; delivered?: boolean }>()

function sharingSentence(s: Session): string {
  const server = parseServer(s.roomUrl.slice(0, s.roomUrl.lastIndexOf('/'))).server
  const repo = s.roomName
  const level = s.daemon.share ?? s.shareRequested ?? 'intent'
  const secondary = publisherLine(s)
  if (secondary) return `note for your human: ${secondary} Members of ${repo} on ${server} can read it.`
  const description = sharingDescription(level)
  const choices = sharingHumanChoices(level)
  return `note for your human: this clone now shares ${description} with members of ${repo} on ${server}${choices ? `; ${choices}` : '.'}`
}

/**
 * Establish whether this session has a disclosure pending without consuming its one delivery: the durable
 * `disclosed` marker advances only once the notice's handoff is confirmed (ledger MF10).
 */
async function prepareTeamSharingDisclosure(s: Session): Promise<void> {
  let state = disclosures.get(s)
  if (!state) { state = {}; disclosures.set(s, state) }
  if (state.prepared || state.delivered) return state.prepared
  state.prepared = (async () => {
    if (s.local) { state!.delivered = true; return }
    const share = s.daemon.share ?? s.shareRequested ?? 'intent'
    const rank = (level: string) => level === 'intent' ? 0 : level === 'declared' ? 1 : 2
    if (s.policyStore.disclosed.version < 2 || rank(share) > rank(s.policyStore.disclosed.level)) {
      state!.pending = `${sharingSentence(s)} Room now has one room per repository: teammates on any branch see what you share.`
      state!.level = share
    } else state!.delivered = true
  })()
  await state.prepared
}

/**
 * One human disclosure per worktree and destination, including automatic and solo joins: a local notice
 * (ledger MF10) that the next tool reply or hook hands off, receipted only after that handoff. The receipt
 * then records the level as disclosed; a receipt found without that record (a crash between the two)
 * records it when offered again, idempotently.
 */
export async function offerTeamSharingDisclosure(s: Session, ledger: Ledger): Promise<void> {
  await prepareTeamSharingDisclosure(s)
  const state = disclosures.get(s)
  const sentence = state?.pending
  if (!state || !sentence || state.delivered) return
  const level = state.level!
  ledger.notice('sharing', sentence, () => {
    if (state.delivered) return
    state.delivered = true
    state.pending = undefined
    // A failed write is repaired from the receipt the next time a session offers the notice.
    void s.policyStore.markDisclosed(level, 2).catch(() => {})
  })
}

/** Join s's room again as s did, without opening the repo again. */
export function rejoinOptions(s: Session, credentialsPath?: string): JoinOptions {
  return { dir: s.dir, credentialsPath, name: s.me.owner ?? s.me.name, tag: s.me.label, room: s.roomName, server: s.local ? LOCAL : s.roomUrl.slice(0, s.roomUrl.lastIndexOf('/')), share: s.shareRequested, token: s.token }
}

export function handlers(state: HandlerState): Record<string, Handler> {
  const { ctx, now, S, serverOf, LOCAL_LOGIN, codeLine, doJoin, ledger, rooms, cleanupMine, log, loadAreas, shareLine, hasCompany, others, presences, myAreas, setPresence, areaLines, personLine, claimLine, runningWorkers, dismissWorker, closeWorkersRoom, doLeave, doClose } = state
  async function configureLogin(a: Record<string, unknown>) {
    const config = await resolveConfig({ dir: ctx.cwd ?? process.cwd(), args: { credentials: typeof a.credentials === 'string' ? a.credentials : ctx.config?.credentialsPath } })
    configureCredentials(config.credentialsPath)
    ctx.config = { ...config, ...ctx.config, credentialsPath: config.credentialsPath }
    return config
  }
  const handlers: Record<string, Handler> = {
    async room_login(a) {
      const config = await configureLogin(a)
      const server = serverOf(a, config.server)
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
    async room_create(a) { return handlers.room_join({ ...a, create: true }) },
    async room_join(a) {
      if (a.takeover !== undefined && typeof a.takeover !== 'boolean') return 'error: takeover must be true or false'
      const cur = ctx.getSession()
      cur?.lease?.check()
      const terminalNameLoss = cur?.lease?.state === 'taken' || cur?.lease?.state === 'superseded'
      const currentReply = async () => {
        const sharing = a.share !== undefined ? await shareHandlers(state).room_share({ level: a.share }) : ''
        if (cur) await offerTeamSharingDisclosure(cur, ledger)
        return [sharing, await scopeHandlers(state).room_state({ link: cur ? state.hasCompany(cur).company : false })].filter(Boolean).join('\n')
      }
      if (cur && !terminalNameLoss && a.create !== true && a.where === undefined && a.server === undefined && a.room === undefined && a.dir === undefined && a.takeover !== true) {
        return currentReply()
      }
      const dir = typeof a.dir === 'string' && a.dir ? a.dir : cur?.dir ?? ctx.cwd ?? process.cwd()
      const whereArg = typeof a.where === 'string' && a.where ? a.where : typeof a.server === 'string' && a.server ? a.server : undefined
      const resolved = await resolveConfig({ dir, env: process.env, args: { credentialsPath: ctx.config?.credentialsPath, where: whereArg, name: typeof a.name === 'string' ? a.name : undefined, room: typeof a.room === 'string' ? a.room : undefined, share: typeof a.share === 'string' ? a.share : undefined } })
      // Opening always needs a team server. A remembered URL survives a later process;
      // only a local/default destination falls back to the hosted server.
      const createFromLocal = a.create === true && resolved.server === LOCAL
      const choice = { server: createFromLocal ? DEFAULT_SERVER : resolved.server, where: createFromLocal ? 'team' : resolved.where, rule: resolved.whereRule }
      const requestedRoom = createFromLocal && resolved.whereRule === 'remembered' ? (typeof a.room === 'string' ? a.room : process.env.ROOM_ROOM) : resolved.room
      const targetRoom = choice.server === LOCAL
        ? requestedRoom !== undefined ? normalizeLocalRoomName(requestedRoom) : await localRoomName(dir)
        : requestedRoom ?? (await deriveRoomName(dir)).roomName
      if (cur) {
        const sameServer = choice.server === LOCAL ? !!cur.local
          : !cur.local && parseServer(choice.server).server === parseServer(cur.roomUrl.slice(0, cur.roomUrl.lastIndexOf('/'))).server
        if (sameServer && targetRoom === cur.roomName && resolve(dir) === cur.dir && !terminalNameLoss && a.takeover !== true && a.create !== true) {
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
        if (!terminalNameLoss) cleanupMine(cur, 'moved to another room')
        rooms.remove(cur)
        await doLeave(cur)
      }
      let s: Session
      try { s = await doJoin({
        dir,
        credentialsPath: resolved.credentialsPath,
        name: resolved.name,
        room: choice.server === LOCAL ? targetRoom : requestedRoom,
        server: choice.server,
        create: a.create === true,
        confirm: a.confirm === true,
        share: resolved.share,
        shareExplicit: resolved.shareExplicit,
        takeover: a.takeover === true,
      }) } catch (e) {
        if (e instanceof NotLoggedIn) return `error: not logged in to ${e.server}. Call room_login server=${JSON.stringify(e.server)}, show its code/URL, then call room_login with the same server again to wait; retry room_join where=${JSON.stringify(e.server)} afterward.`
        if (!(e instanceof NoRoom)) throw e
        // A stale server may report the old branch key. GitHub repository names
        // have exactly owner/repo after the host; never offer to open a branch.
        const repo = e.roomName.startsWith('github.com/') ? e.roomName.split('/').slice(1, 3).join('/') : e.roomName
        return `No room for ${repo} on ${e.server ?? parseServer(choice.server).server} yet. Ask the user whether to open one (anyone with push access can; teammates on every branch join the same repository room). Call room_create with confirm=true only after they say yes.`
      }
      if (choice.rule === 'argument' || (choice.rule !== 'env' && choice.server === LOCAL && typeof a.room === 'string')) { try { await writeChoice(dir, choice.where, s.me.name, choice.server === LOCAL && typeof a.room === 'string' ? s.roomName : undefined) } catch { /* not a repository? keep going */ } }
      s.shareWarning = resolved.shareWarning ?? s.shareWarning
      rooms.add(s, 'primary')
      const stale = cleanupMine(s, 'stale from an earlier session')
      if (stale || s.room.scope(s.me.name)) log(`cleared ${stale} stale claim(s) and scope from an earlier session`)
      await loadAreas(s)
      const ownGit = participantRecord(s.room, s.me.name)?.git
      const out = [`${a.create && !s.local ? 'opened and joined' : 'joined'} ${s.roomName} as ${displayName(s.me)} (on ${ownGit?.branch || 'detached'}, base ${(ownGit?.base ?? '?').slice(0, 10)}${ownGit?.ahead ? `, ${ownGit.ahead} unpushed` : ''}, clone ${s.dir})`]
      if (cur) out.unshift(`moved from ${cur.roomName} to ${s.roomName}; links to the old room no longer show this session.`)
      out.push(`room: ${describeWhere(choice.server === LOCAL ? LOCAL : parseServer(choice.server).server)} — chosen by ${choice.rule === 'argument' ? 'your instruction (remembered for this clone and its worktrees)' : choice.rule === 'env' ? resolved.whereEnv : choice.rule === 'remembered' ? 'the choice remembered for this clone (room_leave forget=true clears it)' : 'default'}`)
      await offerTeamSharingDisclosure(s, ledger)
      if (s.local) out.push(`local room (no server): relay on ${s.local.url}${s.local.owned ? ' run by this session' : ''}. Only sessions on this machine in this clone or its worktrees can join; the browser view below is reachable from this machine only. ${a.create ? 'room_create needs a server: set ROOM_SERVER=hosted (or a URL) and call it again to open this repo for teammates.' : 'room_spawn dispatches worker agents into it; say "join the room" (room_join where=team) to work with teammates instead.'}`)
      if (presences(s).some(p => sameCheckoutSession(s, p.user.name))) out.push('another session in this checkout')
      const sameCheckoutNames = new Set(presences(s).filter(p => sameCheckoutSession(s, p.user.name)).map(p => p.user.name))
      for (const scope of s.room.allScopes()) if (sameCheckoutNames.has(scope.by)) out.push(`  scope: ${displayName({ name: scope.by, kind: scope.byKind })} is on ${scopeLine(scope)}`)
      const sameCheckoutClaims = s.room.openClaims().filter(c => sameCheckoutNames.has(c.by))
      const company = hasCompany(s)
      if (!company.company) {
        if (sameCheckoutClaims.length) out.push(`open claims in this checkout (${sameCheckoutClaims.length}):`, ...sameCheckoutClaims.map(c => claimLine(s, c)))
        out.push(shareLine(s))
        out.push('alone here; the room stays quiet until someone joins')
        return out.join('\n')
      }
      out.push(shareLine(s))
      const here = others(s).filter(n => !sameCheckoutSession(s, n) && presences(s).some(p => p.user.name === n))
      const label = (name: string) => displayName({ name, kind: (presences(s).find(p => p.user.name === name && p.user.kind === 'agent') ?? presences(s).find(p => p.user.name === name))?.user.kind ?? s.room.scope(name)?.byKind ?? s.room.openClaims().find(c => c.by === name)?.byKind ?? 'human' })
      const mineA = myAreas(s)
      setPresence(s, { areas: mineA })
      out.push(...areaLines(s, mineA))
      out.push(here.length ? `here now: ${here.map(label).join(', ')}` : 'nobody else is here yet')
      for (const n of here) out.push(`  ${label(n)}: ${personLine(s, n)}`)
      const away = others(s).filter(n => !sameCheckoutSession(s, n) && !here.includes(n) && manifestPaths(s.room, n).length)
      for (const n of away) out.push(`  ${label(n)} (offline): ${personLine(s, n)}`)
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
      const running = (await Promise.all(runningWorkers(s).map(async r => ({ ...r, action: decideLeave(await workerRealState(r.s.dir, r.w, { process: true, hasHandle: rooms.hasHandle?.(r.s, r.w), probe: ctx?.probe })) })))).filter(r => r.action === 'stop')
      if (running.length && a.force !== true) return `error: ${running.length} worker(s) still running: ${running.map(r => r.w.tag).join(', ')}. Wait for them (room_wait), room_collect(discard=true) them, or room_leave force=true to dismiss them all and leave.`
      const stopped = await Promise.all(running.map(r => dismissWorker(r.s, r.w, 'the lead left the room')))
      await closeWorkersRoom()
      const released = cleanupMine(s, 'left the room')
      rooms.remove(s)
      await doLeave(s)
      let forgot = ''
      if (a.forget === true) { const had = await clearChoice(s.dir).catch(() => false); forgot = had ? '; forgot the remembered room choice for this clone (next session starts local)' : '; nothing was remembered for this clone' }
      return `left ${s.roomName}; released ${released} claim(s)${stopped.length ? '; worker process checks: ' + stopped.join('; ') : ''}${forgot}`
    },
    async room_close(a) {
      const s = ctx.getSession()
      if (!s) {
        const dir = ctx.cwd ?? process.cwd()
        const config = await resolveConfig({ dir, env: process.env, args: { credentialsPath: ctx.config?.credentialsPath } })
        if (config.server === LOCAL) return 'error: not in a local room; nothing to close without joining'
        if (a.confirm !== true) return 'error: room_close removes this repository room and all shared uncommitted work for everyone on every branch; call with confirm=true only on the user\'s explicit request'
        const roomName = (await deriveRoomName(dir)).repo ?? config.room
        if (!roomName) return `error: ${dir} has no origin remote; room_join needs a room name`
        const { server, token } = parseServer(config.server)
        configureCredentials(config.credentialsPath)
        let auth
        try { auth = await resolveAuth(server, roomName, config.token ?? token) }
        catch (e) {
          if (e instanceof NotLoggedIn) return `error: not logged in to ${e.server}. Call room_login server=${JSON.stringify(e.server)}, show its code/URL, then call room_login with the same server again to wait; retry room_close confirm=true afterward.`
          throw e
        }
        await closeRoom(server, roomName, { session: auth.session, token: auth.token })
        const repo = roomName
        return `closed ${repo} for everyone without joining (no joined session was available to export its history); room_create reopens it`
      }
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
      if (a.confirm !== true) return 'error: room_close removes this repository room and all shared uncommitted work for everyone on every branch; call with confirm=true only on the user\'s explicit request'
      const ledger = exportRoomLedger(s, { now: now() })
      const repo = s.roomName
      await closeWorkersRoom()
      cleanupMine(s, 'closing the room')
      await s.post<NoteMsg>(s.me, { type: 'note', text: `closing ${repo} for everyone: every participant on every branch loses this room's shared work and history`, priority: 'interrupt' })
      rooms.remove(s)
      const closed = await doClose(s)
      await doLeave(s)
      return `closed ${repo} for everyone: removed ${closed.length ? closed.join(', ') : 'its rooms'}; exported the ledger to ${ledger.path} (${ledger.lines} lines); room_create reopens it`
    },
    async room_export(a) {
      const s = S()
      if (typeof a.room === 'string' && a.room) {
        try {
          const archive = await exportArchiveLedger(s, a.room, { path: typeof a.path === 'string' && a.path ? a.path : undefined, now: now() })
          return `exported archive ${a.room} to ${archive.path} (${archive.lines} lines)`
        } catch (error) { return `error: ${error instanceof Error ? error.message : String(error)}` }
      }
      const ledger = exportRoomLedger(s, { path: typeof a.path === 'string' && a.path ? a.path : undefined, now: now() })
      return `exported room ledger to ${ledger.path} (${ledger.lines} lines)`
    }
  }
  return handlers
}


export function createJoin(deps: Pick<HandlerState, 'ctx' | 'log' | 'doJoin' | 'doLeave' | 'rooms' | 'now' | 'presences' | 'runningWorkers'>): Pick<HandlerState, 'cleanupMine' | 'serverOf' | 'LOCAL_LOGIN' | 'codeLine'> {
  const { ctx } = deps
  const cleanupMine = (s: Session, why: string, keep?: (c: Claim) => boolean): number => {
    if (why !== 'stale from an earlier session') return releaseClaimsOnDone(s, keep)
    const scope = s.room.scope(s.me.name)
    const migrated = s.room.openClaims().filter(c => c.by === s.me.name && !!c.origin)
    const released = releaseClaimsOnDone(s, c => !!c.origin || !!keep?.(c), s.me.name, !scope?.origin)
    s.room.doc.transact(() => {
      for (const claim of migrated) {
        const current = s.room.claims.get(claim.id)
        if (current?.by === s.me.name && current.origin) {
          const { origin: _origin, ...adopted } = current
          s.room.claims.set(claim.id, adopted)
        }
      }
      if (scope?.origin && s.room.scope(s.me.name)?.origin === scope.origin) {
        const { origin: _origin, ...adopted } = scope
        s.room.scopes.set(s.me.name, adopted)
      }
    }, s.me)
    return released
  }
  const serverOf = (a: Record<string, unknown>, resolvedServer: string) => {
    const current = ctx.getSession()
    const requested = typeof a.server === 'string' && a.server ? resolveServer(a.server) : undefined
    const r = requested ?? (current ? current.local ? LOCAL : current.roomUrl.slice(0, current.roomUrl.lastIndexOf('/')) : resolvedServer)
    return r === LOCAL ? LOCAL : parseServer(r).server
  }
  const LOCAL_LOGIN = `no server configured: local rooms need no login. Set ROOM_SERVER=hosted (or a server URL, or pass server=...) to log in to a team server (${DEFAULT_SERVER} is the hosted one)`
  const codeLine = (p: { provider?: string; verification_uri?: string; user_code?: string; url?: string; expires_in: number }) => p.provider === 'oidc' || p.url
      ? `Open ${p.url} in a browser and sign in (valid ${Math.round(p.expires_in / 60)} min). Then call room_login again to wait for the login to confirm.`
      : `Open ${p.verification_uri} and enter the code ${p.user_code} (valid ${Math.round(p.expires_in / 60)} min). Then call room_login again to wait for GitHub to confirm.`
  return { cleanupMine, serverOf, LOCAL_LOGIN, codeLine }
}
