// SessionStart: record this host session in room/sessions/<sid>/session.json (registry §17), with the
// ancestor chain the MCP matches against its parent to bind to this session. The host comes from
// `--host <name>` on the command line (hooks/claude.json passes `--host claude`; the Codex hooks.json
// passes nothing). Then try a short select from the MCP, which may not be running yet: owed items and
// local notices print only after a confirmed handoff; otherwise only the company line.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readStdinJson, gitRoot, sessionDir, readJson, writeJsonAtomic, openMcp, writeStdout, processChain, companyLine } from './common.mjs'

const ev = readStdinJson()
const root = gitRoot(ev.cwd)
const id = ev.session_id ?? ev.thread_id ?? ev.sessionId
const flag = process.argv.indexOf('--host')
const host = flag >= 0 && process.argv[flag + 1] ? process.argv[flag + 1] : 'codex'
if (!root || typeof id !== 'string' || !id) {
  try { fs.appendFileSync(path.join(os.tmpdir(), 'room-hook.log'), `${new Date().toISOString()} session-start: no root/id; keys=${Object.keys(ev).join(',')} cwd=${ev.cwd}\n`) } catch { /* ignore */ }
  process.exit(0)
}
const dir = sessionDir(root, id)
const now = Date.now()
const chain = processChain()
const hostName = new RegExp(`^${host}(?:[.-]|$)`, 'i')
writeJsonAtomic(path.join(dir, 'session.json'), {
  session_id: id, host, cwd: ev.cwd, at: now, chain,
  hostPid: chain.find(p => hostName.test(p.executable ?? ''))?.pid ?? chain[0]?.pid ?? process.ppid,
  ...(typeof ev.source === 'string' ? { source: ev.source } : {}),
  ...(process.env.ROOM_WORKER_ID ? { worker_id: process.env.ROOM_WORKER_ID } : {}),
  ...(host === 'claude' && typeof ev.transcript_path === 'string' && ev.transcript_path ? { transcript_path: ev.transcript_path } : {}),
  ...(typeof ev.model === 'string' && ev.model.trim() ? { model: ev.model.trim().slice(0, 80) } : {}),
  ...(typeof ev.effort?.level === 'string' && ev.effort.level.trim() ? { effort: ev.effort.level.trim().slice(0, 80) } : {}),
})

const state = readJson(path.join(dir, 'state.json'), null)
const fresh = typeof state?.at === 'number' && state.at <= now && now - state.at < 60_000
const announced = fresh && typeof state.room === 'string' && state.room.length > 0 && state.company === true
writeJsonAtomic(path.join(dir, 'hook.json'), { ...readJson(path.join(dir, 'hook.json'), {}), companyTold: announced })

const lines = []
let confirm
const mcp = await openMcp(dir, 300)
const selected = mcp && await mcp.request({ op: 'select', sessionId: id, startup: true })
if (selected?.ok) {
  lines.push(...selected.notices)
  if (selected.items.length) {
    lines.push(`[room inbox ${selected.items.length}]`)
    for (const m of selected.items) lines.push(`  ${m.line}`)
  }
  if (selected.items.length || selected.notices.length) confirm = selected.batch
}
if (announced) lines.push(companyLine(state))
if (lines.length) {
  const written = await writeStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } }))
  if (written && confirm) await mcp.request({ op: 'confirm', batch: confirm }, 1000)
}
mcp?.close()
