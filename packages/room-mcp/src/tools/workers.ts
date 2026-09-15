import fs from 'node:fs'
import path from 'node:path'
import { type DoneMsg, type NoteMsg, type Worker } from '@room/shared'
import { parseShare } from '@room/roomd'
import { git } from '@room/roomd/git'
import { workerId, workerIdBase } from '../registry.js'
import { LOCAL } from '../session.js'
import { DEFAULT_MAX_WORKERS, defaultSpawner, prepareWorktree, validTag, workerCommand, workerPrompt, type SpawnedProcess, type WorkerHost } from '../workers.js'
import { branchOf } from '../prs.js'
import { SHARE, RO, RW, int, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'

export const defs: ToolDef[] = [
  { name: 'room_done', annotations: RW, description: 'Mark your current task finished: releases any claims you still hold, clears your scope, and posts a one-line completion note. Call after your final room_preview_merge, before reporting to your human. Stay in the room for questions.',
    inputSchema: { type: 'object', properties: { summary: str('one line: what landed and the test result'), pr_note: { type: 'boolean', description: 'also post the branch ledger as a comment on the open PR whose head is this branch (room_pr_note), if there is one' } }, required: ['summary'] } },
  { name: 'room_spawn', annotations: RW, description: 'Dispatch a worker agent into this room to do a task in parallel with you. It runs in its own git worktree (<repo>/.room/workers/<tag>, branch room/<tag> from HEAD), joins as <you>+<tag>, follows the room etiquette, and reports back with room_done (you are woken). Use for independent subtasks; keep answering its questions; merge its branch when it is done. Max running workers per lead: ROOM_MAX_WORKERS (8).',
    inputSchema: { type: 'object', properties: { tag: str('short name, e.g. money or tiers; becomes the worker name suffix and branch room/<tag>'), task: str('what the worker should do, self-contained'), host: { type: 'string', enum: ['claude', 'codex'], description: 'which agent runs it (default claude)' }, model: str('model override for that host (optional)'), share: SHARE, allowOutside: { type: 'boolean', description: 'permit dir outside this repo (no worktree bookkeeping)' }, dir: str('use this existing directory instead of creating a worktree'), where: { type: 'string', enum: ['here', 'local'], description: 'here (default): the room you are in. local: a local workers room on this machine even while you are in a team room; the workers never touch the server, and the team room sees their work as yours (scope union, mirrored claims).' } }, required: ['tag', 'task'] } },
  { name: 'room_dismiss', annotations: RW, description: 'Stop a worker you spawned (SIGTERM to its process). Its worktree and branch are kept so you can inspect or merge what it did.',
    inputSchema: { type: 'object', properties: { tag: str('the worker tag') }, required: ['tag'] } }
]

export function handlers(state: HandlerState): Record<string, Handler> {
  const { S, ensureWorkersRoom, workerAlive, myWorkers, mine, ctx, rooms, now, gitignored, dismissWorker, runningWorkers, cleanupMine, setPresence, refreshPrs, myPr, postLedger } = state
  const handlers: Record<string, Handler> = {
    async room_done(a) {
      const s = S()
      const summary = String(a.summary ?? '').trim()
      if (!summary) return 'error: summary is required'
      const sc = s.room.scope(s.me.name)
      // Claims mirroring a worker that is still running are the worker's, not this task's: they stay until it finishes.
      const live = new Set(runningWorkers(s).map(x => x.w.tag))
      const kept = mine(s).filter(c => c.mirrorOf && live.has(c.mirrorOf)).length
      const released = cleanupMine(s, `done: ${summary}`, c => !!c.mirrorOf && live.has(c.mirrorOf))
      const asWorker = s.room.workerOf(s.me.name)
      // A worker finishes only the record of its own spawn (ROOM_WORKER_ID; older leads passed ROOM_GEN): a stale
      // process of a reused tag must not mark the lead's current worker done. Its report still reaches the lead.
      const myId = process.env.ROOM_WORKER_ID?.trim(), gen = process.env.ROOM_GEN?.trim()
      const stale = !!asWorker && (myId ? asWorker.id !== undefined && asWorker.id !== myId : !!gen && asWorker.gen !== undefined && String(asWorker.gen) !== gen)
      if (asWorker) {
        if (!stale) s.room.updateWorker(asWorker.tag, { status: 'done', summary }, asWorker.id)
        s.room.post<DoneMsg>(s.me, { type: 'done', tag: asWorker.tag, summary: stale ? `${summary} (from an earlier generation of ${asWorker.tag}; the current worker's record was left alone)` : summary, changed: s.room.changedPaths(s.me.name), to: asWorker.lead, priority: 'notify' })
      } else {
        s.room.post<NoteMsg>(s.me, { type: 'note', text: `done${sc ? ` (${sc.area})` : ''}: ${summary}` })
      }
      setPresence(s, { cursor: undefined, status: `done: ${summary.slice(0, 60)}` })
      s.daemon.touch()
      const out = [`marked done${sc ? ` (${sc.area})` : ''}; released ${released} claim(s)${kept ? ` (kept ${kept} mirroring running workers)` : ''}, scope cleared. ${asWorker ? `Your lead ${asWorker.lead} has been told (worker ${asWorker.tag}); your work is on branch ${asWorker.branch} in ${asWorker.dir}. Stay until asked, then finish.` : 'You are still in the room and will be woken for questions.'}`]
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
      if (a.where !== undefined && a.where !== 'here' && a.where !== 'local') return 'error: where must be here or local'
      let s = lead
      if (a.where === 'local' && !lead.local) {
        try { s = await ensureWorkersRoom(lead) }
        catch (e) { return `error: could not open the local workers room: ${e instanceof Error ? e.message : String(e)}` }
      }
      const tag = validTag(a.tag)
      if (!tag) return 'error: tag must be 1-40 chars of letters, digits, _ or -'
      const task = String(a.task ?? '').trim()
      if (!task) return 'error: task is required'
      const host: WorkerHost = a.host === 'codex' ? 'codex' : 'claude'
      const model = typeof a.model === 'string' && a.model.trim() ? a.model.trim() : undefined
      const idBase = workerIdBase(s.roomName, s.me.name, tag)
      const existing = s.room.workers.get(tag)
      if (existing && existing.lead !== s.me.name && existing.status === 'running') return `error: tag ${tag} is in use by ${existing.lead}'s worker in this room; pick another tag`
      if (existing && (existing.status === 'running' || workerAlive(s, existing))) return `error: worker ${tag} is ${existing.status === 'running' ? 'already running' : `${existing.status} but its process is still alive`} (pid ${existing.pid}); room_dismiss it first or pick another tag`
      const gen = (existing?.gen ?? 0) + 1
      const id = workerId(s.me.name, tag, gen)
      const running = myWorkers(s).filter(w => w.status === 'running')
      const max = ctx.maxWorkers ?? Number(process.env.ROOM_MAX_WORKERS ?? DEFAULT_MAX_WORKERS)
      if (running.length >= max) return `error: ${running.length} workers already running (max ${max}, ROOM_MAX_WORKERS); wait for one to finish or room_dismiss it`
      const share = typeof a.share === 'string' && a.share ? parseShare(a.share) : undefined
      if (typeof a.share === 'string' && a.share && !share) return 'error: share must be intent, declared or full'
      // The tag is reserved from here until the process record exists (or this call fails): the worktree
      // preparation below awaits git, and a second room_spawn for the same tag must not slip in meanwhile.
      if (!rooms.reserve(idBase)) return `error: worker ${tag} is being spawned right now (another room_spawn is preparing its worktree); pick another tag`
      try {
        let dir: string, branch: string, created = false, outside = false
        if (typeof a.dir === 'string' && a.dir) {
          dir = path.resolve(a.dir)
          if (!fs.existsSync(dir)) return `error: ${dir} does not exist`
          const inside = path.relative(s.dir, dir)
          outside = inside.startsWith('..') || path.isAbsolute(inside)
          if (outside && a.allowOutside !== true) return `error: ${dir} is outside this repo (${s.dir}); pass allowOutside=true to run a worker there anyway (no worktree bookkeeping, its branch is whatever HEAD is there)`
          try { branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() } catch { branch = '?' }
        } else {
          try { ({ dir, branch, created } = await (ctx.worktree ?? prepareWorktree)(s.dir, tag)) }
          catch (e) { return `error: could not create a worktree for ${tag}: ${e instanceof Error ? e.message : String(e)}` }
        }
        const owner = s.me.owner ?? s.me.name
        const name = `${owner}+${tag}`
        const prompt = workerPrompt(s.me.name, tag, task)
        const { cmd, args } = workerCommand(host, model, prompt)
        // The worker's room variables are set here in full; defaultSpawner strips the lead's own ROOM_* first
        // (ROOM_URL/ROOM_NAME/ROOM_DIR from a runner would otherwise send it into the lead's room as the lead).
        // The server URL is passed without its query: a shared token travels only as ROOM_TOKEN.
        const server = s.local ? LOCAL : s.roomUrl.slice(0, s.roomUrl.lastIndexOf('/'))
        const env: Record<string, string> = {
          ROOM_SERVER: server, ROOM_ROOM: s.roomName, ROOM_DIR: dir, PWD: dir, ROOM_TAG: tag, ROOM_LEAD: s.me.name, ROOM_OWNER: owner,
          ROOM_SHARE: share ?? s.daemon.share ?? 'full', ROOM_GEN: String(gen), ROOM_WORKER_ID: id,
          ...(s.token && !s.local ? { ROOM_TOKEN: s.token } : {}),
          ROOM_LOG_FILE: path.join(s.dir, '.room', 'workers', `${tag}.mcp.log`),
        }
        const logFile = path.join(s.dir, '.room', 'workers', `${tag}.log`)
        let proc: SpawnedProcess
        try { proc = (ctx.spawner ?? defaultSpawner)({ cmd, args, cwd: dir, env, logFile }) }
        catch (e) { return `error: could not start ${cmd}: ${e instanceof Error ? e.message : String(e)}` }
        rooms.setHandle(s, id, proc)
        const w: Worker = { id, tag, name, host, ...(model ? { model } : {}), task, dir, branch, pid: proc.pid, startedAt: now(), status: 'running', lead: s.me.name, gen }
        s.room.setWorker(w)
        // Callbacks resolve the record by this spawn's id: a reused tag has a new id, so an older process
        // (or another lead's record under the same tag) is simply not found and touches nothing.
        proc.onError?.(err => {
          rooms.dropHandle(s, id, proc)
          const cur = s.room.workerById(id)
          if (!cur) return
          if (cur.status === 'running') s.room.updateWorker(tag, { status: 'failed', exitCode: -1, summary: `could not start ${cmd}: ${err.message}` }, id)
          s.room.post<NoteMsg>(s.me, { type: 'note', to: s.me.name, priority: 'notify', text: `worker ${tag} (${name}) could not start: ${err.message}; is ${cmd} installed?` })
        })
        proc.onExit(code => {
          rooms.dropHandle(s, id, proc) // this process is gone whatever record the tag holds now
          const cur = s.room.workerById(id)
          if (!cur) return
          if (cur.status !== 'running') { s.room.updateWorker(tag, { exitCode: code ?? -1 }, id); return }
          const summary = cur.summary ?? (code === 0 ? 'process exited without room_done' : `process exited with code ${code}`)
          s.room.updateWorker(tag, { status: code === 0 ? 'done' : 'failed', exitCode: code ?? -1, summary }, id)
          s.room.post<NoteMsg>(s.me, { type: 'note', to: s.me.name, priority: 'notify', text: `worker ${tag} (${name}) exited with code ${code}${code === 0 ? '' : `; see ${logFile}`}` })
          // An exit without room_done still ends the lead's wait: post the done message the worker never sent, as the worker.
          s.room.post<DoneMsg>({ name, kind: 'agent', owner, label: tag }, { type: 'done', tag, summary: `${summary} (exit ${code})`, changed: s.room.changedPaths(name), to: s.me.name, priority: 'notify' })
        })
        s.room.post<NoteMsg>(s.me, { type: 'note', text: `spawned worker ${tag} (${host}${model ? ` ${model}` : ''}) as ${name}: ${task.slice(0, 100)}` })
        const out = [`spawned ${tag}: ${name} (${host}${model ? ` ${model}` : ''}, pid ${proc.pid}) in ${dir} on branch ${branch}${created ? ' (new worktree)' : ''}`]
        out.push(`log: ${logFile}`)
        out.push(`it joins ${s === lead ? 'this room' : `the local workers room ${s.roomName} (not the team server; the team room sees its scope and claims as yours)`} on its own, declares a scope, and posts room_done to you when finished (you will be woken). room_state shows it under "workers"; answer its questions promptly.`)
        if (created && !gitignored(s.dir)) out.push('tip: add .room/ to .gitignore (the room already ignores it; git status will not).')
        if (outside) out.push(`note: ${dir} is outside this repo, so no worktree was made and nothing is tracked for it beyond the pid; its work stays wherever that checkout puts it.`)
        return out.join('\n')
      } finally {
        rooms.unreserve(idBase)
      }
    },
    async room_dismiss(a) {
      const tag = validTag(a.tag)
      if (!tag) return 'error: tag is required'
      const s = rooms.holdingWorker(tag, S())
      const w = s.room.workers.get(tag)
      if (!w) return `error: no worker ${tag}`
      if (w.lead !== s.me.name) return `error: worker ${tag} was spawned by ${w.lead}, not you`
      if (w.status !== 'running' && !workerAlive(s, w)) return `worker ${tag} is already ${w.status}; its work is on branch ${w.branch} in ${w.dir}`
      const how = dismissWorker(s, w, w.status === 'running' ? 'dismissed by the lead' : `its process was stopped by the lead after it reported ${w.status}`)
      return `${w.status === 'running' ? 'dismissed' : `stopped the ${w.status} worker`} ${tag} (${how}); its work is on branch ${w.branch} in ${w.dir}`
    }
  }
  return handlers
}
