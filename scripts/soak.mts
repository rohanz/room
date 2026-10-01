// Soak test of a Room server: simulated participants in two synthetic repos against one server for hours.
//
// Usage (from the repo root):
//   npx tsx scripts/soak.mts run [--minutes 180] [--restart-at 90] [--participants 8]   # the soak (orchestrator)
//   npx tsx scripts/soak.mts report                                                   # re-analyse a finished run
//   npx tsx scripts/soak.mts cleanup                                                  # delete credentials
//
// Env: SOAK_SERVER (default https://room-rohanz-staging.fly.dev), SOAK_DIR (default /tmp/room-soak),
//      SOAK_FLY_APP / SOAK_FLY_MACHINE (metrics over `flyctl ssh console`, read-only; the single restart at
//      --restart-at uses `flyctl machine restart`). --restart-at 0 skips the restart; SOAK_FLY_APP= skips Fly.
//
// The server must run the fake GitHub issuer (GITHUB_CLIENT_ID=fake): each participant logs in as soak-<x>
// through POST /auth/device + /auth/poll {fakeLogin}. Only synthetic repos (github.com/soak/alpha, beta) are
// opened; their clones live under SOAK_DIR with origin URLs set to those names and never fetch.
//
// Each participant is its own process (`participant` mode) running joinSession + createTools from source, and
// loops with jitter: scope once, claims on line ranges then releases, addressed questions/answers and notes
// (one message every 30-90 s), edits that publish overlays (a 100-500 KB file now and then), a disconnect every
// 10-20 min, and one leave-and-rejoin under the same name. Posts use deterministic ids and retry the same id,
// so the hub's dedupe is exercised. Deliveries are what the session's ledger commits (reply batches), so a
// duplicate is a second commit of one id. Events go to SOAK_DIR/events/*.jsonl; `report` writes report.md.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const run = promisify(execFile)
const HTTP = (process.env.SOAK_SERVER ?? 'https://room-rohanz-staging.fly.dev').replace(/\/+$/, '')
const WS = HTTP.replace(/^http/, 'ws')
const DIR = process.env.SOAK_DIR ?? '/tmp/room-soak'
const APP = process.env.SOAK_FLY_APP ?? 'room-rohanz-staging'
const MACHINE = process.env.SOAK_FLY_MACHINE ?? '82de15a703de48'
if (APP === 'room-rohanz') throw new Error('refusing to run against the production app room-rohanz')
if (!/^\/tmp\/|room-soak/.test(DIR)) throw new Error(`refusing SOAK_DIR ${DIR}: must be under /tmp or contain room-soak`)
const EVENTS = path.join(DIR, 'events'), CREDS = path.join(DIR, 'creds'), WORK = path.join(DIR, 'work'), LOGS = path.join(DIR, 'logs')

const REPOS = { alpha: 'github.com/soak/alpha', beta: 'github.com/soak/beta' } as const
type RepoKey = keyof typeof REPOS
const ROSTER: { name: string; repo: RepoKey; branch: string }[] = [
  { name: 'soak-a', repo: 'alpha', branch: 'main' }, { name: 'soak-b', repo: 'alpha', branch: 'main' },
  { name: 'soak-c', repo: 'alpha', branch: 'main' }, { name: 'soak-d', repo: 'alpha', branch: 'feature-x' },
  { name: 'soak-e', repo: 'alpha', branch: 'feature-x' }, { name: 'soak-f', repo: 'beta', branch: 'main' },
  { name: 'soak-g', repo: 'beta', branch: 'main' }, { name: 'soak-h', repo: 'beta', branch: 'main' },
]

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const jitter = (lo: number, hi: number) => lo + Math.random() * (hi - lo)
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]
function emitter(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  return (e: Record<string, unknown>) => fs.appendFileSync(file, JSON.stringify({ t: Date.now(), ...e }) + '\n')
}
function readEvents(file: string): any[] {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] }
}
async function git(cwd: string, ...args: string[]) { return (await run('git', args, { cwd })).stdout.trim() }

// ---------------------------------------------------------------- setup (orchestrator)

async function fakeLogin(login: string): Promise<string> {
  const file = path.join(CREDS, `${login}.json`)
  try {
    const { session } = JSON.parse(fs.readFileSync(file, 'utf8'))
    const me = await fetch(`${HTTP}/auth/me`, { headers: { authorization: `Bearer ${session}` } })
    if (me.ok) return session
  } catch { /* log in again */ }
  const device = (await (await fetch(`${HTTP}/auth/device`, { method: 'POST' })).json() as { device: string }).device
  const poll = await fetch(`${HTTP}/auth/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device, fakeLogin: login }) })
  const { session } = await poll.json() as { session?: string }
  if (!session) throw new Error(`fake login ${login} failed (${poll.status}); does the server run GITHUB_CLIENT_ID=fake?`)
  fs.mkdirSync(CREDS, { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify({ login, session }), { mode: 0o600 })
  return session
}

function pyModule(i: number, lines: number): string {
  const out = [`"""Synthetic module ${i} for the Room soak."""`, '']
  for (let f = 0; out.length < lines; f++) {
    out.push(`def handler_${i}_${f}(value):`, `    total = value * ${f + 1}`, `    if total > ${100 * (f + 1)}:`, `        return total - ${f}`, `    return total`, '')
  }
  return out.join('\n') + '\n'
}

async function setupRepos(): Promise<void> {
  for (const repo of Object.keys(REPOS) as RepoKey[]) {
    const src = path.join(WORK, `${repo}-src`), bare = path.join(WORK, `${repo}.git`)
    if (!fs.existsSync(bare)) {
      fs.rmSync(src, { recursive: true, force: true }); fs.mkdirSync(path.join(src, 'app'), { recursive: true })
      for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(src, 'app', `mod_${i}.py`), pyModule(i, 180))
      fs.writeFileSync(path.join(src, 'README.md'), `# soak ${repo}\n`)
      await git(src, 'init', '-q', '-b', 'main'); await git(src, 'add', '-A')
      await git(src, '-c', 'user.email=soak@room', '-c', 'user.name=soak', 'commit', '-qm', `soak ${repo} initial`)
      await git(src, 'branch', 'feature-x')
      await run('git', ['clone', '-q', '--bare', src, bare])
    }
  }
  for (const p of ROSTER) {
    const dir = path.join(WORK, p.name)
    if (fs.existsSync(dir)) continue
    await run('git', ['clone', '-q', '-b', p.branch, path.join(WORK, `${p.repo}.git`), dir])
    await git(dir, 'config', 'user.name', p.name); await git(dir, 'config', 'user.email', `${p.name}@soak.invalid`)
    // The room name comes from the origin URL; nothing ever fetches from it.
    await git(dir, 'remote', 'set-url', 'origin', `https://${REPOS[p.repo]}.git`)
  }
}

async function openRoom(room: string, session: string): Promise<void> {
  const res = await fetch(`${HTTP}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room, schema: 2, session }) })
  if (!res.ok) throw new Error(`could not open ${room}: ${res.status} ${await res.text()}`)
}

// ---------------------------------------------------------------- participant (child process)

async function participant(name: string, repo: RepoKey, restartAt: number, count: number): Promise<void> {
  const { joinSession, leaveSession } = await import('../packages/room-mcp/src/session.js')
  const { createTools } = await import('../packages/room-mcp/src/tools.js')
  const { configureCredentials, setCredential } = await import('../packages/room-mcp/src/credentials.js')
  const emit = emitter(path.join(EVENTS, `${name}.jsonl`))
  const dir = path.join(WORK, name)
  const { session: cred } = JSON.parse(fs.readFileSync(path.join(CREDS, `${name}.json`), 'utf8'))
  // Always an explicit file under SOAK_DIR: joinSession re-configures credentials from its options.
  const credentialsPath = path.join(CREDS, `${name}.credentials.json`)
  configureCredentials(credentialsPath)
  setCredential(WS, { session: cred, login: name, at: Date.now() })
  const peers = ROSTER.slice(0, count).filter(p => p.repo === repo && p.name !== name).map(p => p.name)
  const log = (line: string) => { if (/error|fail|refus|lost|stale|paused|warn/i.test(line)) emit({ ev: 'log', line: line.slice(0, 300) }) }
  let s: any, tools: any, stopping = false, leaving = false
  // Neighbours in a room share a file, so claims overlap someone's scope and are really taken.
  const idx = ROSTER.filter(p => p.repo === repo).findIndex(p => p.name === name)
  const myFiles = () => [`app/mod_${idx % 4}.py`, `app/mod_${(idx + 1) % 4}.py`]

  const join = async (why: string) => {
    const t0 = Date.now()
    for (let attempt = 1; ; attempt++) {
      try { s = await joinSession({ dir, server: WS, credentialsPath, connectTimeoutMs: 30_000, log }); break }
      catch (e) { emit({ ev: 'join-failed', why, attempt, error: String(e).slice(0, 300) }); if (stopping) return; await sleep(10_000) }
    }
    tools = createTools({ getSession: () => s, setSession: x => { s = x }, cwd: dir, log })
    // Every committed reply batch is a handoff to the host: record each id it carried (the delivery log).
    const commit = tools.ledger.commit.bind(tools.ledger)
    tools.ledger.commit = (batch: any) => {
      if (!batch.committed) for (const { m, via } of batch.items) {
        emit({ ev: 'delivered', id: m.id, from: m.from, to: m.to, type: m.type, seq: m.seq, via })
        if (m.type === 'question' && m.to === s.me.name) setTimeout(() => void answer(m), jitter(3_000, 30_000))
      }
      return commit(batch)
    }
    emit({ ev: 'joined', why, name: s.me.name, ms: Date.now() - t0, epoch: s.lease?.epoch, room: s.roomName })
    const area = `area-${name.slice(-1)}`
    const paths = [...myFiles(), `data/${name}/`]
    emit({ ev: 'tool', tool: 'room_scope', out: (await tools.call('room_scope', { area, summary: `soak work for ${name}`, paths })).slice(0, 160) })
  }

  // --- messages: deterministic ids; a failed post retries the same id until accepted (or 5 min).
  let n = 0
  const post = async (body: any, id: string) => {
    const t0 = Date.now()
    for (let attempt = 1; ; attempt++) {
      if (!s || leaving) { await sleep(2_000); continue }
      const r = await s.post(s.me, body, { id })
      if (r.ok) { emit({ ev: 'sent', id, to: body.to, type: body.type, seq: r.seq, duplicate: !!r.duplicate, attempts: attempt, ms: Date.now() - t0 }); return }
      if (Date.now() - t0 > 300_000 || stopping) { emit({ ev: 'unsent', id, to: body.to, type: body.type, reason: r.reason, text: r.text, attempts: attempt }); return }
      if (attempt === 1) emit({ ev: 'post-refused', id, reason: r.reason, text: String(r.text).slice(0, 200) })
      await sleep(5_000)
    }
  }
  const answered = new Set<string>()
  const answer = async (q: any) => {
    if (answered.has(q.id) || stopping) return
    answered.add(q.id)
    await post({ type: 'answer', to: q.from, inReplyTo: q.id, text: `re ${q.id}: looks fine from ${name}` }, `ans-${q.id}`)
  }
  const talk = async () => {
    const id = `soak-${name}-${Date.now().toString(36)}-${++n}`, to = pick(peers), roll = Math.random()
    if (roll < 0.5) await post({ type: 'question', to, text: `${name} asks ${to}: is handler ${n} safe to change?` }, id)
    else if (roll < 0.8) await post({ type: 'note', to, text: `${name} to ${to}: note ${n}` }, id)
    else await post({ type: 'note', text: `${name} broadcast note ${n}` }, id)
    // One post in ten is sent twice under its id: the hub must return the original seq, append nothing.
    if (Math.random() < 0.1) {
      const r = await s?.post(s.me, { type: 'note', text: 'retry probe' }, { id })
      if (r?.ok) emit({ ev: 'resent', id, seq: r.seq, duplicate: !!r.duplicate })
    }
  }
  const drain = () => {
    if (!s || !tools || leaving) return
    const batch = tools.ledger.open('reply')
    const chosen = tools.ledger.select(s, batch)
    if (chosen.length) tools.ledger.commit(batch); else tools.ledger.release(batch)
  }

  // --- claims and edits
  const claimCycle = async () => {
    if (!s || leaving) return
    const file = pick(myFiles()), from = 1 + Math.floor(Math.random() * 150), to = from + 5 + Math.floor(Math.random() * 20)
    const out: string = await tools.call('room_claim', { path: file, from, to, intent: `soak edit ${from}-${to}` })
    // The id comes from this call's own reply ("claimed c_…"); an older open claim on the file is not this one.
    const claimed = /claimed (c_[A-Za-z0-9]+)/.exec(out)?.[1]
    const claim = claimed ? s.room.claims.get(claimed) : undefined
    emit({ ev: 'claim', path: file, from, to, id: claimed, ok: !!claimed, out: claimed ? undefined : out.slice(0, 200) })
    const p = path.join(dir, file), lines = fs.readFileSync(p, 'utf8').split('\n')
    for (let i = from; i < Math.min(to, lines.length); i += 3) lines[i] = `${lines[i]}  # ${name} ${Date.now() % 100000}`.slice(0, 200)
    fs.writeFileSync(p, lines.join('\n'))
    await sleep(jitter(30_000, 120_000))
    for (let attempt = 0; claim && s && !leaving && !stopping && s.room.claims.has(claim.id) && attempt < 10; attempt++) {
      const rel: string = await tools.call('room_release', { claimId: claim.id, summary: `edited ${file}` })
      emit({ ev: 'release', id: claim.id, ok: rel.startsWith('released'), out: rel.slice(0, 120) })
      if (rel.startsWith('released')) break
      await sleep(10_000)
    }
  }
  let bigCount = 0
  const edit = () => {
    const d = path.join(dir, 'data', name); fs.mkdirSync(d, { recursive: true })
    if (Math.random() < 0.08) {
      const kb = Math.round(jitter(100, 500)), file = path.join(d, `big-${++bigCount % 3}.txt`)
      const line = `${name} large payload line `.padEnd(79, '.') + '\n'
      fs.writeFileSync(file, line.repeat(Math.ceil(kb * 1024 / 80)))
      emit({ ev: 'big-edit', file: path.relative(dir, file), kb })
    } else fs.writeFileSync(path.join(d, `notes-${Math.floor(Math.random() * 4)}.md`), `# ${name}\n\n${new Date().toISOString()} ${Math.random()}\n`)
  }

  // --- status: connection, hub, lease, epoch transitions (every 1 s, logged on change)
  let last = ''
  const status = () => {
    if (!s) return
    const p = s.provider as any, hub = s.hub as any
    const st = { conn: !!p.wsconnected, synced: !!p.synced, hub: hub.reachable?.() ?? false, inc: hub.incarnation, epoch: s.lease?.epoch, name: s.me.name, paused: s.lease?.paused?.() ? 1 : 0 }
    const key = JSON.stringify(st)
    if (key !== last) { last = key; emit({ ev: 'status', ...st }) }
  }

  const loops: ReturnType<typeof setInterval>[] = []
  const every = (lo: number, hi: number, fn: () => unknown) => {
    const tick = async () => { if (stopping) return; try { await fn() } catch (e) { emit({ ev: 'loop-error', error: String(e).slice(0, 300) }) } if (!stopping) loops.push(setTimeout(tick, jitter(lo, hi))) }
    loops.push(setTimeout(tick, jitter(lo, hi)))
  }
  const shutdown = async (why: string) => {
    if (stopping) return
    stopping = true
    for (const l of loops) clearTimeout(l)
    emit({ ev: 'stopping', why })
    try { await Promise.race([tools?.shutdown(), sleep(15_000)]) } catch (e) { emit({ ev: 'loop-error', error: String(e) }) }
    emit({ ev: 'stopped' })
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('unhandledRejection', e => emit({ ev: 'unhandled', error: String(e).slice(0, 300) }))

  await join('start')
  const started = Date.now(), min = 60_000
  loops.push(setInterval(status, 1_000))
  every(5_000, 15_000, drain)
  every(30_000, 90_000, talk)
  every(60_000, 180_000, claimCycle)
  every(20_000, 60_000, edit)
  // A disconnect every 10-20 min for 5-75 s: some stay inside the 45 s TTL, some outlive it.
  every(10 * min, 20 * min, async () => {
    if (!s || leaving) return
    const ms = Math.round(jitter(5_000, 75_000))
    emit({ ev: 'disconnect', ms, epoch: s.lease?.epoch })
    s.provider.disconnect(); await sleep(ms); s.provider.connect()
    emit({ ev: 'reconnect-requested' })
  })
  // One leave-and-rejoin under the same name, away from the hub restart.
  let leaveAt = jitter(25, 150) * min
  if (restartAt && Math.abs(leaveAt - restartAt * min) < 8 * min) leaveAt += 16 * min
  setTimeout(async () => {
    if (stopping) return
    leaving = true
    const before = { name: s.me.name, epoch: s.lease?.epoch }
    emit({ ev: 'leave', ...before })
    try { await tools.shutdown(); await leaveSession(s).catch(() => {}) } catch (e) { emit({ ev: 'loop-error', error: String(e) }) }
    s = undefined
    await sleep(jitter(20_000, 60_000))
    leaving = false
    await join('rejoin')
    emit({ ev: 'rejoined', sameName: s?.me.name === before.name, name: s?.me.name, epoch: s?.lease?.epoch, prevEpoch: before.epoch })
  }, leaveAt).unref()
  emit({ ev: 'plan', leaveAtMin: Math.round(leaveAt / min), started })
}

// ---------------------------------------------------------------- orchestrator: observer, health, Fly metrics

const REMOTE = 'for p in /proc/[0-9]*; do c=$(tr "\\0" " " < $p/cmdline 2>/dev/null); case "$c" in sh\\ *) ;; *loader.mjs*packages/server*) echo SRV ${p#/proc/} $(grep VmRSS $p/status | tr -s " " | cut -d" " -f2) $(grep VmHWM $p/status | tr -s " " | cut -d" " -f2) $(cut -d" " -f14,15 $p/stat);; *tsx\\ packages/server*) echo WRAP ${p#/proc/} $(grep VmRSS $p/status | tr -s " " | cut -d" " -f2);; esac; done; echo DATA $(du -sk /data | cut -f1); echo MEMAVAIL $(grep MemAvailable /proc/meminfo | tr -s " " | cut -d" " -f2); echo UPTIME $(cut -d" " -f1 /proc/uptime)'
async function flyMetrics(): Promise<Record<string, number> | { error: string }> {
  if (!APP) return { error: 'fly disabled' }
  try {
    const { stdout } = await run('flyctl', ['ssh', 'console', '-a', APP, '--machine', MACHINE, '-C', `sh -c '${REMOTE}'`], { timeout: 90_000 })
    const out: Record<string, number> = {}
    for (const line of stdout.split('\n')) {
      const f = line.trim().split(/\s+/)
      if (f[0] === 'SRV') Object.assign(out, { pid: +f[1], rssKb: +f[2], hwmKb: +f[3], cpuTicks: +f[4] + +f[5] })
      if (f[0] === 'WRAP') out.wrapRssKb = +f[2]
      if (f[0] === 'DATA') out.dataKb = +f[1]
      if (f[0] === 'MEMAVAIL') out.memAvailKb = +f[1]
      if (f[0] === 'UPTIME') out.uptimeS = +f[1]
    }
    return out
  } catch (e) { return { error: String(e).slice(0, 300) } }
}
const seenLog = new Set<string>()
/** New Fly log lines since `since` (ANSI stripped; older buffered lines from earlier machines are skipped). */
async function flyLogs(file: string, since: number): Promise<{ lines: number; errors: string[] }> {
  if (!APP) return { lines: 0, errors: [] }
  try {
    const { stdout } = await run('flyctl', ['logs', '-a', APP, '--no-tail'], { timeout: 90_000, maxBuffer: 64 * 1024 * 1024 })
    const fresh = stdout.replace(/\x1b\[[0-9;]*m/g, '').split('\n')
      .filter(l => l.trim() && !seenLog.has(l) && !(Date.parse(l.split(' ')[0]) < since))
    for (const l of fresh) seenLog.add(l)
    fs.appendFileSync(file, fresh.join('\n') + (fresh.length ? '\n' : ''))
    return { lines: fresh.length, errors: fresh.filter(l => /\b(error|exception|uncaught|fatal|out of memory|oom|killed|refused|failed|warn(ing)?)\b/i.test(l)) }
  } catch (e) { return { lines: 0, errors: [`flyctl logs failed: ${String(e).slice(0, 200)}`] } }
}

async function observer(room: string, session: string, emit: (e: Record<string, unknown>) => void) {
  const { authorizedWebSocket } = await import('../packages/roomd/src/ws-auth.js')
  const { RoomDoc, participantRecord } = await import('@room/shared')
  const doc = new Y.Doc(), rd = new RoomDoc(doc)
  const provider = new WebsocketProvider(WS, encodeURIComponent(room), doc, { WebSocketPolyfill: authorizedWebSocket({ session }) as any, params: { schema: '2' } })
  provider.awareness.setLocalState(null)
  // Every (id, seq) the hub appends, as it syncs in: a seq must never name two ids.
  const seen = new Map<string, number>()
  const onBus = () => { for (const m of rd.messages()) if (typeof m.seq === 'number' && seen.get(m.id) !== m.seq) { seen.set(m.id, m.seq); emit({ ev: 'bus', room, id: m.id, seq: m.seq, from: m.from, type: m.type }) } }
  rd.bus.observe(onBus)
  const sample = () => {
    const names = new Set<string>()
    for (const k of rd.participants.keys()) names.add(String(k).split('\u0000')[0])
    const holders = [...names].map(n => ({ n, h: participantRecord(rd, n)?.holder as any })).filter(x => x.h)
      .map(({ n, h }) => ({ name: n, epoch: h.epoch, ended: h.ended ?? null, at: h.at }))
    const present = [...provider.awareness.getStates().values()].map((st: any) => st?.user?.name).filter(Boolean)
    const meta = doc.getMap('meta')
    emit({ ev: 'room', room, connected: provider.wsconnected, synced: provider.synced, holders, present,
      live: holders.filter(h => !h.ended).length, bus: rd.bus.length, mail: rd.mail.size, docBytes: Y.encodeStateAsUpdate(doc).length,
      hubSeq: meta.get('hubSeq'), hubEpoch: meta.get('hubEpoch'), hubIncarnation: meta.get('hubIncarnation') })
  }
  return { sample, stop: () => { provider.destroy(); doc.destroy() } }
}

async function orchestrate(minutes: number, restartAt: number, count: number, postIdle: number): Promise<void> {
  fs.mkdirSync(EVENTS, { recursive: true }); fs.mkdirSync(LOGS, { recursive: true })
  const emit = emitter(path.join(EVENTS, 'orchestrator.jsonl'))
  const health = await fetch(`${HTTP}/health`).then(r => r.json()) as { hub?: number }
  const cfg = await fetch(`${HTTP}/auth/config`).then(r => r.json()) as { fake?: boolean }
  if (health.hub !== 1 || !cfg.fake) throw new Error(`${HTTP} must run a 0.17 hub with the fake issuer (health ${JSON.stringify(health)})`)
  await setupRepos()
  const roster = ROSTER.slice(0, count)
  const sessions: Record<string, string> = {}
  for (const p of [...roster.map(p => p.name), 'soak-observer']) sessions[p] = await fakeLogin(p)
  for (const room of Object.values(REPOS)) await openRoom(room, sessions['soak-observer'])
  // The inventory needs ROOM_ADMINS; record whether this server lets the observer read it.
  const inv = await fetch(`${HTTP}/admin/inventory`, { headers: { authorization: `Bearer ${sessions['soak-observer']}` } })
  emit({ ev: 'inventory-probe', status: inv.status, body: (await inv.text()).slice(0, 200) })
  const idle = await flyMetrics()
  emit({ ev: 'metrics', phase: 'pre-soak idle', ...idle })

  const t0 = Date.now()
  emit({ ev: 'start', minutes, restartAt, participants: roster.map(p => p.name), server: HTTP })
  const children = new Map<string, ChildProcess>()
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ROOM_|CLAUDE_|CODEX_)/.test(k)))
  for (const p of roster) {
    const out = fs.openSync(path.join(LOGS, `${p.name}.log`), 'a')
    const child = spawn(process.execPath, [...process.execArgv, new URL(import.meta.url).pathname, 'participant', p.name, p.repo, String(restartAt), String(count)],
      { env: { ...env, GIT_TERMINAL_PROMPT: '0', SOAK_DIR: DIR, SOAK_SERVER: HTTP }, stdio: ['ignore', out, out] })
    child.on('exit', (code, signal) => emit({ ev: 'child-exit', name: p.name, code, signal }))
    children.set(p.name, child)
    await sleep(jitter(1_000, 4_000))
  }
  const observers = await Promise.all(Object.values(REPOS).map(room => observer(room, sessions['soak-observer'], emitter(path.join(EVENTS, 'observer.jsonl')))))
  const obsTimer = setInterval(() => observers.forEach(o => o.sample()), 30_000)
  const healthTimer = setInterval(async () => {
    const t = Date.now()
    try { const r = await fetch(`${HTTP}/health`, { signal: AbortSignal.timeout(8_000) }); emit({ ev: 'health', status: r.status, ms: Date.now() - t }) }
    catch (e) { emit({ ev: 'health', status: 0, ms: Date.now() - t, error: String(e).slice(0, 120) }) }
  }, 10_000)
  const logFile = path.join(DIR, 'fly-logs.txt')
  // One `flyctl logs --no-tail` returns only the last ~100 lines, so poll every minute and report per sample.
  let pending = { lines: 0, errors: [] as string[] }
  const pollLogs = async () => { const l = await flyLogs(logFile, t0); pending = { lines: pending.lines + l.lines, errors: [...pending.errors, ...l.errors] } }
  const logTimer = setInterval(() => void pollLogs(), 60_000)
  let restarted = !restartAt || !APP
  for (let tick = 1; Date.now() - t0 < minutes * 60_000; tick++) {
    const next = t0 + tick * 10 * 60_000, restartTime = t0 + restartAt * 60_000
    while (Date.now() < Math.min(next, t0 + minutes * 60_000)) {
      if (!restarted && Date.now() >= restartTime) {
        restarted = true
        emit({ ev: 'metrics', phase: 'before restart', ...await flyMetrics() })
        const r0 = Date.now()
        emit({ ev: 'restart-begin' })
        try { await run('flyctl', ['machine', 'restart', MACHINE, '-a', APP], { timeout: 300_000 }); emit({ ev: 'restart-command-done', ms: Date.now() - r0 }) }
        catch (e) { emit({ ev: 'restart-command-failed', error: String(e).slice(0, 300) }) }
        while (Date.now() - r0 < 300_000) {
          try { if ((await fetch(`${HTTP}/health`, { signal: AbortSignal.timeout(3_000) })).ok) break } catch { /* down */ }
          await sleep(500)
        }
        emit({ ev: 'restart-healthy', ms: Date.now() - r0 })
        emit({ ev: 'metrics', phase: 'after restart', ...await flyMetrics() })
      }
      await sleep(5_000)
    }
    observers.forEach(o => o.sample())
    const m = await flyMetrics()
    await pollLogs()
    const logs = pending; pending = { lines: 0, errors: [] }
    emit({ ev: 'metrics', phase: 'soak', minute: Math.round((Date.now() - t0) / 60_000), ...m, logLines: logs.lines, errors: logs.errors })
  }
  emit({ ev: 'stopping-children' })
  for (const c of children.values()) c.kill('SIGTERM')
  await Promise.race([Promise.all([...children.values()].map(c => new Promise(r => c.exitCode !== null ? r(null) : c.once('exit', r)))), sleep(60_000)])
  for (const c of children.values()) if (c.exitCode === null) c.kill('SIGKILL')
  await sleep(60_000) // leases released or expired
  observers.forEach(o => o.sample())
  clearInterval(obsTimer); clearInterval(healthTimer); clearInterval(logTimer)
  // Idle after the soak: does the server's RSS come back down with the participants gone?
  for (let i = 0; i < postIdle; i++) { emit({ ev: 'metrics', phase: 'post-soak idle', ...await flyMetrics() }); await sleep(120_000) }
  const logs = await flyLogs(logFile, t0)
  emit({ ev: 'metrics', phase: 'final', logLines: logs.lines, errors: logs.errors })
  observers.forEach(o => o.stop())
  emit({ ev: 'end' })
  report()
  process.exit(0)
}

// ---------------------------------------------------------------- report

function report(): void {
  const orch = readEvents(path.join(EVENTS, 'orchestrator.jsonl')), obs = readEvents(path.join(EVENTS, 'observer.jsonl'))
  const people = Object.fromEntries(ROSTER.map(p => [p.name, readEvents(path.join(EVENTS, `${p.name}.jsonl`))]))
  const start = orch.find(e => e.ev === 'start'), t0 = start?.t ?? 0
  const min = (t: number) => Math.round((t - t0) / 60_000)
  const restartBegin = orch.find(e => e.ev === 'restart-begin'), restartHealthy = orch.find(e => e.ev === 'restart-healthy')
  const out: string[] = []

  // Metrics table, every 10 minutes.
  const metrics = orch.filter(e => e.ev === 'metrics' && e.rssKb)
  const rooms = obs.filter(e => e.ev === 'room')
  const errorsAll: string[] = []
  out.push('| min | phase | server RSS MB | HWM MB | CPU % | /data KB | alpha doc KB | beta doc KB | live leases | present | bus | mail | Fly log lines | error lines |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  let prev: any
  for (const m of metrics) {
    const cpu = prev && prev.pid === m.pid && prev.cpuTicks !== undefined ? (100 * (m.cpuTicks - prev.cpuTicks) / 100 / ((m.t - prev.t) / 1000)).toFixed(1) : '-'
    const near = (room: string) => rooms.filter(r => r.room === room && Math.abs(r.t - m.t) < 120_000).at(-1)
    const a = near(REPOS.alpha), b = near(REPOS.beta)
    const errs = (m.errors ?? []) as string[]
    errorsAll.push(...errs)
    out.push(`| ${m.t >= t0 ? min(m.t) : 'pre'} | ${m.phase} | ${(m.rssKb / 1024).toFixed(1)} | ${(m.hwmKb / 1024).toFixed(1)} | ${cpu} | ${m.dataKb ?? '-'} | ${a ? (a.docBytes / 1024).toFixed(0) : '-'} | ${b ? (b.docBytes / 1024).toFixed(0) : '-'} | ${a && b ? a.live + b.live : '-'} | ${a && b ? a.present.length + b.present.length : '-'} | ${a && b ? a.bus + b.bus : '-'} | ${a && b ? a.mail + b.mail : '-'} | ${m.logLines ?? '-'} | ${errs.length} |`)
    prev = m
  }
  const final = orch.filter(e => e.ev === 'metrics' && e.phase === 'final').at(-1)
  errorsAll.push(...(final?.errors ?? []))
  // Every Fly log line seen (fly-logs.txt; fly-logs-poll.raw is read too, from runs that polled beside the script),
  // deduplicated, from the soak start on; classified into known info lines and everything else.
  const flyLines = [...new Set(['fly-logs.txt', 'fly-logs-poll.raw'].flatMap(f => { try { return fs.readFileSync(path.join(DIR, f), 'utf8').split('\n') } catch { return [] } }))]
    .filter(l => l.trim() && Date.parse(l.split(' ')[0]) >= t0).sort()
  const EXPECTED: [RegExp, string][] = [
    [/dropped presence under/, 'awareness for another client id (y-websocket re-broadcasts timed-out peers) dropped by the filter'],
    [/observed identity-bearing update/, 'observe-only identity guard noting a member write'],
    [/hub: (granted|lease \d+ on \S+ (expired|released)|reserved)/, 'hub lease grants, releases and TTL expiries'],
    [/hub: incarnation \d+/, 'hub incarnations taken when a room loads'],
    [/ INFO |Firecracker|reboot: |Machine started|Health check|\/dev\/vdc|room server listening|Persisting documents|fc\.sock/, 'machine restart lifecycle (the planned restart), including Fly\'s failed health check while the server was down'],
    [/New SSH session|SSH/, 'the metrics sampler (flyctl ssh console)'],
  ]
  const kinds = new Map<string, number>(), other: string[] = []
  for (const l of flyLines) {
    const k = EXPECTED.find(([re]) => re.test(l))
    if (k) kinds.set(k[1], (kinds.get(k[1]) ?? 0) + 1); else other.push(l)
  }
  const flyErrors = flyLines.filter(l => /\b(error|exception|uncaught|fatal|out of memory|oom|killed|refused|failed|warn(ing)?)\b/i.test(l))

  // Memory trend: first vs last hour of the soak phase.
  const soak = metrics.filter(m => m.phase === 'soak')
  const avg = (xs: any[]) => xs.length ? xs.reduce((a, m) => a + m.rssKb, 0) / xs.length / 1024 : NaN
  const firstHour = soak.filter(m => m.t - t0 <= 60 * 60_000), lastT = soak.at(-1)?.t ?? 0, lastHour = soak.filter(m => lastT - m.t < 60 * 60_000 && m.t - t0 > 60 * 60_000)
  const memFirst = avg(firstHour), memLast = avg(lastHour)
  const memPass = lastHour.length > 0 && memLast <= memFirst * 1.15

  // Delivery: every accepted addressed message is committed at its recipient at least once.
  const sent = Object.values(people).flat().filter(e => e.ev === 'sent' && e.to)
  const unsent = Object.values(people).flat().filter(e => e.ev === 'unsent')
  const deliveries = new Map<string, number>()
  for (const [n, evs] of Object.entries(people)) for (const e of evs) if (e.ev === 'delivered' && e.to === n) deliveries.set(`${n}\0${e.id}`, (deliveries.get(`${n}\0${e.id}`) ?? 0) + 1)
  // Accepted but never delivered: still in the room (owed at the stop) when the observer saw it appended, lost otherwise.
  const onBus = new Set(obs.filter(e => e.ev === 'bus').map(e => e.id))
  const undelivered = sent.filter(e => !deliveries.get(`${e.to}\0${e.id}`))
  const lost = undelivered.filter(e => !onBus.has(e.id))
  const owedAtStop = undelivered.filter(e => onBus.has(e.id))
  const dups = [...deliveries.entries()].filter(([, c]) => c > 1)
  const resent = Object.values(people).flat().filter(e => e.ev === 'resent')
  const resentBad = resent.filter(e => !e.duplicate)
  const sentDup = sent.filter(e => e.duplicate)

  // Seqs: one id per seq, one seq per id, per room; epochs never repeat and rise per name.
  const seqProblems: string[] = []
  for (const room of Object.values(REPOS)) {
    const bySeq = new Map<number, string>(), byId = new Map<string, number>()
    for (const e of obs.filter(e => e.ev === 'bus' && e.room === room)) {
      if (bySeq.has(e.seq) && bySeq.get(e.seq) !== e.id) seqProblems.push(`${room}: seq ${e.seq} names ${bySeq.get(e.seq)} and ${e.id}`)
      if (byId.has(e.id) && byId.get(e.id) !== e.seq) seqProblems.push(`${room}: ${e.id} had seq ${byId.get(e.id)} then ${e.seq}`)
      bySeq.set(e.seq, e.id); byId.set(e.id, e.seq)
    }
  }
  for (const e of sent) {
    const hub = obs.find(o => o.ev === 'bus' && o.id === e.id)
    if (hub && e.seq !== undefined && hub.seq !== e.seq) seqProblems.push(`${e.id}: post reply seq ${e.seq}, bus seq ${hub.seq}`)
  }
  const incOf = (v: number) => Math.floor(v / 2 ** 21)
  const preSeqs = obs.filter(e => e.ev === 'bus' && restartBegin && e.t < restartBegin.t).map(e => e.seq)
  const postSeqs = obs.filter(e => e.ev === 'bus' && restartHealthy && e.t > restartHealthy.t + 5_000).map(e => e.seq)
  const preMaxSeq = Math.max(0, ...preSeqs), postMinSeq = postSeqs.length ? Math.min(...postSeqs.filter(s => s > preMaxSeq - 2 ** 21 * 0 && incOf(s) > incOf(preMaxSeq)), Infinity) : NaN
  const postRestartBelow = restartHealthy ? sent.filter(e => e.t > restartHealthy.t + 5_000 && !e.duplicate && e.seq !== undefined && e.seq <= preMaxSeq) : []
  const epochProblems: string[] = []
  const allGrants = new Map<number, string>()
  for (const [n, evs] of Object.entries(people)) {
    let high = 0
    for (const e of evs.filter(e => e.ev === 'status' && typeof e.epoch === 'number')) {
      if (e.epoch < high) epochProblems.push(`${n}: epoch ${e.epoch} after ${high}`)
      high = Math.max(high, e.epoch)
      const room = ROSTER.find(p => p.name === n)!.repo
      const k = e.epoch, owner = allGrants.get(k)
      if (owner && owner !== `${room}:${n}` && owner.split(':')[0] === room) epochProblems.push(`epoch ${k} granted to ${owner} and ${n}`)
      allGrants.set(k, `${room}:${n}`)
    }
  }

  // Names and leases: every participant keeps its name; departed leases end within TTL (45 s) + one sample.
  const nameDrift = Object.entries(people).flatMap(([n, evs]) => evs.filter(e => (e.ev === 'joined' || e.ev === 'status') && e.name && e.name !== n).map(e => `${n} ran as ${e.name} at min ${min(e.t)}`))
  const rejoins = Object.entries(people).map(([n, evs]) => ({ n, r: evs.find(e => e.ev === 'rejoined') }))
  const endChecks: string[] = []
  const lastRooms = rooms.filter(r => r.t > (orch.find(e => e.ev === 'stopping-children')?.t ?? Infinity) + 50_000)
  for (const r of lastRooms.slice(-2)) for (const h of r.holders) if (!h.ended && ROSTER.some(p => p.name === h.name)) endChecks.push(`${h.name} still live ${Math.round((r.t - (orch.find(e => e.ev === 'stopping-children')?.t ?? 0)) / 1000)} s after stop`)
  // The window in which /health failed outside the planned restart (CPU throttling on staging).
  const healthAll = orch.filter(e => e.ev === 'health')
  const outsideRestart = (t: number) => !(restartBegin && restartHealthy && t >= restartBegin.t - 5_000 && t <= restartHealthy.t + 15_000)
  const stallFails = healthAll.filter(e => e.status !== 200 && outsideRestart(e.t))
  const stallFrom = stallFails.length ? stallFails[0].t - 5 * 60_000 : Infinity, stallTo = stallFails.at(-1)?.t ?? -Infinity
  const inStall = (t: number) => t >= stallFrom && t <= stallTo + 60_000
  // Leases of disconnected participants: disconnects longer than TTL + 15 s must show a new epoch after.
  const disc = Object.entries(people).flatMap(([n, evs]) => evs.filter(e => e.ev === 'disconnect').map(e => {
    const after = evs.find(x => x.ev === 'status' && x.t > e.t + e.ms && x.hub && !x.paused && typeof x.epoch === 'number')
    return { n, t: e.t, ms: e.ms, before: e.epoch, after: after?.epoch, backMs: after ? after.t - e.t - e.ms : undefined }
  }))

  // Hub-side expiry of a disconnected holder: `hub: lease <epoch> on <name> expired`, measured from the disconnect.
  const expiries = flyLines.map(l => /^(\S+).*hub: lease (\d+) on (\S+) expired/.exec(l)).filter(Boolean)
    .map(m => ({ t: Date.parse(m![1]), epoch: Number(m![2]), name: m![3] }))
  const expiryRows = expiries.map(x => {
    const d = (people[x.name] ?? []).filter(e => e.ev === 'disconnect' && e.epoch === x.epoch && e.t <= x.t + 1_000).at(-1)
    return { ...x, afterDisconnectS: d ? (x.t - d.t) / 1000 : undefined }
  })
  const lateExpiry = expiryRows.filter(x => x.afterDisconnectS !== undefined && x.afterDisconnectS > 47)
  // A graceful leave ends the hub record (released) before the next observer sample.
  const leaveEnds = Object.entries(people).flatMap(([n, evs]) => evs.filter(e => e.ev === 'leave').map(e => {
    const sample = rooms.find(r => r.t > e.t + 5_000 && r.holders.some((h: any) => h.name === n))
    const h = sample?.holders.find((h: any) => h.name === n)
    return { n, t: e.t, ended: h?.ended ?? null, epoch: h?.epoch, left: e.epoch }
  }))
  // Restart: per participant, time from the restart until hub reachable again with a lease (status events).
  const restartRows: string[] = []
  let maxBack = 0
  if (restartBegin) for (const [n, evs] of Object.entries(people)) {
    const pre = evs.filter(e => e.ev === 'status' && e.t < restartBegin.t).at(-1)
    const down = evs.find(e => e.ev === 'status' && e.t >= restartBegin.t && e.t < restartBegin.t + 60_000 && !e.hub)
    const back = evs.find(e => e.ev === 'status' && e.t >= restartBegin.t && e.inc !== pre?.inc && e.hub && e.conn && typeof e.epoch === 'number' && !e.paused)
    const ms = back && restartHealthy ? back.t - restartHealthy.t : undefined
    if (ms !== undefined) maxBack = Math.max(maxBack, ms)
    restartRows.push(`| ${n} | ${pre?.epoch ?? '-'} (inc ${pre?.inc ?? '-'}) | ${back?.epoch ?? '-'} (inc ${back?.inc ?? '-'}) | ${back?.name ?? '-'} | ${down ? `${((down.t - restartBegin.t) / 1000).toFixed(0)} s` : 'already disconnected (planned)'} | ${ms !== undefined ? `${(ms / 1000).toFixed(1)} s` : '-'} |`)
  }

  // Health.
  const health = orch.filter(e => e.ev === 'health')
  const badHealth = health.filter(e => e.status !== 200 && !(restartBegin && restartHealthy && e.t >= restartBegin.t - 5_000 && e.t <= restartHealthy.t + 15_000))

  const counts = (ev: string) => Object.values(people).flat().filter(e => e.ev === ev).length
  const pf = (b: boolean) => b ? '**PASS**' : '**FAIL**'
  const md: string[] = []
  md.push(`## Metrics every 10 minutes`, '', ...out, '')
  md.push(`Activity: ${counts('sent')} posts accepted (${sent.length} addressed, ${sentDup.length} answered as duplicates on a retry), ${unsent.length} given up after 5 min, ${counts('delivered')} ledger deliveries, ${Object.values(people).flat().filter(e => e.ev === 'claim' && e.ok).length} claims taken (${counts('claim')} attempted), ${Object.values(people).flat().filter(e => e.ev === 'release' && String(e.out).startsWith('released')).length} releases, ${counts('big-edit')} large edits, ${counts('disconnect')} disconnects, ${rejoins.filter(r => r.r).length} leave-and-rejoins, ${resent.length} same-id resends.`, '')
  if (restartBegin) {
    md.push(`## Hub restart at minute ${min(restartBegin.t)}`, '', `Machine restart command to /health 200: ${((restartHealthy.t - restartBegin.t) / 1000).toFixed(1)} s. Slowest participant back (hub hello + valid lease) after health returned: ${(maxBack / 1000).toFixed(1)} s.`, '',
      '| participant | epoch before (incarnation) | epoch after (incarnation) | name after | first drop seen | back after /health 200 |', '|---|---|---|---|---|---|', ...restartRows, '',
      `Highest seq before the restart: ${preMaxSeq} (incarnation ${incOf(preMaxSeq)}); new posts after it at or below that: ${postRestartBelow.length}. Lowest post-restart seq in a new incarnation: ${Number.isFinite(postMinSeq) ? `${postMinSeq} (incarnation ${incOf(postMinSeq)})` : '-'}.`, '')
  }
  md.push('## Pass criteria', '')
  md.push(`- Memory: first-hour average ${memFirst.toFixed(1)} MB, last-hour average ${memLast.toFixed(1)} MB (pass: last within 15% of first). ${pf(memPass)}`)
  md.push(`- Leases: name drift ${nameDrift.length ? nameDrift.join('; ') : 'none'}; rejoins under the same name ${rejoins.filter(r => r.r?.sameName).length}/${rejoins.filter(r => r.r).length}; leases still live 50+ s after stop: ${endChecks.length ? endChecks.join('; ') : 'none'}. Disconnects: ${disc.length}; shorter than 30 s (inside the 45 s TTL even 15 s after a renew) kept their epoch ${disc.filter(d => d.ms < 30_000 && d.after === d.before).length}/${disc.filter(d => d.ms < 30_000).length}, or ${disc.filter(d => d.ms < 30_000 && d.after === d.before && !inStall(d.t)).length}/${disc.filter(d => d.ms < 30_000 && !inStall(d.t)).length} outside the CPU-throttled window; past it (over 50 s) re-acquired a new, higher epoch ${disc.filter(d => d.ms > 50_000 && d.after !== undefined && d.after > d.before).length}/${disc.filter(d => d.ms > 50_000).length}; slowest back to an unpaused lease after reconnecting ${(Math.max(0, ...disc.filter(d => !inStall(d.t)).map(d => d.backMs ?? 0)) / 1000).toFixed(1)} s outside that window, ${(Math.max(0, ...disc.filter(d => inStall(d.t)).map(d => d.backMs ?? 0)) / 1000).toFixed(1)} s inside it. Hub expiries of disconnected holders: ${expiryRows.length}, seconds after the disconnect began ${expiryRows.map(x => x.afterDisconnectS?.toFixed(0) ?? '?').join(', ') || '-'} (TTL 45 s from the last renew); later than 47 s: ${lateExpiry.length} (${lateExpiry.filter(x => inStall(x.t)).length} of them in the CPU-throttled window). Graceful leaves ended on the hub by the next sample: ${leaveEnds.filter(l => l.ended === 'released' && l.epoch === l.left).length}/${leaveEnds.length}${leaveEnds.some(l => !l.ended) ? ` (not yet: ${leaveEnds.filter(l => !l.ended).map(l => `${l.n} at min ${min(l.t)}${inStall(l.t) ? ', throttled window' : ''}`).join('; ')})` : ''}. ${pf(!nameDrift.length && !endChecks.length && !lateExpiry.length && rejoins.every(r => !r.r || r.r.sameName) && leaveEnds.every(l => l.ended))}`)
  md.push(`- Delivery: ${sent.length} addressed messages accepted; lost (accepted, never in the room, never delivered) ${lost.length}; still owed at the stop (in the room, recipient offline or stalled) ${owedAtStop.length}; duplicate deliveries ${dups.length}; same-id resends answered with the original (duplicate) ${resent.length - resentBad.length}/${resent.length}. ${pf(lost.length === 0 && dups.length === 0 && resentBad.length === 0)}${lost.length ? `\n  - lost: ${lost.slice(0, 10).map(e => `${e.id}→${e.to} (min ${min(e.t)})`).join(', ')}` : ''}${owedAtStop.length ? `\n  - owed at the stop: ${owedAtStop.slice(0, 10).map(e => `${e.id}→${e.to} (min ${min(e.t)})`).join(', ')}` : ''}${dups.length ? `\n  - duplicates: ${dups.slice(0, 10).map(([k, c]) => `${k.replace('\0', ':')}×${c}`).join(', ')}` : ''}`)
  md.push(`- Monotonic counters: seq problems ${seqProblems.length}, epoch problems ${epochProblems.length}, post-restart values at or below pre-restart ${postRestartBelow.length}. ${pf(!seqProblems.length && !epochProblems.length && !postRestartBelow.length)}${[...seqProblems, ...epochProblems].slice(0, 10).map(p => `\n  - ${p}`).join('')}`)
  md.push(`- Health: ${health.length} probes, ${badHealth.length} non-200 (8 s timeouts) outside the restart window${badHealth.length ? `, from minute ${min(badHealth[0].t)} to ${min(badHealth.at(-1)!.t)}` : ''}. ${pf(!badHealth.length)}`)
  md.push(`- Fly log lines since the start: ${flyLines.length}; matching error words: ${flyErrors.length}.${flyErrors.slice(0, 15).map(l => `\n  - \`${l.slice(0, 220).replace(/`/g, "'")}\``).join('')}`)
  md.push(`  - known info lines: ${[...kinds].map(([k, c]) => `${c} × ${k}`).join('; ') || 'none'}`)
  md.push(`  - other lines (${other.length}):${other.slice(0, 25).map(l => `\n    - \`${l.slice(0, 200).replace(/`/g, "'")}\``).join('')}`)
  const inv = orch.find(e => e.ev === 'inventory-probe')
  if (inv) md.push(`- Admin inventory probe: HTTP ${inv.status} (${String(inv.body).trim().slice(0, 80)}).`)
  fs.writeFileSync(path.join(DIR, 'report.md'), md.join('\n') + '\n')
  console.log(md.join('\n'))
}

// ---------------------------------------------------------------- main

const [mode, ...rest] = process.argv.slice(2)
const flag = (n: string, d: number) => { const i = rest.indexOf(n); return i >= 0 ? Number(rest[i + 1]) : d }
if (mode === 'participant') await participant(rest[0], rest[1] as RepoKey, Number(rest[2] ?? 0), Number(rest[3] ?? ROSTER.length))
else if (mode === 'run') await orchestrate(flag('--minutes', 180), flag('--restart-at', 90), flag('--participants', 8), flag('--post-idle', 3))
else if (mode === 'report') report()
else if (mode === 'cleanup') { fs.rmSync(CREDS, { recursive: true, force: true }); console.log(`removed ${CREDS}`) }
else { console.error('usage: npx tsx scripts/soak.mts run|report|cleanup [--minutes 180] [--restart-at 90] [--participants 8]'); process.exit(2) }
