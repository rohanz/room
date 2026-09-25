import { claudeWakeNote } from '../prompt.js'
import { Bridge } from '../bridge.js'
import { pidAlive, pidIsOurWorker, signalWorker, workerPriority, WORKER_EFFORTS, prepareWorkerLinks, resolveWorkerLinks, cleanupPreparedWorktree, terminateWorktreeProcesses, isOwnedWorkerWorktree } from '../workers.js'
import { releaseClaimsOnDone } from './claims.js'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { type DoneMsg, type NoteMsg, type Worker } from '@room/shared'
import { parseShare } from '@room/roomd'
import { git } from '@room/roomd/git'
import { toolCallAborted, workerId, workerIdBase, workerOrigin } from '../registry.js'
import { LOCAL, refreshBrowserUrl, type Session } from '../session.js'
import { workerBudget, workerMaxBudget, workerProcessEnv, hostWorkerEffort, defaultSpawner, prepareWorktree, uncommittedCount, validTag, workerCommand, workerPrompt, persistWorkerStopReason, type PreparedWorktree, type SpawnedProcess, type WorkerHost } from '../workers.js'
import { branchOf } from '../prs.js'
import { SHARE, RW, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'
import { resolveConfig } from '../config.js'
import { bindWorkerPortReservation, releaseWorkerProcessPort, reserveWorkerPort, type PortReservation } from '../port-reservations.js'
function missingBriefPaths(task: string, leadDir: string, workerDir: string): string[] {
  const paths = new Set<string>()
  for (const match of task.matchAll(/(?:\.\/)?[\w.-]+(?:\/[\w.-]+)+/g)) {
    const rel = match[0].replace(/^\.\//, '')
    if (rel.split('/').some(part => part === '..' || part === '.')) continue
    const source = path.join(leadDir, rel), target = path.join(workerDir, rel)
    if (fs.existsSync(source) && !fs.existsSync(target)) paths.add(rel)
  }
  return [...paths].sort()
}

export const defs: ToolDef[] = [
  { name: 'room_done', annotations: RW, description: 'Finish your task and release claims. Workers report to their lead, then exit.',
    inputSchema: { type: 'object', properties: { summary: str('one line: what landed and the test result'), pr_note: { type: 'boolean', description: 'post ledger on current branch PR' } }, required: ['summary'] } },
  { name: 'room_spawn', annotations: RW, description: 'Start another agent (claude/codex) in its own worktree, in the background; use for agents in parallel or codex/claude to do part of the work, not a built-in subagent. Finish with room_collect.',
    inputSchema: { type: 'object', properties: { tag: str('worker tag'), task: str('self-contained task'), host: { type: 'string', enum: ['claude', 'codex'], description: 'host (default: caller host)' }, model: str('model override for that host (optional)'), effort: { type: 'string', enum: [...WORKER_EFFORTS], description: 'reasoning effort' }, link: strs('read-only input paths; default .roomlinks; [] disables'), carry: { type: 'boolean', description: 'false starts from HEAD without lead changes' }, threads: { type: 'integer', minimum: 1, description: 'math-library thread budget for this worker (optional)' }, share: SHARE, allowOutside: { type: 'boolean', description: 'permit dir outside this repo (no worktree bookkeeping)' }, dir: str('use this existing directory instead of creating a worktree'), where: { type: 'string', enum: ['here', 'local'], description: 'here (default), or local workers bridged to this room' } }, required: ['tag', 'task'] } },
]

export function handlers(state: HandlerState): Record<string, Handler> {
  const spawnExplained = new WeakSet<Session>()
  const { S, ensureWorkersRoom, workerAlive, myWorkers, mine, ctx, rooms, now, runningWorkers, setPresence, refreshPrs, myPr, postLedger } = state
  const handlers: Record<string, Handler> = {
    async room_done(a) {
      const s = S()
      const summary = String(a.summary ?? '').trim()
      if (!summary) return 'error: summary is required'
      const sc = s.room.scope(s.me.name)
      // Claims mirroring a worker that is still running are the worker's, not this task's: they stay until it finishes.
      const live = new Set(runningWorkers(s).map(x => x.w.tag))
      const kept = mine(s).filter(c => c.mirrorOf && live.has(c.mirrorOf)).length
      const released = releaseClaimsOnDone(s, c => !!c.mirrorOf && live.has(c.mirrorOf))
      const asWorker = s.room.workerOf(s.me.name)
      // A worker finishes only the record of its own spawn (ROOM_WORKER_ID; older leads passed ROOM_GEN): a stale
      // process of a reused tag must not mark the lead's current worker done. Its report still reaches the lead.
      const myId = ctx.config?.workerId, gen = ctx.config?.gen
      const stale = !!asWorker && (myId ? asWorker.id !== undefined && asWorker.id !== myId : !!gen && asWorker.gen !== undefined && String(asWorker.gen) !== gen)
      if (asWorker) {
        if (!stale) s.room.updateWorker(asWorker.tag, { status: 'done', summary, finishedAt: now() }, asWorker.id)
        s.room.post<DoneMsg>(s.me, { type: 'done', tag: asWorker.tag, summary: stale ? `${summary} (from an earlier generation of ${asWorker.tag}; the current worker's record was left alone)` : summary, changed: s.room.changedPaths(s.me.name), to: asWorker.lead, priority: 'notify' })
      } else {
        s.room.post<NoteMsg>(s.me, { type: 'note', text: `done${sc ? ` (${sc.area})` : ''}: ${summary}` })
      }
      setPresence(s, { cursor: undefined, status: `done: ${summary.slice(0, 60)}` })
      s.daemon.touch()
      const out = [`marked done${sc ? ` (${sc.area})` : ''}; released ${released} claim(s)${kept ? ` (kept ${kept} mirroring running workers)` : ''}, scope cleared. ${asWorker ? `Your lead ${asWorker.lead} has been told (worker ${asWorker.tag}); your work is on branch ${asWorker.branch} in ${asWorker.dir}. Finish now; your lead can resume this session for follow-up work while its worktree remains.` : 'You remain in the room.'}`]
      const localTestsFailed = /(?:local.{0,40}(?:tests?|checks?|suite).{0,40}fail|(?:tests?|checks?|suite).{0,40}fail.{0,40}local)/i.test(summary)
      const command = s.lastPreview?.testsCommand
      if (localTestsFailed && s.lastPreview?.clean && s.lastPreview.testsPassed === true && command) {
        out.push(`The combined preview passed \`${command}\`.`)
      }
      if (a.pr_note === true) {
        await refreshPrs(s)
        const pr = await myPr(s)
        if (!pr) out.push(`pr_note: no open PR has ${branchOf(s.roomName)} as its head; nothing posted (room_pr_note number=<n> to pick one)`)
        else { try { out.push(await postLedger(s, pr)) } catch (e) { out.push(`pr_note failed: ${e instanceof Error ? e.message : String(e)}`) } }
      }
      return out.join('\n')
    },
    async room_spawn(a) {
      const lead = S()
      if (a.effort !== undefined && !(WORKER_EFFORTS as readonly unknown[]).includes(a.effort)) return `error: effort must be ${WORKER_EFFORTS.join('|')}`
      const requestedEffort = a.effort as string | undefined
      if (a.threads !== undefined && (typeof a.threads !== 'number' || !Number.isSafeInteger(a.threads) || a.threads < 1)) return 'error: threads must be an integer >= 1'
      if (a.where !== undefined && a.where !== 'here' && a.where !== 'local') return 'error: where must be here or local'
      if (a.carry !== undefined && typeof a.carry !== 'boolean') return 'error: carry must be a boolean'
      let s = lead
      if (a.where === 'local' && !lead.local) {
        try { s = await ensureWorkersRoom(lead) }
        catch (e) { return `error: could not open the local workers room: ${e instanceof Error ? e.message : String(e)}` }
      }
      const tag = validTag(a.tag)
      if (!tag) return 'error: tag must be 1-40 chars of letters, digits, _ or -'
      const task = String(a.task ?? '').trim()
      if (!task) return 'error: task is required'
      if (a.host !== undefined && a.host !== 'codex' && a.host !== 'claude') return 'error: host must be codex or claude'
      const host: WorkerHost = (a.host ?? process.env.ROOM_HOST ?? process.env.ROOM_WORKER_HOST) === 'codex' ? 'codex' : 'claude'
      const effort = hostWorkerEffort(host, requestedEffort)
      const model = typeof a.model === 'string' && a.model.trim() ? a.model.trim() : undefined
      const idBase = workerIdBase(s.roomName, s.me.name, tag)
      const existing = s.room.workers.get(tag)
      if (existing && existing.lead !== s.me.name && existing.status === 'running') return `error: tag ${tag} is in use by ${existing.lead}'s worker in this room; ${workerAlive(s, existing) ? 'pick another tag' : 'its process is gone; its ancestor can use room_collect tag=' + tag + ' discard=true to free the tag'}`
      if (existing && (existing.status === 'running' || workerAlive(s, existing))) return `error: worker ${tag} is ${existing.status === 'running' ? 'already running' : `${existing.status} but its process is still alive`} (pid ${existing.pid}); room_collect discard=true for it first or pick another tag`
      if (existing) return `error: worker ${tag} is ${existing.status} and still holds its room state; room_collect discard=true for it before reusing the tag`
      const retired = s.room.retiredWorkers().filter(w => w.tag === tag && w.lead === s.me.name)
      const gen = Math.max(0, ...retired.map(w => w.retiredAt)) + 1
      const id = workerId(s.me.name, tag, gen)
      const config = await resolveConfig({ dir: s.dir, env: process.env, args: { maxWorkers: ctx.maxWorkers } })
      const max = config.maxWorkers
      const share = typeof a.share === 'string' && a.share ? parseShare(a.share) : undefined
      if (typeof a.share === 'string' && a.share && !share) return 'error: share must be intent, declared or full'
      // The tag is reserved from here until the process record exists (or this call fails): the worktree
      // preparation below awaits git, and a second room_spawn for the same tag must not slip in meanwhile.
      if (!rooms.reserve(idBase)) return `error: worker ${tag} is being spawned right now (another room_spawn is preparing its worktree); pick another tag`
      const starting = runningWorkers(lead).length
      if (!rooms.reserveLaunch(max, starting)) {
        rooms.unreserve(idBase)
        return `error: ${rooms.launchUsage(starting)} workers already running or starting (max ${max}, ROOM_MAX_WORKERS); wait for one to finish or room_collect discard=true for it`
      }
      let launchReserved = true
      let portReservation: PortReservation | undefined
      let portPassedToProcess = false
      try {
        let dir: string, branch: string, base: string | undefined, created = false, outside = false
        let carried: PreparedWorktree['carried'], carryFailed = false, carryError: string | undefined
        let carriedBase: string | undefined, carriedUntracked: PreparedWorktree['carriedUntracked'], skippedCarry: PreparedWorktree['skippedCarry']
        let prepared: PreparedWorktree | undefined
        let linkPaths: string[]
        try { linkPaths = resolveWorkerLinks(lead.dir, a.link) }
        catch (e) { return `error: could not link inputs: ${e instanceof Error ? e.message : String(e)}` }
        const abortPrepared = async (message: string): Promise<string> => {
          if (!prepared?.created) return message
          try { await cleanupPreparedWorktree(s.dir, prepared); return message }
          catch (e) { return `${message}; could not remove prepared worktree ${prepared.dir}: ${e instanceof Error ? e.message : String(e)}` }
        }
        if (typeof a.dir === 'string' && a.dir) {
          dir = path.resolve(a.dir)
          if (!fs.existsSync(dir)) return `error: ${dir} does not exist`
          const inside = path.relative(s.dir, dir)
          outside = inside.startsWith('..') || path.isAbsolute(inside)
          if (outside && a.allowOutside !== true) return `error: ${dir} is outside this repo (${s.dir}); pass allowOutside=true to run a worker there anyway (no worktree bookkeeping, its branch is whatever HEAD is there)`
          try { branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() } catch { branch = '?' }
        } else {
          try {
            prepared = await (ctx.worktree ? ctx.worktree(s.dir, tag) : prepareWorktree(s.dir, tag, s.me.name, linkPaths, `${s.roomName}|${s.me.name}`, 0, a.carry !== false))
            dir = prepared.dir; branch = prepared.branch; base = prepared.base; created = prepared.created
            carried = prepared.carried; carryFailed = prepared.carryFailed ?? false; carryError = prepared.carryError
            carriedBase = prepared.carriedBase; carriedUntracked = prepared.carriedUntracked; skippedCarry = prepared.skippedCarry
          }
          catch (e) { return `error: could not create a worktree for ${tag}: ${e instanceof Error ? e.message : String(e)}` }
        }
        if (toolCallAborted()) return abortPrepared('error: tool call cancelled')
        const owner = s.me.owner ?? s.me.name
        const name = `${owner}+${tag}`
        // The worker's room variables are set here in full; defaultSpawner strips the lead's own ROOM_* first
        // (ROOM_URL/ROOM_NAME/ROOM_DIR from a runner would otherwise send it into the lead's room as the lead).
        // The server URL is passed without its query: a shared token travels only as ROOM_TOKEN.
        const { server, isWorker } = workerOrigin(s)
        const count = runningWorkers(lead).length
        const cores = Math.max(1, os.availableParallelism?.() ?? os.cpus().length)
        const memBytes = os.totalmem()
        const budget = workerBudget({ cores, memBytes, maxWorkers: max, running: count })
        const inheritedThreads = Number(process.env.ROOM_WORKER_THREADS)
        const inheritedMem = Number(process.env.ROOM_WORKER_MEM_GB)
        const divisor = isWorker ? Math.max(2, max) : 1
        const threadShare = Number.isSafeInteger(inheritedThreads) && inheritedThreads >= 1 ? Math.max(1, Math.floor(inheritedThreads / divisor)) : budget.threads
        const threads = typeof a.threads === 'number' ? Math.min(a.threads, threadShare) : threadShare
        const memGb = Number.isFinite(inheritedMem) && inheritedMem >= 1 ? Math.max(1, Math.floor(inheritedMem / divisor)) : budget.memGb
        const effectiveShare = share ?? s.daemon.share ?? 'full'
        const usedPorts = runningWorkers(lead).flatMap(({ w }) => {
          const port = (w as Worker & { port?: number }).port
          return typeof port === 'number' ? [port] : []
        })
        let port: number
        try { portReservation = reserveWorkerPort(id, usedPorts); port = portReservation.port }
        catch (e) { return abortPrepared(`error: could not allocate a worker port: ${e instanceof Error ? e.message : String(e)}`) }
        const env = workerProcessEnv({ threads, memGb, host, model, effort, server, room: s.roomName, dir, tag,
          lead: s.me.name, owner, share: effectiveShare, gen, id,
          token: s.local ? undefined : s.token, logDir: s.dir, isWorker, ...(port === undefined ? {} : { port }) })
        let link: string[]
        try { link = prepareWorkerLinks(lead.dir, dir, linkPaths) }
        catch (e) { return abortPrepared(`error: could not link inputs: ${e instanceof Error ? e.message : String(e)}`) }
        const scheduling = workerPriority({ cmd: host, args: [] })
        const prompt = workerPrompt(s.me.name, tag, task, { threads, memGb: Number(env.ROOM_WORKER_MEM_GB), nice: scheduling.nice, effort, link, carriedPaths: carried?.paths, ...(port === undefined ? {} : { port }) })
        const hostSessionId = host === 'claude' ? randomUUID() : undefined
        let maxBudgetUsd: string | undefined
        try { maxBudgetUsd = workerMaxBudget() } catch (e) { return abortPrepared(`error: ${e instanceof Error ? e.message : String(e)}`) }
        const { cmd, args } = workerCommand(host, model, prompt, config.claudeChannel, effort, { tag, sessionId: hostSessionId, maxBudgetUsd, wakeChannels: process.env.ROOM_WAKE === 'channels' })
        const logFile = path.join(s.dir, '.room', 'workers', `${tag}.log`)
        const priority = { cmd: scheduling.cmd, args: [...scheduling.args, ...args], nice: scheduling.nice }
        let proc: SpawnedProcess
        if (toolCallAborted()) return abortPrepared('error: tool call cancelled')
        try { proc = (ctx.spawner ?? defaultSpawner)({ cmd: priority.cmd, args: priority.args, cwd: dir, env, logFile, captureCodexSession: host === 'codex' }) }
        catch (e) { return abortPrepared(`error: could not start ${cmd}: ${e instanceof Error ? e.message : String(e)}`) }
        bindWorkerPortReservation(proc, portReservation)
        portPassedToProcess = true
        rooms.setHandle(s, id, proc)
        const w: Worker = { id, tag, name, host, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(hostSessionId ? { hostSessionId } : {}), budget: { threads, memGb, nice: scheduling.nice }, ...(port === undefined ? {} : { port }), share: effectiveShare, ...(link.length ? { link } : {}), task, dir, branch, ...(base ? { base } : {}), ...(carriedBase ? { carriedBase } : {}), ...(carriedUntracked?.length ? { carriedUntracked } : {}), pid: proc.pid, startedAt: now(), status: 'running', lead: s.me.name, gen }
        s.room.setWorker(w)
        rooms.releaseLaunch(); launchReserved = false
        if (host === 'codex') proc.onSessionId?.(sessionId => {
          const current = s.room.workerById(id)
          if (current && current.pid === proc.pid && !current.hostSessionId) s.room.updateWorker(tag, { hostSessionId: sessionId }, id)
        })
        rooms.watchWorkerProcess(s, id, proc, `could not start ${cmd}`, state.log, now)
        s.room.post<NoteMsg>(s.me, { type: 'note', text: `spawned worker ${tag} (${host}${model ? ` ${model}` : ''}) as ${name}: ${task.slice(0, 100)}` })
        const out = [`spawned ${tag}: ${name} (${host}${model ? ` ${model}` : ''}, pid ${proc.pid})${port === undefined ? '' : ` port ${port}`} in ${dir} on branch ${branch}${created ? ' (new worktree)' : ''}`]
        const wakeNote = claudeWakeNote(lead, 'spawn')
        if (wakeNote) out.unshift(wakeNote)
        out.push(`budget in prompt: ${threads} threads, ~${env.ROOM_WORKER_MEM_GB} GB · priority ${priority.nice ? `nice ${priority.nice}` : 'normal'}${effort ? ` · effort ${effort}` : ''}${link.length ? ` · inputs ${link.join(', ')}` : ''}`)
        out.push(`log: ${logFile}`)
        if (!spawnExplained.has(lead)) out.push(`browser view: ${await refreshBrowserUrl(s)}`)
        if (!spawnExplained.has(lead)) out.push(`it joins ${s === lead ? 'this room' : `the local workers room ${s.roomName} (not the team server; the team room sees its scope and claims as yours)`} and reports through room_done; block on room_wait and answer its questions promptly.`)
        spawnExplained.add(lead)
        if (carried || skippedCarry?.length) {
          const count = carried?.paths?.length ?? carried?.count ?? 0
          out.push(`carried your ${count} uncommitted change${count === 1 ? '' : 's'} into its worktree${carried ? ` (commit ${carried.commit.slice(0, 10)})` : ''}${skippedCarry?.length ? `; not carried: ${skippedCarry.map(({ path: p, reason }) => `${p} (${reason})`).join(', ')}` : ''}`)
        } else if (created && !outside) {
          if (carryFailed && carryError) out.push(`note: carry failed: ${carryError}`)
          const pending = await uncommittedCount(lead.dir).catch(() => 0)
          if (pending) {
            out.push(`note: ${pending} uncommitted change${pending === 1 ? '' : 's'} in your clone ${pending === 1 ? 'is' : 'are'} not in this worktree, which starts from HEAD${base ? ` ${base.slice(0, 10)}` : ''}. Commit them (locally is enough) first if the task builds on them.`)
          } else if (carryFailed) out.push(`note: could not carry your uncommitted changes${carryError ? ` (${carryError})` : ''}; this worktree starts from HEAD${base ? ` ${base.slice(0, 10)}` : ''}.`)
        }
        if (outside) out.push(`note: ${dir} is outside this repo, so no worktree was made and nothing is tracked for it beyond the pid; its work stays wherever that checkout puts it.`)
        if (!outside) for (const p of missingBriefPaths(task, lead.dir, dir)) out.push(`warning: ${p} named in the task is not in this worktree (untracked or ignored in the lead clone).`)
        return out.join('\n')
      } finally {
        if (!portPassedToProcess) portReservation?.release()
        if (launchReserved) rooms.releaseLaunch()
        rooms.unreserve(idBase)
      }
    },

  }
  return handlers
}


export function install(state: HandlerState): void {
  const { ctx, rooms, doJoin, doLeave, seen, log, cleanupMine } = state
  const myWorkers = (s: Session): Worker[] => Array.from(s.room.workers.values()).filter(w => w.lead === s.me.name)
  const workerAlive = (s: Session, w: Worker): boolean => rooms.hasHandle(s, w) || pidIsOurWorker(w.pid, w, ctx.probe)
  const ensureWorkersRoom = async (lead: Session): Promise<Session> => {
      if (lead.local) return lead
      const have = rooms.workers()
      if (have) return have
      const ws = await doJoin({ dir: lead.dir, server: LOCAL, name: lead.me.owner ?? lead.me.name, tag: lead.me.label, log })
      for (const m of ws.room.messages()) seen.add(m.id)
      rooms.add(ws, 'workers', lead)
      log(`workers room: ${ws.roomName} (${ws.local?.url ?? 'local'}), bridged to ${lead.roomName}`)
      return ws
    }
  const closeWorkersRoom = async (): Promise<void> => {
      const ws = rooms.workers()
      if (!ws) return
      rooms.remove(ws)
      try { cleanupMine(ws, 'lead left') } catch { /* best effort */ }
      await doLeave(ws)
    }
  const runningWorkers = (s: Session): { s: Session; w: Worker }[] => {
      const out: { s: Session; w: Worker }[] = []
      for (const sess of [s, ...rooms.all().filter(x => x !== s)]) for (const w of myWorkers(sess)) if (w.status === 'running' || workerAlive(sess, w)) out.push({ s: sess, w })
      return out
    }
  const dismissWorker = async (s: Session, w: Worker, why: string, stopReason?: Worker['stopReason']): Promise<string> => {
      const proc = rooms.handle(s, w.id)
      // The host's exit can also take down its dev-server children. Name and stop
      // those while they are still visible, but leave the host pid for its own handle.
      const protectedPids = w.pid ? [w.pid] : []
      const ownedWorktree = await isOwnedWorkerWorktree(s.dir, w, s.me.name, [...s.room.retiredWorkers(), ...s.room.workers.values()])
      const stopped: string[] = []
      let cleanupError: string | undefined
      const stopCwdProcesses = async () => {
        if (!ownedWorktree || cleanupError) return
        try { stopped.push(...await terminateWorktreeProcesses(w.dir, { protectedPids })) }
        catch (e) { cleanupError = `cwd process cleanup failed: ${e instanceof Error ? e.message : String(e)}` }
      }
      const cleanupText = () => (stopped.length ? `; stopped processes: ${stopped.join(', ')}` : '') + (cleanupError ? `; ${cleanupError}` : '')
      await stopCwdProcesses()
      if (proc && w.dismissedAt !== undefined) {
        return `pid ${w.pid} already signalled; waiting for exit${cleanupText()}`
      }
      let how: string, signalled: boolean
      if (proc) {
        signalled = proc.kill()
        how = signalled ? `pid ${w.pid} signalled` : `pid ${w.pid} not signalled: the process is already gone`
      } else if (pidIsOurWorker(w.pid, w, ctx.probe)) {
        signalled = signalWorker(w.pid)
        how = signalled ? `pid ${w.pid} signalled` : `pid ${w.pid} not signalled (it exited just now, or is not ours to signal)`
      } else {
        signalled = false
        how = `pid ${w.pid} not signalled: it is not alive, or not a process started for this worker (this session did not spawn it)`
      }
      // Keep an owned handle until exit confirms the process can no longer publish live state.
      if (stopReason) {
        try { persistWorkerStopReason(s.dir, w.tag, stopReason, w.id) } catch (e) { state.log(`could not persist stop reason for ${w.tag}: ${e}`) }
      }
      if (signalled || stopReason) s.room.updateWorker(w.tag, { ...(w.status === 'running' ? { status: 'dismissed' as const } : {}), dismissedAt: state.now(), ...(stopReason ? { stopReason } : {}) }, w.id)
      if (signalled || workerAlive(s, w)) s.room.post<NoteMsg>(s.me, { type: 'note', text: signalled ? `dismissed worker ${w.tag} (${w.name}): ${why}` : `could not dismiss worker ${w.tag} (${w.name}): ${how}` })
      await stopCwdProcesses()
      if (proc && !pidAlive(w.pid)) releaseWorkerProcessPort(proc)
      return how + cleanupText()
    }

  const startWorkersBridge = (lead: import('../session.js').Session, s: import('../session.js').Session): Bridge => {
    const bridge = new Bridge(lead, s, { log, debounceMs: ctx.conflictDebounceMs === 0 ? 0 : undefined })
    bridge.start()
    ctx.attachChannel?.(s)
    return bridge
  }
  Object.assign(state, { myWorkers, workerAlive, ensureWorkersRoom, closeWorkersRoom, runningWorkers, dismissWorker, startWorkersBridge })
}
