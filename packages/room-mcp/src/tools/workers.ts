import { claudeWakeNote } from '../prompt.js'
import { Bridge } from '../bridge.js'
import { pidPresent, pidIsOurWorker, probeProcess, signalWorker, terminateWorktreeProcesses } from '../worker-process.js'
import { WORKER_EFFORTS } from '../worker-config.js'
import { prepareWorkerLinks, resolveWorkerLinks } from '../worker-git.js'
import { decideStop, workerRealState } from '../worker-state.js'
import { releaseClaimsOnDone } from './claims.js'
import { publisherLine, retainedList } from './share.js'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { completionMessage, manifestPaths, type DoneMsg, type NoteMsg, type Worker } from '@room/shared'
import { parseShare } from '@room/roomd'
import { git } from '@room/roomd/git'
import { toolCallAborted, workerOrigin } from '../registry.js'
import { LOCAL, refreshBrowserUrl, type Session } from '../session.js'
import { workerBudget, hostWorkerEffort, validTag, type WorkerHost } from '../worker-config.js'
import { prepareWorktree, uncommittedCount, type PreparedWorktree } from '../worker-git.js'
import { launchWorkerProcess, WorkerLaunchError } from '../worker-launch.js'
import { branchOf } from '../prs.js'
import { SHARE, RW, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'
import { resolveConfig } from '../config.js'
import { releaseWorkerProcessPort } from '../port-reservations.js'
import { registryForDir, registrySnapshotForDir, type WorkerRegistry } from '../worker-registry.js'
import { realStateInput, type WorkerRecord } from '../worker-status.js'
import { postWorkerMessage } from '../post.js'
import { mirrorRegistryWorkerRecord } from '../worker-mirror.js'

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
      const myId = ctx.config?.workerId ?? process.env.ROOM_WORKER_ID
      const registry = myId ? await registryForDir(s.dir) : undefined
      const ownRecord = myId ? registry?.read(myId) : undefined
      const ownRun = ownRecord?.runs.at(-1)
      // Claims mirroring a worker that is still running are the worker's, not this task's.
      const live = new Set(runningWorkers(s).map(x => x.w.tag))
      const kept = mine(s).filter(c => c.mirrorOf && live.has(c.mirrorOf)).length
      let released = 0
      const release = () => { released = releaseClaimsOnDone(s, c => !!c.mirrorOf && live.has(c.mirrorOf)) }
      if (myId) {
        if (!ownRecord || !ownRun) return 'error: this worker run was collected, discarded or superseded'
        if (process.env.ROOM_WORKER_RUN && Number(process.env.ROOM_WORKER_RUN) !== ownRun.n
          || process.env.ROOM_LAUNCH_NONCE && process.env.ROOM_LAUNCH_NONCE !== ownRun.nonce) {
          return 'error: this worker run was collected, discarded or superseded'
        }
        const changed = manifestPaths(s.room, s.me.name)
        try {
          await registry!.reportDone(myId, ownRun.n, summary, changed)
          release()
          await registry!.postCompletion(myId, ownRun.n, async (id, record, report) => {
            const message = completionMessage(record, ownRun, registry!.status(myId)!, report)
            if (!message || message.id !== id || message.body.type !== 'done') throw new Error('worker completion message unavailable')
            const posted = await s.post<DoneMsg>(s.me, message.body, { id, auto: true })
            if (!posted.ok) throw new Error(posted.text)
          })
        } catch (error) { return `error: could not record worker report: ${error instanceof Error ? error.message : String(error)}` }
      } else {
        release()
        await s.post<NoteMsg>(s.me, { type: 'note', text: `done${sc ? ` (${sc.area})` : ''}: ${summary}` })
      }
      await s.policyStore.declare([])
      setPresence(s, { cursor: undefined, status: `done: ${summary.slice(0, 60)}` })
      s.daemon.touch()
      const out = [`marked done${sc ? ` (${sc.area})` : ''}; released ${released} claim(s)${kept ? ` (kept ${kept} mirroring running workers)` : ''}, scope cleared. ${ownRecord ? `Your lead ${ownRecord.lead.participant} has been told (worker ${ownRecord.tag}); your work is on branch ${ownRecord.branch} in ${ownRecord.dir}. Finish now; your lead can resume this session for follow-up work while its worktree remains.` : 'You remain in the room.'}`]
      const secondary = publisherLine(s)
      if (secondary) out.push(secondary)
      else {
        const retained = s.daemon.share === 'declared' ? [...s.policyStore.retained] : []
        if (retained.length) out.push(`${retained.length} changed file(s) you declared earlier stay shared while they differ from your base: ${retainedList(retained)}. A sharing-level change, an ignore rule or the size limit also withdraws them. To withdraw them now, say: share plans only.`)
      }
      const localTestsFailed = /(?:local.{0,40}(?:tests?|checks?|suite).{0,40}fail|(?:tests?|checks?|suite).{0,40}fail.{0,40}local)/i.test(summary)
      const command = s.lastPreview?.testsCommand
      if (localTestsFailed && s.lastPreview?.clean && s.lastPreview.complete && s.lastPreview.testsPassed === true && command) {
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
      const config = await resolveConfig({ dir: s.dir, env: process.env, args: { maxWorkers: ctx.maxWorkers } })
      const max = config.maxWorkers
      const share = typeof a.share === 'string' && a.share ? parseShare(a.share) : undefined
      if (typeof a.share === 'string' && a.share && !share) return 'error: share must be intent, declared or full'
      const registry = await registryForDir(s.dir)
      const id = registry.newId(), nonce = randomUUID()
      const owner = s.me.owner ?? s.me.name, name = `${owner}+${tag}`
      const { server, isWorker } = workerOrigin(s)
      const count = registry.occupancy()
      const cores = Math.max(1, os.availableParallelism?.() ?? os.cpus().length)
      const budget = workerBudget({ cores, memBytes: os.totalmem(), maxWorkers: max, running: count })
      const inheritedThreads = Number(process.env.ROOM_WORKER_THREADS), inheritedMem = Number(process.env.ROOM_WORKER_MEM_GB)
      const divisor = isWorker ? Math.max(2, max) : 1
      const threadShare = Number.isSafeInteger(inheritedThreads) && inheritedThreads >= 1 ? Math.max(1, Math.floor(inheritedThreads / divisor)) : budget.threads
      const threads = typeof a.threads === 'number' ? Math.min(a.threads, threadShare) : threadShare
      const memGb = Number.isFinite(inheritedMem) && inheritedMem >= 1 ? Math.max(1, Math.floor(inheritedMem / divisor)) : budget.memGb
      const effectiveShare = share ?? s.daemon.share ?? 'full'
      let linkPaths: string[]
      try { linkPaths = resolveWorkerLinks(lead.dir, a.link) }
      catch (e) { return `error: could not link inputs: ${e instanceof Error ? e.message : String(e)}` }
      const suppliedDir = typeof a.dir === 'string' && a.dir ? path.resolve(a.dir) : undefined
      const dir = suppliedDir ?? path.join(s.dir, '.room', 'workers', tag)
      if (suppliedDir && !fs.existsSync(dir)) return `error: ${dir} does not exist`
      const relative = path.relative(s.dir, dir)
      const outside = relative.startsWith('..') || path.isAbsolute(relative)
      if (outside && a.allowOutside !== true) return `error: ${dir} is outside this repo (${s.dir}); pass allowOutside=true to run a worker there anyway (no worktree bookkeeping, its branch is whatever HEAD is there)`
      const branch = suppliedDir ? (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '?')).trim() : `room/${tag}`
      const hostSessionId = host === 'claude' ? randomUUID() : undefined
      const usedPorts = registry.list().flatMap(record => typeof record.port === 'number' ? [record.port] : [])
      const prep = { step: 'plan' as const, worktreeExisted: fs.existsSync(dir), created: !suppliedDir && !fs.existsSync(dir) }
      const record: WorkerRecord = {
        v: 1, id, tag, name, mode: s === lead ? 'here' : 'local', room: s.roomName,
        lead: { participant: s.me.name, room: s.roomName, instance: registry.instance },
        host, model, effort, budget: { threads, memGb, nice: 10 }, share: effectiveShare, task,
        dir, outside, branch, prep, hostSessionId,
        capabilities: { resume: true, signal: true, collect: outside ? 'none' : 'delta' }, phase: 'intent',
        runs: [{ n: 1, mode: 'fresh', intentAt: now(), nonce, busFrontier: s.room.messages().map(message => message.id), promptMsgIds: [], launcher: registry.instance, logStart: 0 }],
        createdAt: now(), seq: 1,
      }
      try { await registry.writeIntent(record, max) }
      catch (error) { return `error: ${error instanceof Error ? error.message : String(error)}` }
      try {
        let base: string | undefined, created = false
        let carried: PreparedWorktree['carried'], carryFailed = false, carryError: string | undefined
        let carriedBase: string | undefined, carriedUntracked: PreparedWorktree['carriedUntracked'], skippedCarry: PreparedWorktree['skippedCarry']
        let prepared: PreparedWorktree | undefined
        if (!suppliedDir) {
          await registry.update(id, old => ({ ...old, phase: 'preparing', seq: old.seq + 1 }))
          try {
            prepared = await (ctx.worktree ? ctx.worktree(s.dir, tag) : prepareWorktree(s.dir, tag, s.me.name, linkPaths,
              async (step, facts) => { await registry.update(id, old => ({ ...old,
                prep: { ...old.prep, ...facts, step }, seq: old.seq + 1 })) }, 0, a.carry !== false))
            base = prepared.base; created = prepared.created
            carried = prepared.carried; carryFailed = prepared.carryFailed ?? false; carryError = prepared.carryError
            carriedBase = prepared.carriedBase; carriedUntracked = prepared.carriedUntracked; skippedCarry = prepared.skippedCarry
          }
          catch (e) { throw new Error(`could not create a worktree for ${tag}: ${e instanceof Error ? e.message : String(e)}`) }
        }
        await registry.update(id, old => ({ ...old, phase: 'prepared', prep: { ...old.prep, step: 'prepared', created,
          branchCreated: prepared?.branchCreated, branchExisted: old.prep.branchExisted ?? (prepared?.branchCreated ? false : undefined) },
          base, carriedBase, carriedUntracked, skippedCarry, seq: old.seq + 1 }))
        if (toolCallAborted()) throw new Error('tool call cancelled')
        let link: string[]
        try { link = prepareWorkerLinks(lead.dir, dir, linkPaths) }
        catch (e) { throw new Error(`could not link inputs: ${e instanceof Error ? e.message : String(e)}`) }
        let launched: Awaited<ReturnType<typeof launchWorkerProcess>>
        try {
          launched = await launchWorkerProcess({ session: s, id, tag, dir, lead: s.me.name, owner,
            host, model, effort, share: effectiveShare, run: 1, nonce, registry: registry.root, budget: { threads, memGb }, server,
            isWorker, token: s.local ? undefined : s.token, claudeChannel: config.claudeChannel,
            usedPorts, spawner: ctx.spawner, probe: ctx.probe, log: state.log, at: now },
          { mode: 'fresh', task, links: link, carriedPaths: carried?.paths, sessionId: hostSessionId },
          { setHandle: (workerId, proc) => rooms.setHandle(s, workerId, proc),
            watch: (_workerId, proc, onExit) => proc.onExit(onExit), aborted: toolCallAborted },
          async pid => { await registry.update(id, old => ({ ...old, runs: [{ ...old.runs[0], launch: { outcome: 'launched', pid } }], seq: old.seq + 1 })) },
          async result => {
            await registry.update(id, old => ({ ...old, phase: 'active', port: result.port,
              budget: { ...old.budget, nice: result.nice }, link,
              runs: [{ ...old.runs[0], launch: { outcome: 'launched', pid: result.proc.pid,
                ...(result.processStartTime ? { process: { pid: result.proc.pid, startTime: result.processStartTime, executable: (ctx.probe ?? probeProcess)(result.proc.pid)?.executable ?? '' } } : {}) } }], seq: old.seq + 1 }))
            mirrorRegistryWorkerRecord(s, registry, id)
          }, async code => {
            await registry.writeExit(id, { run: 1, code, witnessed: true, at: now() })
            rooms.dropHandle(s, id)
            await registry.postObservedFailure(id, 1, message => postWorkerMessage(s.post, record, message))
          })
        } catch (e) {
          const error = e instanceof WorkerLaunchError ? e : new WorkerLaunchError('start', String(e))
          if (error.delivered) {
            const reason = error.phase === 'cancelled' ? 'message-delivered-cancelled' : 'message-delivered-failed'
            await registry.beginStop(id, reason)
            if (!error.stopped) return `error: stop unconfirmed for ${tag} (pid ${error.pid}); it may still be running in ${dir}. Worker record and worktree kept; use room_collect discard=true when it is safe to remove.`
            return `error: stopped after start: ${error.phase === 'cancelled' ? 'cancelled' : error.message}; worker record and worktree kept in ${dir}. Use room_collect to collect or discard it.`
          }
          const prefix = error.phase === 'port' ? 'could not allocate a worker port: '
            : error.phase === 'budget' || error.phase === 'cancelled' ? ''
            : `could not start ${host}: `
          if (!registry.read(id)?.runs[0].launch) {
            await registry.abandonPreparation(id)
            return `error: ${prefix}${error.message}`
          }
          await registry.update(id, old => ({ ...old, phase: 'active', seq: old.seq + 1 }))
          return `error: ${prefix}${error.message}`
        }
        const { proc, port, env, nice, logFile } = launched
        await s.post<NoteMsg>(s.me, { type: 'note', text: `spawned worker ${tag} (${host}${model ? ` ${model}` : ''}) as ${name}: ${task.slice(0, 100)}` })
        const out = [`spawned ${tag}: ${name} (${host}${model ? ` ${model}` : ''}, pid ${proc.pid})${port === undefined ? '' : ` port ${port}`} in ${dir} on branch ${branch}${created ? ' (new worktree)' : ''}`]
        const wakeNote = claudeWakeNote(lead, 'spawn')
        if (wakeNote) out.unshift(wakeNote)
        out.push(`budget in prompt: ${threads} threads, ~${env.ROOM_WORKER_MEM_GB} GB · priority ${nice ? `nice ${nice}` : 'normal'}${effort ? ` · effort ${effort}` : ''}${link.length ? ` · inputs ${link.join(', ')}` : ''}`)
        out.push(`log: ${logFile}`)
        if (!spawnExplained.has(lead)) out.push(`browser view: ${await refreshBrowserUrl(s)}`)
        if (!spawnExplained.has(lead)) out.push(`it joins ${s === lead ? 'this room' : `the local workers room ${s.roomName} (not the team server; the team room sees its scope and claims as yours)`} and reports through room_done; block on room_wait and answer its questions promptly.`)
        spawnExplained.add(lead)
        if (carried || skippedCarry?.length) {
          const copied = carriedUntracked?.length ?? 0
          const tracked = Math.max(0, (carried?.paths?.length ?? carried?.count ?? 0) - copied)
          const parts = [
            ...(tracked ? [`${tracked} tracked change${tracked === 1 ? '' : 's'} (commit ${carried!.commit.slice(0, 10)})`] : []),
            ...(copied ? [`${copied} untracked file${copied === 1 ? '' : 's'} copied`] : []),
          ]
          out.push(`${parts.length ? `carried your uncommitted work into its worktree: ${parts.join(', ')}` : 'no uncommitted work carried'}${skippedCarry?.length ? `; not carried: ${skippedCarry.map(({ path: p, reason }) => `${p} (${reason})`).join(', ')}` : ''}`)
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
      } catch (error) {
        await registry.abandonPreparation(id).catch(cleanup => { state.log(`worker preparation cleanup: ${cleanup}`) })
        return `error: ${error instanceof Error ? error.message : String(error)}`
      } finally { await registry.finishOperation(id) }
    },

  }
  return handlers
}


export function registryRunningWorkers(s: Session, rooms: import('../registry.js').Rooms): { s: Session; w: Worker }[] {
  const registry = registrySnapshotForDir(s.dir)
  return registry.list().flatMap(record => {
    const status = registry.status(record.id)
    if (!status || record.lead.participant !== s.me.name) return []
    const room = rooms.all().find(candidate => candidate.roomName === record.room) ?? s
    const liveHandle = rooms.hasHandle(room, realStateInput(record, status))
    if (!['starting', 'running', 'unknown', 'ambiguous'].includes(status.status) && !liveHandle) return []
    return [{ s: room, w: realStateInput(record, status) }]
  })
}

export function createWorkerRuntime(deps: Pick<HandlerState, 'ctx' | 'rooms' | 'doJoin' | 'doLeave' | 'log' | 'cleanupMine' | 'now'>): Pick<HandlerState, 'myWorkers' | 'workerAlive' | 'ensureWorkersRoom' | 'closeWorkersRoom' | 'runningWorkers' | 'dismissWorker' | 'startWorkersBridge'> {
  const { ctx, rooms, doJoin, doLeave, log, cleanupMine, now } = deps
  const myWorkers = (s: Session): Worker[] => Array.from(s.room.workers.values()).filter(w => w.lead === s.me.name)
  const workerAlive = (s: Session, w: Worker): boolean => rooms.hasHandle(s, w) || pidIsOurWorker(w.pid, w, ctx.probe)
  const ensureWorkersRoom = async (lead: Session): Promise<Session> => {
      if (lead.local) return lead
      const have = rooms.workers()
      if (have) return have
      const ws = await doJoin({ dir: lead.dir, server: LOCAL, name: lead.me.owner ?? lead.me.name, tag: lead.me.label, log })
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
  const runningWorkers = (s: Session): { s: Session; w: Worker }[] => registryRunningWorkers(s, rooms)
  const dismissWorker = async (s: Session, w: Worker, why: string, stopReason?: Worker['stopReason'], cancelled?: AbortSignal): Promise<string> => {
      const registry = await registryForDir(s.dir)
      const trusted = await registry.trusted({ participant: s.me.name, room: s.roomName, dir: s.dir }, w.tag)
      if (!trusted || trusted.record.id !== w.id) return `error: ${w.tag} has no local worker capability; not signalled`
      let acquired: boolean
      try { acquired = await registry.beginOperation(w.id!, 'stop') }
      catch { return `error: ${w.tag} is already being handled; not signalled` }
      try {
      const alreadyStopping = !!trusted.record.stop
      const reason = stopReason ?? (why === 'discarded by the lead' ? 'discarded' : 'lead-session-ended')
      await registry.beginStop(w.id!, reason)
      w = realStateInput(trusted.record, trusted.status)
      const proc = rooms.handle(s, w.id)
      if (!proc) {
        const processState = await workerRealState(s.dir, w, { process: true, probe: ctx.probe })
        if (processState.process === 'not-ours' && pidPresent(w.pid, ctx.probe)) return `pid ${w.pid} belongs to another process; not signalled`
        if (processState.process === 'unknown') {
          const message = `could not verify ${w.tag}'s process (pid ${w.pid}); left running, not stopped`
          await s.post<NoteMsg>(s.me, { type: 'note', to: w.lead, priority: 'interrupt', text: message }, { auto: true })
          return message
        }
        if (processState.process !== 'ours') return `pid ${w.pid} not signalled: the process is gone; worker record kept`
      }
      // The host's exit can also take down its dev-server children. Name and stop
      // those while they are still visible, but leave the host pid for its own handle.
      const protectedPids = w.pid ? [w.pid] : []
      const ownedWorktree = decideStop(await workerRealState(s.dir, w, { ownership: true, leadName: s.me.name, workers: [...s.room.retiredWorkers(), ...s.room.workers.values()] })).cwd
      const stopped: string[] = []
      let cleanupError: string | undefined
      const stopCwdProcesses = async () => {
        if (!ownedWorktree || cleanupError) return
        try { stopped.push(...await terminateWorktreeProcesses(w.dir, { protectedPids, probe: ctx.probe, list: ctx.listCwdProcesses })) }
        catch (e) { cleanupError = `cwd process cleanup failed: ${e instanceof Error ? e.message : String(e)}` }
      }
      const cleanupText = () => (stopped.length ? `; stopped processes: ${stopped.join(', ')}` : '') + (cleanupError ? `; ${cleanupError}` : '')
      await stopCwdProcesses()
      if (proc && alreadyStopping && why !== 'discarded by the lead') {
        return `pid ${w.pid} already signalled; waiting for exit${cleanupText()}`
      }
      let how: string, signalled: boolean
      if (proc) {
        signalled = proc.kill()
        how = signalled ? `pid ${w.pid} signalled` : `pid ${w.pid} not signalled: the process is already gone`
      } else if (decideStop(await workerRealState(s.dir, w, { process: true, probe: ctx.probe })).host === 'signal') {
        signalled = signalWorker(w.pid, 'SIGTERM', undefined, undefined, w, ctx.probe)
        how = signalled ? `pid ${w.pid} signalled` : `pid ${w.pid} not signalled (it exited just now, or is not ours to signal)`
      } else {
        signalled = false
        how = `pid ${w.pid} not signalled: it is not alive, or not a process started for this worker (this session did not spawn it)`
      }
      if (!signalled && pidPresent(w.pid, ctx.probe)) how = proc
        ? `pid ${w.pid} not signalled: worker process is still alive`
        : `could not verify ${w.tag}'s process (pid ${w.pid}); left running, not stopped`
      await stopCwdProcesses()
      if (proc && !pidPresent(w.pid, ctx.probe)) releaseWorkerProcessPort(proc)
      // The stop fact was committed before any signal.
      if (cancelled?.aborted) return how + cleanupText()
      if (stopReason && cleanupError) throw new Error(cleanupError)
      if ((signalled || proc || pidPresent(w.pid, ctx.probe)) && !(signalled && !stopReason && why === 'discarded by the lead' && w.lead === s.me.name)) await s.post<NoteMsg>(s.me, { type: 'note', to: w.lead, priority: signalled ? 'notify' : 'interrupt', text: signalled ? `dismissed worker ${w.tag} (${w.name}): ${why}` : `could not dismiss worker ${w.tag} (${w.name}): ${how}` }, { auto: true })
      return how + cleanupText()
      } finally { if (acquired) await registry.finishOperation(w.id!) }
    }

  const startWorkersBridge = (lead: import('../session.js').Session, s: import('../session.js').Session): Bridge => {
    const bridge = new Bridge(lead, s, { log, debounceMs: ctx.conflictDebounceMs === 0 ? 0 : undefined })
    bridge.start()
    ctx.attachChannel?.(s)
    return bridge
  }
  return { myWorkers, workerAlive, ensureWorkersRoom, closeWorkersRoom, runningWorkers, dismissWorker, startWorkersBridge }
}
