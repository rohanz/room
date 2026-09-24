// End-to-end check that Room wakes a real Claude Code session (cross-session inbox socket or channel).
//
// Usage:  npx tsx scripts/wake-e2e.mts [a b c d e f a2 | peek]   (default: a-f; exit 0 when all pass)
//   e.g.  nice -n 15 npx tsx scripts/wake-e2e.mts
//         E2E_PLUGIN_DIR=/tmp/other-tree/plugins/room npx tsx scripts/wake-e2e.mts c d
//
// Prereqs: `claude` on PATH and logged in (checked with 2.1.281), tmux, git, network access to GitHub,
// `npm ci` in this repo and `npm run build:plugin` so plugins/room/server is the code under test.
// Cost/time: every case starts a fresh interactive Claude Code session on Haiku; 20-60 s per case,
// ~4 min for a-f, ~1 min more for a2; a few cents. The session also loads your other user plugins and hooks.
//
// Env:
//   E2E_PLUGIN_DIR  plugin under test (default: <this repo>/plugins/room), loaded with --plugin-dir.
//   E2E_MODEL       session model (default claude-haiku-4-5-20251001).
//   E2E_REPO        repo to clone (default https://github.com/rohanz/room-playground-2, branch E2E_BRANCH=shop).
//   E2E_KEEP=1      keep the scratch dir (/tmp/wake-e2e-<stamp>) and tmux sessions for inspection.
//
// Isolation: sessions start from `env -i` (no ROOM_SERVER/ROOM_TAG/ROOM_OWNER, so each is in a LOCAL room),
// on a private tmux server (-L wake-e2e-<stamp>), with a --settings file in the scratch dir that turns the
// installed room@room plugin off so only --plugin-dir's copy loads (the script checks the MCP server path),
// and allows the room tools and runs in dontAsk mode (anything else is denied) so no permission prompt blocks a turn. The script edits nothing under ~/.claude;
// Claude Code itself still writes transcripts there and records folder trust per scratch clone in ~/.claude.json.
// The folder-trust prompt (and the development-channels warning in case e) are answered; nothing else.
//
// Room traffic in a-f is posted by this driver as synthetic workers (done/question/note messages on the local
// relay's Yjs doc, shaped exactly like room_done / room_send posts, with worker presence so the session has
// company), not real `claude -p` workers, so each case is quick and deterministic. a2 is the real thing: the
// session calls room_spawn for a Haiku worker (which runs your installed room@room plugin) and goes idle.
// Evidence comes from the session transcript (~/.claude/projects/*/<id>.jsonl):
// a socket wake is a user entry with origin.kind "peer"; a channel wake is a user entry holding
// <channel source="plugin:room:room" ...>; every turn ends with a system turn_duration entry. Each session also
// writes --debug-file <scratch>/<case>/claude-debug.txt, whose [uds-messaging] and [cross-session-inbound]
// lines are Claude Code's own record of every post Room made to the inbox socket (and any refusal).
//
// Cases:
//   a  idle session, one worker done addressed to it          -> one wake within 30s (socket window is 5 s) and the
//      woken turn ends (within 120 s; it calls room tools). c and e wait for their woken turn the same way.
//   b  busy session (mid-turn, sleeping in Bash), worker question -> seen before the turn ends (hook inbox,
//      socket message absorbed mid-turn, or channel)
//   c  five worker dones within ~1s                             -> exactly one socket post and one wake
//   d  crossSessionInbound "refuse" via --settings              -> Room posts, host refuses, no wake, MCP server
//      alive, and the next human turn still sees the message
//   e  ROOM_WAKE=channels + --dangerously-load-development-channels plugin:room@inline (the --plugin-dir entry;
//      ROOM_CLAUDE_CHANNEL names it for the server) -> channel wake, no socket post
//   f  ROOM_WAKE=off                                            -> no socket post, no channel, no turn
//   a2 (opt-in) real worker: the session spawns one Haiku worker and goes idle -> woken when it finishes
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import { WebSocket } from 'ws'
import { WebsocketProvider } from 'y-websocket'
import { RoomDoc } from '@room/shared'
import type { Identity } from '@room/shared'

const here = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(process.env.E2E_PLUGIN_DIR ?? path.join(here, '..', 'plugins', 'room'))
const MODEL = process.env.E2E_MODEL ?? 'claude-haiku-4-5-20251001'
const REPO = process.env.E2E_REPO ?? 'https://github.com/rohanz/room-playground-2'
const BRANCH = process.env.E2E_BRANCH ?? 'shop'
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
const SCRATCH = `/tmp/wake-e2e-${STAMP}`
const TMUX = `wake-e2e-${STAMP}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const clock = (t = Date.now()) => new Date(t).toISOString().slice(11, 23)
const log = (s: string) => console.log(`${clock()} ${s}`)

const run = (cmd: string, args: string[], opts: { cwd?: string } = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
const tmux = (...args: string[]) => run('tmux', ['-L', TMUX, ...args])
const capture = (name: string) => { try { return tmux('capture-pane', '-p', '-J', '-S', '-3000', '-t', name) } catch { return '' } }

interface Session { name: string; dir: string; pid: number; mcpPid: number; sessionId: string; transcript: string; debug: string }

function waitFor<T>(what: string, ms: number, probe: () => T | undefined | false): Promise<T> {
  return (async () => {
    const end = Date.now() + ms
    for (;;) {
      const v = probe()
      if (v) return v
      if (Date.now() > end) throw new Error(`timed out after ${ms}ms waiting for ${what}`)
      await sleep(500)
    }
  })()
}

/** Move the ❯ cursor of a select dialog onto the option containing `label`, then confirm. */
async function choose(name: string, label: string): Promise<void> {
  const lines = capture(name).split('\n')
  const at = lines.findIndex(l => /^\s*❯\s/.test(l) && /\d\.|[A-Za-z]/.test(l))
  const target = lines.findIndex(l => l.includes(label))
  if (at < 0 || target < 0) throw new Error(`no dialog option "${label}" in ${name}`)
  for (let i = 0; i < Math.abs(target - at); i++) { tmux('send-keys', '-t', name, target > at ? 'Down' : 'Up'); await sleep(150) }
  tmux('send-keys', '-t', name, 'Enter')
  await sleep(800)
}

function prepareClone(name: string): string {
  const origin = path.join(SCRATCH, 'origin')
  if (!fs.existsSync(origin)) run('git', ['clone', '-q', '-b', BRANCH, REPO, origin])
  const dir = path.join(SCRATCH, name, 'shop')
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  run('git', ['clone', '-q', '-b', BRANCH, origin, dir])
  run('git', ['remote', 'set-url', 'origin', REPO], { cwd: dir })
  return dir
}

async function startSession(name: string, opts: { settings?: Record<string, unknown>; env?: Record<string, string>; channel?: string } = {}): Promise<Session> {
  const dir = prepareClone(name)
  const settingsFile = path.join(SCRATCH, name, 'settings.json')
  fs.writeFileSync(settingsFile, JSON.stringify({
    enabledPlugins: { 'room@room': false },
    // dontAsk denies anything else instead of prompting, so a woken turn cannot hang on a permission dialog.
    permissions: { allow: ['mcp__plugin_room_room__*', 'Read', 'Glob', 'Grep', 'Bash(sleep:*)'], defaultMode: 'dontAsk' },
    ...opts.settings,
  }, null, 2))
  const env = { HOME: os.homedir(), USER: os.userInfo().username, PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'en_US.UTF-8', SHELL: process.env.SHELL ?? '/bin/zsh', ...opts.env }
  const args = [...(opts.channel ? ['--dangerously-load-development-channels', opts.channel] : []), '--plugin-dir', PLUGIN_DIR, '--settings', settingsFile, '--model', MODEL, '--debug-file', path.join(SCRATCH, name, 'claude-debug.txt')]
  const script = path.join(SCRATCH, name, 'run-claude.sh')
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  fs.writeFileSync(script, `#!/bin/sh\ncd ${q(dir)}\nexec env -i ${Object.entries(env).map(([k, v]) => `${k}=${q(v)}`).join(' ')} claude ${args.map(q).join(' ')}\n`, { mode: 0o755 })
  tmux('new-session', '-d', '-s', name, '-x', '200', '-y', '50', script)
  const pid = Number(tmux('list-panes', '-t', name, '-F', '#{pane_pid}').trim())
  log(`${name}: started claude pid ${pid} (${args.join(' ')})${opts.env ? ` env ${JSON.stringify(opts.env)}` : ''}`)
  await waitFor(`${name} prompt`, 60_000, () => {
    const pane = capture(name)
    if (pane.includes('Yes, I trust this folder')) { void choose(name, 'Yes, I trust this folder'); return false }
    if (pane.includes('I am using this for local development')) { void choose(name, 'I am using this for local development'); return false }
    return /^❯\s*$/m.test(pane) && pane.includes('Claude Code v')
  })
  const mcpPid = await waitFor(`${name} room MCP server`, 30_000, () => {
    try { return Number(run('pgrep', ['-P', String(pid), '-f', 'room-mcp.mjs']).trim().split('\n')[0]) || false } catch { return false }
  })
  const mcpCmd = run('ps', ['-o', 'command=', '-p', String(mcpPid)]).trim()
  if (!mcpCmd.includes(PLUGIN_DIR)) throw new Error(`${name}: room MCP server is not the --plugin-dir copy: ${mcpCmd}`)
  const others = run('ps', ['-o', 'command=', '-g', String(pid)]).split('\n').filter(l => l.includes('room-mcp.mjs') && !l.includes(PLUGIN_DIR))
  if (others.length) throw new Error(`${name}: installed room plugin also loaded: ${others.join('; ')}`)
  const envLine = run('ps', ['eww', '-o', 'command=', '-p', String(mcpPid)])
  const sessionId = envLine.match(/CLAUDE_CODE_SESSION_ID=(\S+)/)?.[1]
  if (!sessionId) throw new Error(`${name}: no CLAUDE_CODE_SESSION_ID in the MCP server env`)
  log(`${name}: MCP server ${mcpPid} from --plugin-dir; messaging socket in its env: ${/CLAUDE_CODE_MESSAGING_SOCKET=\S+/.test(envLine) ? 'yes' : 'NO'}`)
  await waitFor(`${name} relay`, 30_000, () => fs.existsSync(path.join(dir, '.git', 'room-local.json')))
  return { name, dir, pid, mcpPid, sessionId, transcript: '', debug: path.join(SCRATCH, name, 'claude-debug.txt') }
}

/** Claude Code creates the transcript at the first turn; '' until then. */
function transcriptPath(sessionId: string): string {
  const root = path.join(os.homedir(), '.claude', 'projects')
  for (const d of fs.readdirSync(root)) {
    const f = path.join(root, d, `${sessionId}.jsonl`)
    if (d.includes('wake-e2e') && fs.existsSync(f)) return f
  }
  return ''
}

interface Entry { at: number; kind: 'socket-wake' | 'socket-absorbed' | 'channel-wake' | 'hook-context' | 'prompt' | 'tool-result' | 'turn-end' | 'enqueue' | 'other'; text: string }

function entries(s: Session): Entry[] {
  const file = s.transcript ||= transcriptPath(s.sessionId)
  const out: Entry[] = []
  if (!file) return out
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const d = JSON.parse(line)
    const at = Date.parse(d.timestamp ?? '') || 0
    const content = d.message?.content
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: any) => c.text ?? (typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? ''))).join('\n') : (d.content ?? '')
    if (d.type === 'queue-operation' && d.operation === 'enqueue') out.push({ at, kind: 'enqueue', text })
    else if (d.type === 'queue-operation' && d.reason === 'absorbed_mid_turn') out.push({ at, kind: 'socket-absorbed', text: `read mid-turn: ${d.content}` })
    else if (d.type === 'system' && d.subtype === 'turn_duration') out.push({ at, kind: 'turn-end', text: `${d.durationMs}ms` })
    else if (d.type === 'user' && d.origin?.kind === 'peer') out.push({ at, kind: 'socket-wake', text })
    else if (d.type === 'user' && /<channel source="[^"]*room/.test(text)) out.push({ at, kind: 'channel-wake', text })
    else if (d.type === 'user' && Array.isArray(content) && content.some((c: any) => c.type === 'tool_result')) out.push({ at, kind: 'tool-result', text })
    else if (d.type === 'user' && !d.isMeta) out.push({ at, kind: 'prompt', text })
    else if (d.type === 'attachment' && d.attachment?.type === 'hook_additional_context' && JSON.stringify(d.attachment.content).includes('[room')) out.push({ at, kind: 'hook-context', text: [].concat(d.attachment.content).join('\n') })
  }
  return out
}
/** What the model did after `t`: tool names it called (model behaviour, reported but not a pass criterion). */
function toolsCalled(s: Session, t: number): string {
  const file = s.transcript ||= transcriptPath(s.sessionId)
  if (!file) return 'none'
  const names: string[] = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const d = JSON.parse(line)
    if (d.type !== 'assistant' || (Date.parse(d.timestamp ?? '') || 0) < t) continue
    for (const c of d.message?.content ?? []) if (c.type === 'tool_use') names.push(c.name.replace(/^mcp__plugin_room_room__/, ''))
  }
  return names.join(', ') || 'none'
}
const since = (s: Session, t: number, kind?: Entry['kind']) => entries(s).filter(e => e.at >= t && (!kind || e.kind === kind))

/** Send a prompt as the human would, and wait for that turn to end. */
async function prompt(s: Session, text: string, waitEnd = true): Promise<number> {
  const t = Date.now()
  tmux('send-keys', '-t', s.name, '-l', text)
  await sleep(300)
  tmux('send-keys', '-t', s.name, 'Enter')
  if (waitEnd) await waitFor(`${s.name} turn end`, 120_000, () => since(s, t, 'turn-end').length > 0)
  return t
}

async function connect(s: Session): Promise<{ room: RoomDoc; lead: string; close: () => void }> {
  const info = JSON.parse(fs.readFileSync(path.join(s.dir, '.git', 'room-local.json'), 'utf8')) as { port: number; room: string; key: string }
  const doc = new Y.Doc()
  const p = new WebsocketProvider(`ws://127.0.0.1:${info.port}`, encodeURIComponent(info.room), doc, { WebSocketPolyfill: WebSocket as any, params: { key: info.key } })
  await waitFor('relay sync', 15_000, () => p.synced)
  const lead = await waitFor(`${s.name} identity in the room`, 15_000, () => {
    for (const [id, st] of p.awareness.getStates()) {
      const u = (st as any).user
      if (id !== p.awareness.clientID && u?.name && u.kind === 'agent') return String(u.name)
    }
    return false
  })
  // Present as a running worker: Room delivers inbox context only to a session with company.
  p.awareness.setLocalState({ user: { ...worker(lead, 0), color: '#888888' }, status: 'working', host: 'claude' })
  await sleep(1500)
  return { room: new RoomDoc(doc), lead, close: () => p.destroy() }
}

const worker = (lead: string, n: number): Identity => ({ name: `${lead}+w${n}`, kind: 'agent' } as Identity)
function postDone(r: RoomDoc, lead: string, n: number, summary = `wrote x${n}.txt`) {
  return r.post(worker(lead, n), { type: 'done', tag: `w${n}`, summary, changed: [`x${n}.txt`], to: lead, priority: 'notify' } as any)
}
function postQuestion(r: RoomDoc, lead: string, n: number, text: string) {
  return r.post(worker(lead, n), { type: 'question', text, to: lead } as any)
}

type Result = { pass: boolean; evidence: string[] }
/** Claude Code's own record of its inbox socket (--debug-file), after `t`: proof of what Room posted there. */
function uds(s: Session, t: number): string[] {
  let text = ''
  try { text = fs.readFileSync(s.debug, 'utf8') } catch { return [] }
  return text.split('\n').filter(l => /\[(uds-messaging|cross-session-inbound)\]/.test(l) && !/Listening|Inject messages|Connect when|Shutting down/.test(l) && Date.parse(l.slice(0, 24)) >= t)
    .map(l => `${l.slice(11, 23)} host: ${l.slice(25).replace(/\s+/g, ' ').slice(0, 200)}`)
}
const posts = (s: Session, t: number) => uds(s, t).filter(l => l.includes('Client connected')).length
const show = (e: Entry) => `${clock(e.at)} ${e.kind}: ${e.text.replace(/\s+/g, ' ').slice(0, 220)}`
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`

/**
 * Wait for the first wake of `kinds` after `t` (30 s: the 5 s socket coalescing window plus margin), then for the
 * woken turn to end (120 s: the woken session now does real work, ToolSearch, room_state, room_collect). Then keep
 * watching until at least `minWindow` after `t` and 6 s past the turn end, so a second wake would still be seen.
 * Returns undefined times when either wait times out; the caller's assertions then fail with the evidence.
 */
async function wokenTurn(s: Session, t: number, kinds: Entry['kind'][], minWindow: number): Promise<{ wakeAt?: number; endAt?: number; timing: string }> {
  const wake = await waitFor(`${s.name} wake`, 30_000, () => since(s, t).find(e => kinds.includes(e.kind))).catch(() => undefined)
  const end = wake && await waitFor(`${s.name} woken turn end`, 120_000, () => since(s, wake.at, 'turn-end')[0]).catch(() => undefined)
  await sleep(Math.max(t + minWindow - Date.now(), (end ? end.at + 6000 : 0) - Date.now(), 0))
  const stuck = wake && !end ? `; pane: ${capture(s.name).trim().split('\n').slice(-8).join(' | ').replace(/\s+/g, ' ')}` : ''
  const timing = !wake ? 'no wake within 30s of the post' : `post->wake ${secs(wake.at - t)}, wake->turn end ${end ? secs(end.at - wake.at) : `none within 120s${stuck}`}`
  log(`${s.name}: ${timing}`)
  return { wakeAt: wake?.at, endAt: end?.at, timing }
}

/** a: an idle session is woken by one worker done. */
async function caseA(env: Record<string, string> = {}): Promise<Result> {
  const s = await startSession('a', { env })
  const c = await connect(s)
  await sleep(3000)
  const t = Date.now(); const m = postDone(c.room, c.lead, 1)
  log(`a: posted done ${m.id} from ${m.from} to ${c.lead}`)
  const w = await wokenTurn(s, t, ['socket-wake', 'channel-wake'], 20_000)
  const wakes = since(s, t).filter(e => e.kind === 'socket-wake' || e.kind === 'channel-wake')
  c.close()
  return { pass: wakes.length === 1 && !!w.endAt, evidence: [`${clock(t)} done posted; ${w.timing}; wakes=${wakes.length}; woken turn called: ${toolsCalled(s, t)}`, ...uds(s, t), ...since(s, t).filter(e => e.kind !== 'tool-result').map(show)] }
}

/** a2 (opt-in): like a, with a real Haiku worker that the session starts itself through room_spawn. */
async function caseA2(): Promise<Result> {
  const s = await startSession('a2')
  const c = await connect(s)
  let doneAt = 0
  c.room.bus.observe(() => { if (!doneAt && c.room.messages().some(m => m.type === 'done' && m.to === c.lead)) doneAt = Date.now() })
  const t = await prompt(s, 'Use room_spawn to start exactly one worker with host "claude", model "claude-haiku-4-5-20251001", task "Create the file hello.txt containing the single line hi, then call room_done." Then end your turn right away: do not call room_wait and do not check on it.')
  const idleAt = since(s, t, 'turn-end')[0].at
  log(`a2: spawn turn ended ${clock(idleAt)}; waiting for the worker`)
  await waitFor('a2 worker done', 240_000, () => doneAt > 0)
  log(`a2: worker done on the bus ${clock(doneAt)}`)
  await sleep(20_000)
  const wakes = since(s, doneAt - 1000).filter(e => e.kind === 'socket-wake' || e.kind === 'channel-wake')
  c.close()
  return { pass: idleAt < doneAt && wakes.length === 1, evidence: [`${clock(idleAt)} session idle (spawn turn ended)`, `${clock(doneAt)} worker done on the bus; woken turn called: ${toolsCalled(s, doneAt)}`, ...since(s, idleAt + 1).filter(e => e.kind !== 'tool-result').map(show)] }
}

/** b: a busy session sees a worker question at its next step. */
async function caseB(): Promise<Result> {
  const s = await startSession('b')
  const c = await connect(s)
  const t0 = await prompt(s, 'Run the shell command `sleep 12` with Bash, then run `sleep 2`, then reply DONE. Do nothing else.', false)
  await waitFor('b busy in sleep', 60_000, () => /sleep 12/.test(capture('b')) && entries(s).some(e => e.at >= t0 && e.kind === 'prompt'))
  await sleep(3000)
  const t = Date.now(); const m = postQuestion(c.room, c.lead, 2, 'Should x2.txt say hi or hello?')
  log(`b: posted question ${m.id} while ${s.name} is mid-turn`)
  await waitFor('b turn end', 120_000, () => since(s, t, 'turn-end').length > 0)
  await sleep(8000)
  const after = since(s, t)
  const saw = after.find(e => ['socket-absorbed', 'socket-wake', 'channel-wake', 'hook-context'].includes(e.kind) && (e.text.includes('x2.txt') || e.text.includes('asked a question')))
  c.close()
  return { pass: !!saw && saw.at <= (since(s, t, 'turn-end')[0]?.at ?? Infinity), evidence: [`${clock(t)} question posted`, ...uds(s, t), ...after.map(show)] }
}

/** c: five dones close together produce one wake. */
async function caseC(): Promise<Result> {
  const s = await startSession('c')
  const c = await connect(s)
  await sleep(3000)
  const t = Date.now()
  for (let n = 1; n <= 5; n++) { postDone(c.room, c.lead, n); await sleep(200) }
  log('c: posted five dones over ~1s')
  const w = await wokenTurn(s, t, ['socket-wake', 'channel-wake'], 30_000)
  const wakes = since(s, t).filter(e => e.kind === 'socket-wake' || e.kind === 'channel-wake')
  c.close()
  return { pass: wakes.length === 1 && posts(s, t) <= 1, evidence: [`${clock(t)} five dones posted; ${w.timing}; socket posts=${posts(s, t)} wakes=${wakes.length} turns=${since(s, t, 'turn-end').length}; woken turn called: ${toolsCalled(s, t)}`, ...uds(s, t), ...since(s, t).filter(e => e.kind !== 'tool-result').map(show)] }
}

/** d: crossSessionInbound refuse — no wake, nothing breaks, message there on the next turn. */
async function caseD(): Promise<Result> {
  const s = await startSession('d', { settings: { crossSessionInbound: 'refuse' } })
  const c = await connect(s)
  await sleep(3000)
  const t = Date.now(); postDone(c.room, c.lead, 4, 'wrote x4.txt (refuse case)')
  await sleep(15_000)
  const wakes = since(s, t).filter(e => e.kind === 'socket-wake' || e.kind === 'channel-wake')
  const alive = (() => { try { process.kill(s.mcpPid, 0); return true } catch { return false } })()
  const t2 = await prompt(s, 'Check the room inbox with room_state and tell me in one line what finished.')
  await sleep(2000)
  const later = since(s, t2)
  const saw = later.some(e => e.text.includes('x4.txt'))
  c.close()
  return { pass: wakes.length === 0 && alive && saw && posts(s, t) >= 1, evidence: [`${clock(t)} done posted; socket posts=${posts(s, t)}; wakes in 15s=${wakes.length}; MCP server alive=${alive}`, ...uds(s, t), ...since(s, t).filter(e => e.kind !== 'tool-result' || e.text.includes('x4.txt')).map(show)] }
}

/** e: ROOM_WAKE=channels with the channel flag — channel wake only. */
async function caseE(): Promise<Result> {
  const channel = 'plugin:room@inline'
  const s = await startSession('e', { env: { ROOM_WAKE: 'channels', ROOM_CLAUDE_CHANNEL: channel }, channel })
  const c = await connect(s)
  await sleep(3000)
  const t = Date.now(); postDone(c.room, c.lead, 5)
  const w = await wokenTurn(s, t, ['channel-wake'], 20_000)
  const ch = since(s, t, 'channel-wake'), so = since(s, t, 'socket-wake')
  c.close()
  return { pass: ch.length >= 1 && so.length === 0 && posts(s, t) === 0, evidence: [`${clock(t)} done posted; ${w.timing}; channel wakes=${ch.length} socket posts=${posts(s, t)} socket wakes=${so.length}`, ...uds(s, t), ...since(s, t).filter(e => e.kind !== 'tool-result').map(show)] }
}

/** f: ROOM_WAKE=off — nothing wakes. */
async function caseF(): Promise<Result> {
  const s = await startSession('f', { env: { ROOM_WAKE: 'off' } })
  const c = await connect(s)
  await sleep(3000)
  const t = Date.now(); postDone(c.room, c.lead, 6); postQuestion(c.room, c.lead, 7, 'Question for an off session?')
  await sleep(20_000)
  const any = since(s, t).filter(e => e.kind !== 'enqueue')
  c.close()
  return { pass: any.length === 0 && posts(s, t) === 0, evidence: [`${clock(t)} done + question posted; socket posts=${posts(s, t)}; transcript entries after=${any.length}`, ...uds(s, t), ...any.map(show)] }
}

async function peek(): Promise<void> {
  const s = await startSession('peek')
  const c = await connect(s)
  log(`peek: lead identity ${c.lead}; session ${s.sessionId}`)
  c.close()
}

const CASES: Record<string, () => Promise<Result>> = { a: () => caseA(), b: caseB, c: caseC, d: caseD, e: caseE, f: caseF, a2: caseA2 }
const DEFAULT_CASES = ['a', 'b', 'c', 'd', 'e', 'f']
const want = process.argv.slice(2)
fs.mkdirSync(SCRATCH, { recursive: true })
log(`scratch ${SCRATCH}; tmux -L ${TMUX}; plugin ${PLUGIN_DIR}; ${run('claude', ['--version']).trim()}; model ${MODEL}`)
const cleanup = () => {
  if (process.env.E2E_KEEP === '1') { log(`kept: tmux -L ${TMUX} attach; ${SCRATCH}`); return }
  try { tmux('kill-server') } catch { /* already gone */ }
  // Sessions, their MCP servers, relays and any spawned worker all run from inside the scratch dir.
  try { run('pkill', ['-f', SCRATCH]) } catch { /* none left */ }
  for (let i = 0; i < 20; i++) {
    try { run('pgrep', ['-f', SCRATCH]) } catch { break }
    execFileSync('sleep', ['0.5'])
  }
  fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  fs.rmSync(path.join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid!()}`, TMUX), { force: true })
  log(`removed ${SCRATCH} and tmux server ${TMUX}`)
}
process.on('SIGINT', () => { cleanup(); process.exit(130) })
const results: Record<string, Result | { pass: false; evidence: string[] }> = {}
try {
  if (want[0] === 'peek') await peek()
  else for (const k of want.length ? want : DEFAULT_CASES) {
    log(`--- case ${k}`)
    try { results[k] = await CASES[k]() }
    catch (e) { results[k] = { pass: false, evidence: [`error: ${(e as Error).message}`] } }
    const r = results[k]
    fs.writeFileSync(path.join(SCRATCH, k, 'pane.txt'), capture(k))
    console.log(`${r.pass ? 'PASS' : 'FAIL'} ${k}\n  ${r.evidence.join('\n  ')}`)
    try { tmux('kill-session', '-t', k) } catch { /* gone */ }
  }
} finally {
  console.log('\nSUMMARY ' + Object.entries(results).map(([k, r]) => `${k}=${r.pass ? 'PASS' : 'FAIL'}`).join(' '))
  cleanup()
}
process.exit(Object.values(results).every(r => r.pass) ? 0 : 1)
