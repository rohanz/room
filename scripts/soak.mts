// Soak test of a Room server or local daemon: simulated participants in two synthetic repos against one server for hours.
//
// Usage (from the repo root):
//   npx tsx scripts/soak.mts run [--minutes 180] [--restart-at 90[,480]] [--participants 8]   # the soak (orchestrator)
//   npx tsx scripts/soak.mts report                                                   # re-analyse a finished run
//   npx tsx scripts/soak.mts cleanup                                                  # delete credentials
//   npx tsx scripts/soak.mts metrics                                                  # one server memory/CPU sample
//   npx tsx scripts/soak.mts structs                                                  # Yjs struct counts of both rooms (observer login)
//
// Targets: SOAK_TARGET=team (default), with SOAK_LOCAL=1 for a source team server;
//          SOAK_TARGET=daemon for one synthetic clone with linked participant worktrees.
// Daemon mode uses source joinSession/createTools, no logins/room_create/Fly; restart-at calls
// stopLocalDaemon (daemon-bin.ts stop --common-dir), and participant recovery starts the replacement.
// No idle gaps are inserted. SOAK_COMPACT_MIN_DELETED also reaches the daemon as ROOM_COMPACT_MIN_DELETED.
// Samples include daemon PID/RSS/CPU/fds, participant RSS, room subtree sizes, tool p50/p95,
// and observer structs/deleted. Growth analysis reuses the local prototype: first/last thirds,
// OLS after first-third warm-up, both later means rising; hourly threshold max(10% initial mean,
// 1 MiB bytes, 2 counts, 10 ms latency, 1 CPU point). Requires >=9 samples spanning >=30 min.
// GROWING exits 1; failed/incomplete exits 2; short smokes warn about insufficient data.
// Use a fresh SOAK_DIR. Exit/signals stop children/server/daemon and remove synthetic work;
// logs/events/report survive. If daemon cleanup cannot be verified, work is retained for inspection.
// Example: SOAK_TARGET=daemon SOAK_SAMPLE_MIN=.25 SOAK_DIR=/tmp/room-soak-daemon npx tsx scripts/soak.mts run --minutes 3 --restart-at 1.5 --post-idle 0
// Env: SOAK_SERVER (default https://room-rohanz-staging.fly.dev), SOAK_DIR (default /tmp/room-soak),
//      SOAK_FLY_APP / SOAK_FLY_MACHINE (metrics over `flyctl ssh console`, read-only; the single restart at
//      --restart-at uses `flyctl machine restart`). --restart-at takes a comma list of minutes (0 skips restarts); SOAK_FLY_APP= skips Fly.
//      SOAK_LOCAL=1: no Fly at all. The orchestrator runs the server itself from source on 127.0.0.1:SOAK_LOCAL_PORT
//      (default 1251) over SOAK_DIR/data, restarts it (SIGTERM, respawn) at --restart-at, samples it with `ps`, and
//      passes SOAK_COMPACT_MIN_DELETED to it as ROOM_COMPACT_MIN_DELETED. SOAK_SAMPLE_MIN sets the sample interval
//      (default 10 minutes; the observer's samples also count each room's structs).
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
import { setTimeout as delay } from 'node:timers/promises'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const run = promisify(execFile)
const DAEMON = process.env.SOAK_TARGET === 'daemon'
if (process.env.SOAK_TARGET && !['daemon', 'team'].includes(process.env.SOAK_TARGET)) throw new Error('SOAK_TARGET must be team or daemon')
const LOCAL = !DAEMON && process.env.SOAK_LOCAL === '1'
const LOCAL_PORT = Number(process.env.SOAK_LOCAL_PORT ?? 1251)
const HTTP = (LOCAL ? `http://127.0.0.1:${LOCAL_PORT}` : process.env.SOAK_SERVER ?? 'https://room-rohanz-staging.fly.dev').replace(/\/+$/, '')
const WS = HTTP.replace(/^http/, 'ws')
const DIR = process.env.SOAK_DIR ?? '/tmp/room-soak'
const APP = LOCAL || DAEMON ? '' : process.env.SOAK_FLY_APP ?? 'room-rohanz-staging'
const SAMPLE_MIN = Number(process.env.SOAK_SAMPLE_MIN ?? 10)
/** SOAK_BIG_EDITS=0 turns off the 100–500 KB payload edits, to measure the daemon's memory without live-doc growth. */
const BIG_EDITS = process.env.SOAK_BIG_EDITS !== '0'
const MACHINE = process.env.SOAK_FLY_MACHINE ?? '2879590f442648'
if (APP === 'room-rohanz') throw new Error('refusing to run against the production app room-rohanz')
if (!/^\/tmp\/|room-soak/.test(DIR)) throw new Error(`refusing SOAK_DIR ${DIR}: must be under /tmp or contain room-soak`)
const EVENTS = path.join(DIR, 'events'), CREDS = path.join(DIR, 'creds'), WORK = path.join(DIR, 'work'), LOGS = path.join(DIR, 'logs')

const COMMON = path.join(WORK, 'daemon-src', '.git')
const REPOS = { alpha: DAEMON ? 'local/daemon-src' : 'github.com/soak/alpha', beta: DAEMON ? 'local/daemon-src' : 'github.com/soak/beta' }
const roomsForTarget = () => [...new Set(Object.values(REPOS))]
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

async function setupRepos(count: number): Promise<void> {
  if (DAEMON) {
    const src = path.dirname(COMMON)
    fs.mkdirSync(path.join(src, 'app'), { recursive: true })
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(src, 'app', `mod_${i}.py`), pyModule(i, 180))
    await git(src, 'init', '-q', '-b', 'main'); await git(src, 'add', '-A')
    await git(src, '-c', 'user.email=soak@room', '-c', 'user.name=soak', 'commit', '-qm', 'synthetic daemon soak')
    for (const p of ROSTER.slice(0, count)) await git(src, 'worktree', 'add', '-q', '-b', p.name, path.join(WORK, p.name))
    return
  }
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

async function participant(name: string, repo: RepoKey, restarts: number[], count: number, minutes: number): Promise<void> {
  const { joinSession, leaveSession, whenStale } = await import('../packages/room-mcp/src/session.js')
  const { StaleReplacement } = await import('../packages/room-mcp/src/compacted.js')
  const { createTools } = await import('../packages/room-mcp/src/tools.js')
  const { setCredential } = await import('../packages/room-mcp/src/credentials.js')
  const emit = emitter(path.join(EVENTS, `${name}.jsonl`))
  const dir = path.join(WORK, name)
  const { session: cred } = DAEMON ? { session: '' } : JSON.parse(fs.readFileSync(path.join(CREDS, `${name}.json`), 'utf8'))
  // Always an explicit file under SOAK_DIR: joinSession re-configures credentials from its options.
  const credentialsPath = path.join(CREDS, `${name}.credentials.json`)
  if (!DAEMON) setCredential(credentialsPath, WS, { session: cred, login: name, at: Date.now() })
  const peers = ROSTER.slice(0, count).filter(p => (DAEMON || p.repo === repo) && p.name !== name).map(p => p.name)
  const log = (line: string) => { if (/error|fail|refus|lost|stale|paused|warn/i.test(line)) emit({ ev: 'log', line: line.slice(0, 300) }) }
  let s: any, tools: any, stopping = false, leaving = false
  // Neighbours in a room share a file, so claims overlap someone's scope and are really taken.
  const idx = ROSTER.filter(p => DAEMON || p.repo === repo).findIndex(p => p.name === name)
  const myFiles = () => [`app/mod_${idx % 4}.py`, `app/mod_${(idx + 1) % 4}.py`]

  const join = async (why: string) => {
    const t0 = Date.now()
    for (let attempt = 1; ; attempt++) {
      try { s = await joinSession({ dir, server: DAEMON ? 'local' : WS, ...(DAEMON ? { name } : {}), credentialsPath, connectTimeoutMs: 30_000, log }); break }
      catch (e) { emit({ ev: 'join-failed', why, attempt, error: String(e).slice(0, 300) }); if (stopping) return; await sleep(10_000) }
    }
    tools = createTools({ getSession: () => s, setSession: x => { s = x }, cwd: dir, log })
    const deliveredIds = new Set<string>()
    ;(globalThis as any).__roomPruneLog = (info: Record<string, unknown>) => emit({ ev: 'receipt-prune', ...info })
    // Who deletes my receipts? Observe my own receipt map: deleted keys, the transaction's origin and whether it was local.
    const watchSeen = (sess: typeof s) => {
      const map = sess.room.seen(sess.me.name)
      map.observe((event: any, tx: any) => {
        const deleted = [...event.changes.keys.entries()].filter(([, c]: any) => c.action === 'delete').map(([k]: any) => k)
        if (!deleted.length) return
        const origin = tx.origin, kind = origin === null ? 'null' : typeof origin === 'object' ? origin.constructor?.name ?? 'object' : String(origin)
        emit({ ev: 'seen-delete', keys: deleted.length, sample: deleted.slice(0, 3), local: tx.local, origin: kind, bus: sess.room.bus.length, size: map.size, docId: sess.room.doc.clientID })
      })
    }
    if (process.env.SOAK_WATCH_SEEN === '1') watchSeen(s)
    // Trace every deletion of an item in my own receipt map at the Yjs level (integration-time demotion or an applied
    // delete set), without touching the map itself. Patched once per process.
    if (process.env.SOAK_ITEM_TRACE === '1' && !(globalThis as any).__roomItemTrace) {
      (globalThis as any).__roomItemTrace = true
      const Item = (Y as any).Item, origDelete = Item.prototype.delete
      Item.prototype.delete = function (this: any, tx: any) {
        try {
          const parent = this.parent
          if (parent && parent.doc && this.parentSub) {
            const key = [...parent.doc.share.entries()].find(([, t]: any) => t === parent)?.[0] as string | undefined
            if (key?.startsWith('seen:') && key === `seen:${encodeURIComponent(s?.me.name ?? '')}`) {
              const o = tx?.origin
              emit({ ev: 'item-delete', map: key, k: String(this.parentSub).slice(0, 24), writer: this.id.client, clock: this.id.clock, local: tx?.local, origin: o === null || o === undefined ? 'null' : typeof o === 'object' ? o.constructor?.name ?? 'object' : String(o), current: parent._map.get(this.parentSub) === this, hasRight: this.right !== null, alreadyDeleted: this.deleted, bus: s?.room.bus.length, mapSize: parent._map.size, stack: new Error().stack?.split('\n').slice(2, 7).map((l: string) => l.trim().replace(/^at /, '').replace(/\(.*\//, '(')).join(' < ') })
            }
          }
        } catch { /* diagnostics only */ }
        return origDelete.call(this, tx)
      }
    }
    const walk = (item: any): number[] => { const out: number[] = []; for (let n = item; n && out.length < 2000; n = n.right) out.push(n.id.client); return out }
    const call = tools.call.bind(tools)
    tools.call = async (tool: string, args: unknown) => {
      const started = performance.now()
      try { return await call(tool, args) }
      finally { emit({ ev: 'latency', tool, ms: performance.now() - started }) }
    }
    // As room-mcp does for every joined session: the hooks bridge and the conflict watcher (claims and merge
    // conflicts, the room's `conflicts` slots). Without it the load has no conflict detection at all.
    tools.attachHooks(s)
    watchStale()
    // Every committed reply batch is a handoff to the host: record each id it carried (the delivery log).
    const commit = tools.ledger.commit.bind(tools.ledger)
    tools.ledger.commit = (batch: any) => {
      if (!batch.committed) for (const { m, via } of batch.items) {
        // Diagnostics for a redelivery: what this replica knew when it handed the message off again.
        const again = deliveredIds.has(m.id)
        deliveredIds.add(m.id)
        emit({ ev: 'delivered', id: m.id, from: m.from, to: m.to, type: m.type, seq: m.seq, via, ...(again ? { again: true,
          receipt: s.room.seen(s.me.name).get(m.id) ?? null, seenSize: s.room.seen(s.me.name).size, seenMaps: [...s.room.doc.share.keys()].filter(k => k.startsWith('seen:')).length,
          bus: s.room.bus.length, mail: s.room.mail.size, synced: s.provider.synced, docId: s.room.doc.clientID, epoch: s.lease?.epoch, me: s.me.name,
          // Yjs internals of my receipt map: every key's current item, whether it is deleted and which client wrote it.
          seenItems: [...((s.room.seen(s.me.name) as any)._map as Map<string, any>).entries()].slice(0, 6).map(([k, it]) => `${k.slice(0, 18)}:${it.deleted ? 'del' : 'live'}:${it.id.client}`),
          seenItemCount: ((s.room.seen(s.me.name) as any)._map as Map<string, any>).size,
          busClients: [...new Set([...(s.room.bus as any)._start ? walk((s.room.bus as any)._start) : []])].slice(0, 4) } : {}) })
        if (m.type === 'question' && m.to === s.me.name) setTimeout(() => void answer(m), jitter(3_000, 30_000))
      }
      return commit(batch)
    }
    emit({ ev: 'joined', why, name: s.me.name, ms: Date.now() - t0, epoch: s.lease?.epoch, room: s.roomName })
    const area = `area-${name.slice(-1)}`
    const paths = [...myFiles(), `data/${name}/`]
    emit({ ev: 'tool', tool: 'room_scope', out: (await tools.call('room_scope', { area, summary: `soak work for ${name}`, paths })).slice(0, 160) })
  }

  // --- a replica the server refused after a compacting restart (4409): replaced as room-mcp's auto-join replaces it.
  const replacement = new StaleReplacement({ joinedSessions: () => tools.joinedSessions(), drop: (x, why) => tools.drop(x, why),
    attachWorkersRoom: (x, lead) => tools.attachWorkersRoom(x, lead), credentialsPath, log })
  let replacing = false
  function watchStale(): void {
    const current = s
    whenStale(current, () => {
      if (s !== current || replacing || stopping) return
      replacing = true
      const before = { name: s.me.name, epoch: s.lease?.epoch }
      emit({ ev: 'stale', ...before })
      void (async () => {
        const t0 = Date.now()
        await replacement.begin(current)
        for (let attempt = 1; !stopping; attempt++) {
          try {
            const fresh = await replacement.join()
            await replacement.finish(fresh, async x => { s = x; tools.attachHooks(x); if (process.env.SOAK_WATCH_SEEN === '1') watchSeen(x) })
            emit({ ev: 'replaced', sameName: s.me.name === before.name, name: s.me.name, epoch: s.lease?.epoch, prevEpoch: before.epoch, ms: Date.now() - t0, attempts: attempt })
            break
          } catch (e) { emit({ ev: 'replace-failed', attempt, error: String(e).slice(0, 300) }); await sleep(Math.min(20_000, 1_000 * 2 ** attempt)) }
        }
        replacing = false
        if (s !== current) watchStale()
      })()
    })
  }

  // --- messages: deterministic ids; a failed post retries the same id until accepted (or 5 min).
  let n = 0
  const post = async (body: any, id: string) => {
    const t0 = Date.now()
    for (let attempt = 1; ; attempt++) {
      if (!s || leaving || replacing) { await sleep(2_000); continue }
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
    if (!s || !tools || leaving || replacing) return
    const batch = tools.ledger.open('reply')
    const chosen = tools.ledger.select(s, batch)
    if (chosen.length) tools.ledger.commit(batch); else tools.ledger.release(batch)
  }

  // --- claims and edits
  const claimCycle = async () => {
    if (!s || leaving || replacing) return
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
    if (BIG_EDITS && Math.random() < 0.08) {
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
    if (!s || leaving || replacing) return
    const ms = Math.round(jitter(5_000, 75_000))
    emit({ ev: 'disconnect', ms, epoch: s.lease?.epoch })
    s.provider.disconnect(); await sleep(ms); s?.provider.connect() // a leave during the sleep replaced the session
    emit({ ev: 'reconnect-requested' })
  })
  // One leave-and-rejoin under the same name, anywhere in the run but away from the hub restarts.
  let leaveAt = jitter(25, Math.max(60, Math.min(minutes - 20, 150 + (minutes - 180)))) * min
  for (const r of restarts) if (Math.abs(leaveAt - r * min) < 8 * min) leaveAt += 16 * min
  if (minutes < 30) leaveAt = minutes * .35 * min
  setTimeout(async () => {
    while (replacing && !stopping) await sleep(1_000)
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

const REMOTE = 'for p in /proc/[0-9]*; do c=$(tr "\\0" " " < $p/cmdline 2>/dev/null); case "$c" in sh\\ *) ;; *loader.mjs*packages/server*|node\\ packages/server/dist/server.mjs*) echo SRV ${p#/proc/} $(grep VmRSS $p/status | tr -s " " | cut -d" " -f2) $(grep VmHWM $p/status | tr -s " " | cut -d" " -f2) $(cut -d" " -f14,15 $p/stat);; *tsx\\ packages/server*) echo WRAP ${p#/proc/} $(grep VmRSS $p/status | tr -s " " | cut -d" " -f2);; esac; done; echo DATA $(du -sk /data | cut -f1); echo MEMAVAIL $(grep MemAvailable /proc/meminfo | tr -s " " | cut -d" " -f2); echo UPTIME $(cut -d" " -f1 /proc/uptime); echo STAT $(head -1 /proc/stat)'
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
      // Machine-wide ticks: cpu user nice system idle iowait irq softirq steal …; steal is CPU the host withheld.
      if (f[0] === 'STAT' && f[1] === 'cpu') { const v = f.slice(2, 10).map(Number); out.totalTicks = v.reduce((a, b) => a + b, 0); out.stealTicks = v[7] }
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
  const { RoomDoc, participantRecord, roomConnection, historyOf, docGeneration, STALE_REPLICA_CODE } = await import('@room/shared')
  const { LOCAL_CLIENT_COMPAT } = await import('../packages/room-mcp/src/client-compat.js')
  // Every (id, seq) the hub appends, as it syncs in: a seq must never name two ids.
  const seen = new Map<string, number>()
  let doc: Y.Doc, rd: InstanceType<typeof RoomDoc>, provider: WebsocketProvider
  const connect = () => {
    doc = new Y.Doc(); rd = new RoomDoc(doc)
    const info = DAEMON ? discovery() : undefined
    // The daemon refuses a writer socket without lifecycle negotiation (relay 4406); offer the local client contract.
    const negotiation = info ? { offer: LOCAL_CLIENT_COMPAT, sessionId: `soak-observer-${process.pid}`, onRefusal: (text: string) => emit({ ev: 'observer-refused', room, text }) } : undefined
    provider = new WebsocketProvider(info ? `ws://127.0.0.1:${info.port}` : WS, encodeURIComponent(room), doc, { WebSocketPolyfill: authorizedWebSocket(info ? { key: info.key, negotiation } : { session }) as any, ...roomConnection(doc) })
    provider.awareness.setLocalState(null)
    const current = rd
    rd.bus.observe(() => { for (const m of current.messages()) if (typeof m.seq === 'number' && seen.get(m.id) !== m.seq) { seen.set(m.id, m.seq); emit({ ev: 'bus', room, id: m.id, seq: m.seq, from: m.from, type: m.type }) } })
    // The room was compacted at a server restart: this replica is refused, so take a fresh one, as a client restart does.
    provider.on('connection-close', (event: { code?: number } | null) => {
      if (event?.code !== STALE_REPLICA_CODE) return
      emit({ ev: 'observer-replaced', room })
      provider.destroy(); doc.destroy()
      connect()
    })
  }
  connect()
  let nonce = DAEMON ? discovery()?.nonce : undefined
  const refresh = DAEMON ? setInterval(() => {
    const next = discovery()?.nonce
    if (next && next !== nonce) { nonce = next; provider.destroy(); doc.destroy(); connect() }
  }, 1000) : undefined
  let last = { structs: 0, deleted: 0 }
  const sample = () => {
    const names = new Set<string>()
    for (const k of rd.participants.keys()) names.add(String(k).split('\u0000')[0])
    const holders = [...names].map(n => ({ n, h: participantRecord(rd, n)?.holder as any })).filter(x => x.h)
      .map(({ n, h }) => ({ name: n, epoch: h.epoch, ended: h.ended ?? null, at: h.at }))
    const present = [...provider.awareness.getStates().values()].map((st: any) => st?.user?.name).filter(Boolean)
    const meta = doc.getMap('meta')
    const history = historyOf(doc)
    last = history
    emit({ ev: 'room', room, connected: provider.wsconnected, synced: provider.synced, holders, present,
      live: holders.filter(h => !h.ended).length, bus: rd.bus.length, mail: rd.mail.size, docBytes: Y.encodeStateAsUpdate(doc).length,
      structs: history.structs, deleted: history.deleted, generation: docGeneration(doc) ?? '0',
      hubSeq: meta.get('hubSeq'), hubEpoch: meta.get('hubEpoch'), hubIncarnation: meta.get('hubIncarnation'),
      // Receipt map sizes per participant: the live document's view, to compare with the saved snapshot at a restart.
      receipts: Object.fromEntries([...doc.share.keys()].filter(k => k.startsWith('seen:')).map(k => [decodeURIComponent(k.slice(5)), doc.getMap(k).size])) })
  }
  return { sample, history: () => last, stop: () => { clearInterval(refresh); provider.destroy(); doc.destroy() } }
}


// Local daemon control uses the same source function as daemon-bin.ts stop --common-dir.
function discovery(): { pid: number; port: number; nonce: string; key: string } | undefined {
  try { return JSON.parse(fs.readFileSync(path.join(COMMON, 'room/relay.json'), 'utf8')) } catch { return undefined }
}
const healthURL = () => DAEMON ? `http://127.0.0.1:${discovery()?.port ?? 0}` : HTTP
async function stopDaemon() {
  const { stopLocalDaemon } = await import('../packages/relay/src/daemon.js')
  await stopLocalDaemon(COMMON)
}
/**
 * The scheduled restart stops the daemon the way an operator or the system would, with writers connected:
 * SIGTERM (its signal path drains and saves), after which participant recovery starts the replacement.
 * POST /daemon/stop refuses while writers are connected (409), so it fits cleanup, not a live restart.
 */
let restartCount = 0
const sleepMs = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function signalDaemon() {
  const info = discovery()
  if (!info) throw new Error('no daemon discovery file to restart')
  process.kill(info.pid, 'SIGTERM')
  // Keep what the daemon saved on its way out: the file a reload reads is the evidence for lost receipts.
  const before = snapshotStamp(), until = Date.now() + 15_000
  while (Date.now() < until && snapshotStamp() === before) await sleepMs(50)
  copySnapshots(`restart-${++restartCount}`)
}
const relayDir = () => path.join(COMMON, 'room', 'relay')
function snapshotStamp(): string {
  try { return fs.readdirSync(relayDir()).filter(n => n.endsWith('.ydoc')).map(n => `${n}:${fs.statSync(path.join(relayDir(), n)).mtimeMs}`).join(',') } catch { return '' }
}
/** Copies of the daemon's saved room snapshots, for comparing the saved state with the live document afterwards. */
function copySnapshots(label: string): void {
  const keep = path.join(DIR, 'snapshots', label)
  try {
    fs.mkdirSync(keep, { recursive: true })
    for (const name of fs.readdirSync(relayDir())) if (name.endsWith('.ydoc')) fs.copyFileSync(path.join(relayDir(), name), path.join(keep, name))
  } catch (e) { console.error('snapshot copy failed:', e) }
}
async function cleanupDaemon() {
  // Check for startup contenders as well as the published daemon before removing its repo.
  const rows = (await run('ps', ['-ax', '-o', 'pid=,command='], { timeout: 5000 })).stdout.split('\n')
  const pids = rows.flatMap(line => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    return m && m[2].includes(COMMON) && /daemon-bin.ts|room-daemon.mjs/.test(m[2]) ? [Number(m[1])] : []
  })
  if (discovery()) await stopDaemon()
  for (const pid of pids) {
    try {
      const command = (await run('ps', ['-p', String(pid), '-o', 'command='])).stdout
      if (command.includes(COMMON) && /daemon-bin.ts|room-daemon.mjs/.test(command)) {
        process.kill(pid, 'SIGTERM')
        throw new Error(`daemon startup contender ${pid} still present; retained ${WORK}, retry cleanup`)
      }
    } catch (e) { if ((e as { code?: unknown }).code !== 1) throw e }
  }
}
const cpu = new Map<number, { t: number; seconds: number }>()
  function disk(dir: string): { files: number; dirs: number; bytes: number } {
    const result = { files: 0, dirs: 0, bytes: 0 }
    try {
      for (const name of fs.readdirSync(dir)) {
        try {
          const file = path.join(dir, name), st = fs.lstatSync(file)
          if (st.isDirectory()) { const d = disk(file); result.dirs += 1 + d.dirs; result.files += d.files; result.bytes += d.bytes }
          else { result.files++; result.bytes += st.size } // never follow symlinks
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    return result
  }
  async function processStats(pid: number, role: string) {
    try {
      const raw = (await run('ps', ['-p', String(pid), '-o', 'rss=,time='], { timeout: 5000 })).stdout.trim().split(/\s+/)
      const time = raw[1].split('-'), days = time.length === 2 ? Number(time.shift()) : 0
      const seconds = days * 86400 + time[0].split(':').reduce((s, v) => s * 60 + Number(v), 0)
      let fds: number | null = null
      try { fds = fs.readdirSync(`/proc/${pid}/fd`).length } catch {
        try { fds = (await run('lsof', ['-nP', '-a', '-p', String(pid), '-Ff'], { timeout: 5000 })).stdout.split('\n').filter(l => /^f\d/.test(l)).length } catch { /* unavailable */ }
      }
      const prev = cpu.get(pid), t = Date.now(); cpu.set(pid, { t, seconds })
      return { pid, role, rssBytes: Number(raw[0]) * 1024, cpuSeconds: seconds, fds,
        cpuPercent: prev && seconds >= prev.seconds ? (seconds - prev.seconds) / (t - prev.t) * 100000 : null }
    } catch (e) {
      // ps exits 1 for a vanished PID; a denied/missing sampler is a run failure.
      if ((e as { code?: unknown }).code === 1) return null
      throw e
    }
  }

let daemonPeak = { nonce: '', rssKb: 0 }
async function daemonMetrics(): Promise<Record<string, number> | { error: string }> {
  const info = discovery()
  if (!info) return { error: 'daemon discovery unavailable' }
  if (daemonPeak.nonce !== info.nonce) { daemonPeak = { nonce: info.nonce, rssKb: 0 }; cpu.delete(info.pid) }
  const previous = cpu.get(info.pid)
  const stats = await processStats(info.pid, 'daemon')
  if (previous) cpu.set(info.pid, previous); else cpu.delete(info.pid)
  if (stats) daemonPeak.rssKb = Math.max(daemonPeak.rssKb, stats.rssBytes / 1024)
  return stats ? { pid: info.pid, rssKb: stats.rssBytes / 1024, cpuTicks: stats.cpuSeconds * 100, hwmKb: daemonPeak.rssKb } : { error: 'daemon exited during sample' }
}
let lastLatencySample = 0
let previousServerSample: { t: number; pid: number; ticks: number; uptime: number } | undefined
async function sampleGrowth(children: Map<string, ChildProcess>) {
  const t = Date.now(), metrics: Record<string, number> = {}, latency: Record<string, unknown> = {}, trees: Record<string, unknown> = {}
  const info = DAEMON ? discovery() : undefined
  const processes = (await Promise.all([
    ...(info ? [processStats(info.pid, 'daemon')] : []),
    ...[...children.values()].filter(c => c.pid && c.exitCode === null && c.signalCode === null).map(c => processStats(c.pid!, 'participant')),
  ])).filter(p => p !== null)
  for (const pid of cpu.keys()) if (!processes.some(p => p.pid === pid)) cpu.delete(pid)
  for (const role of ['daemon', 'participant']) for (const key of ['rssBytes', 'fds', 'cpuPercent'] as const) {
    const values = processes.filter(p => p.role === role).map(p => p[key]).filter((v): v is number => v !== null)
    if (values.length) {
      metrics[`${role}.${key}.mean`] = values.reduce((a, b) => a + b, 0) / values.length
      metrics[`${role}.${key}.max`] = Math.max(...values)
    }
  }
  if (DAEMON) {
    const room = path.join(COMMON, 'room')
    const dirs = new Set(['registry', 'sessions', 'logs', 'preview', 'previews'])
    for (const name of fs.readdirSync(room)) if (fs.lstatSync(path.join(room, name)).isDirectory()) dirs.add(name)
    for (const [name, dir] of [['room', room], ...[...dirs].map(n => [`room/${n}`, path.join(room, n)])]) {
      const d = disk(dir); trees[name] = d
      for (const [k, v] of Object.entries(d)) metrics[`${name}.${k === 'bytes' ? 'Bytes' : k}`] = v
    }
  }
  const timings: Record<string, number[]> = {}
  for (const name of children.keys()) for (const e of readEvents(path.join(EVENTS, `${name}.jsonl`))) {
    if (e.ev === 'latency' && e.t > lastLatencySample && e.t <= t) (timings[e.tool] ??= []).push(e.ms)
  }
  lastLatencySample = t
  for (const [name, values] of Object.entries(timings)) {
    values.sort((a, b) => a - b)
    const p50 = values[Math.ceil(values.length * .5) - 1], p95 = values[Math.ceil(values.length * .95) - 1]
    latency[name] = { count: values.length, p50, p95 }
    metrics[`${name}.p50Ms`] = p50; metrics[`${name}.p95Ms`] = p95
  }
  const rooms = readEvents(path.join(EVENTS, 'observer.jsonl'))
  for (const room of roomsForTarget()) {
    const last = rooms.filter(e => e.ev === 'room' && e.room === room && e.synced).at(-1)
    if (last) for (const key of ['structs', 'deleted', 'docBytes']) metrics[`${room}.${key}`] = last[key]
  }
  if (!DAEMON) {
    const m = await metricsNow()
    if ('error' in m) throw new Error(String(m.error))
    metrics['server.rssBytes'] = m.rssKb * 1024
    metrics['server.dataBytes'] = m.dataKb * 1024
    const prev = previousServerSample
    if (prev && prev.pid === m.pid && m.uptimeS >= prev.uptime && m.cpuTicks >= prev.ticks) metrics['server.cpuPercent'] = (m.cpuTicks - prev.ticks) / (t - prev.t) * 1000
    previousServerSample = { t, pid: m.pid, ticks: m.cpuTicks, uptime: m.uptimeS }
  }
  emitter(path.join(EVENTS, 'orchestrator.jsonl'))({ ev: 'growth-sample', t, metrics, processes, trees, latency, daemonNonce: info?.nonce })
}

// ---------------------------------------------------------------- local server (SOAK_LOCAL=1): run, restart, sample

let localServer: { child: ChildProcess; started: number; maxRssKb: number } | undefined
const LOCAL_LOG = path.join(DIR, 'server-logs.txt')
async function startLocalServer(): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ROOM_|CLAUDE_|CODEX_|YPERSISTENCE)/.test(k)))
  const out = fs.openSync(LOCAL_LOG, 'a')
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(path.dirname(new URL(import.meta.url).pathname), '../packages/server/src/index.ts')], {
    env: { ...env, HOST: '127.0.0.1', PORT: String(LOCAL_PORT), GITHUB_CLIENT_ID: 'fake', YPERSISTENCE: path.join(DIR, 'data'),
      ...(process.env.SOAK_COMPACT_MIN_DELETED ? { ROOM_COMPACT_MIN_DELETED: process.env.SOAK_COMPACT_MIN_DELETED } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'] })
  // Each line timestamped, as Fly's log lines are, for the report's log classification.
  const stamp = (b: Buffer) => { for (const l of b.toString().split('\n')) if (l.trim()) fs.writeSync(out, `${new Date().toISOString()} ${l}\n`) }
  child.stdout!.on('data', stamp); child.stderr!.on('data', stamp)
  child.once('exit', () => fs.closeSync(out))
  localServer = { child, started: Date.now(), maxRssKb: 0 }
  for (let i = 0; i < 600; i++) {
    try { if ((await fetch(`${HTTP}/health`, { signal: AbortSignal.timeout(2_000) })).ok) return } catch { /* starting */ }
    if (child.exitCode !== null) throw new Error(`the local server exited (${child.exitCode}); see ${LOCAL_LOG}`)
    await sleep(200)
  }
  throw new Error('the local server did not answer /health')
}
async function stopLocalServer(): Promise<void> {
  const child = localServer?.child
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill('SIGTERM')
  })
}
/** The server process with `ps`: RSS, CPU time (as 1/100 s ticks), its peak RSS seen, and the data volume. */
async function localMetrics(): Promise<Record<string, number> | { error: string }> {
  const server = localServer
  if (!server?.child.pid || server.child.exitCode !== null) return { error: 'local server not running' }
  try {
    const { stdout } = await run('ps', ['-o', 'rss=,time=', '-p', String(server.child.pid)])
    const [rss, time] = stdout.trim().split(/\s+/)
    const parts = time!.split(/[:.]/).map(Number) // [[dd-]hh:]mm:ss.cc
    const [mm, ss, cc] = parts.slice(-3), hh = parts.length > 3 ? parts.at(-4)! : 0
    const rssKb = Number(rss)
    server.maxRssKb = Math.max(server.maxRssKb, rssKb)
    const { stdout: du } = await run('du', ['-sk', path.join(DIR, 'data')])
    return { pid: server.child.pid, rssKb, hwmKb: server.maxRssKb, cpuTicks: ((hh * 60 + mm!) * 60 + ss!) * 100 + cc!, uptimeS: (Date.now() - server.started) / 1000, dataKb: Number(du.split(/\s+/)[0]) }
  } catch (e) { return { error: String(e).slice(0, 300) } }
}
let localLogLines = 0
/** New server log lines since the last call, as flyLogs reports them. */
function localLogs(file: string): { lines: number; errors: string[] } {
  let all: string[] = []
  try { all = fs.readFileSync(LOCAL_LOG, 'utf8').split('\n').filter(Boolean) } catch { /* not yet */ }
  const fresh = all.slice(localLogLines)
  localLogLines = all.length
  fs.appendFileSync(file, fresh.join('\n') + (fresh.length ? '\n' : ''))
  return { lines: fresh.length, errors: fresh.filter(l => /\b(error|exception|uncaught|fatal|out of memory|oom|killed|refused|failed|warn(ing)?)\b/i.test(l)) }
}
const metricsNow = () => DAEMON ? daemonMetrics() : LOCAL ? localMetrics() : flyMetrics()
const logsSince = (file: string, since: number) => DAEMON ? Promise.resolve({ lines: 0, errors: [] as string[] }) : LOCAL ? Promise.resolve(localLogs(file)) : flyLogs(file, since)

async function orchestrate(minutes: number, restarts: number[], count: number, postIdle: number): Promise<void> {
  if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isFinite(SAMPLE_MIN) || SAMPLE_MIN <= 0 || !Number.isInteger(count) || count < 2 || count > ROSTER.length) throw new Error('minutes/sample interval must be positive; participants must be 2..8')
  fs.mkdirSync(EVENTS, { recursive: true }); fs.mkdirSync(LOGS, { recursive: true })
  const emit = emitter(path.join(EVENTS, 'orchestrator.jsonl'))
  const children = new Map<string, ChildProcess>()
  const observers: Awaited<ReturnType<typeof observer>>[] = []
  const timers: ReturnType<typeof setInterval>[] = []
  const abort = new AbortController()
  const pause = (ms: number) => delay(ms, undefined, { signal: abort.signal })
  const interrupt = () => abort.abort(new Error('interrupted by signal'))
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  let ownWork = false
  try {
    if (fs.existsSync(WORK)) throw new Error(`refusing existing soak work directory: ${WORK}; use a fresh SOAK_DIR`)
    ownWork = true
    if (LOCAL) await startLocalServer()
    if (!DAEMON) {
    const health = await fetch(`${HTTP}/health`).then(r => r.json()) as { hub?: number }
    const cfg = await fetch(`${HTTP}/auth/config`).then(r => r.json()) as { fake?: boolean }
    if (health.hub !== 1 || !cfg.fake) throw new Error(`${HTTP} must run a 0.17 hub with the fake issuer (health ${JSON.stringify(health)})`)
    }
    await setupRepos(count)
    const roster = ROSTER.slice(0, count)
    const sessions: Record<string, string> = {}
    if (!DAEMON) {
    for (const p of [...roster.map(p => p.name), 'soak-observer']) sessions[p] = await fakeLogin(p)
    for (const room of roomsForTarget()) await openRoom(room, sessions['soak-observer'])
    // The inventory needs ROOM_ADMINS; record whether this server lets the observer read it.
    const inv = await fetch(`${HTTP}/admin/inventory`, { headers: { authorization: `Bearer ${sessions['soak-observer']}` } })
    emit({ ev: 'inventory-probe', status: inv.status, body: (await inv.text()).slice(0, 200) })
    } else emit({ ev: 'team-steps-skipped', reason: 'local daemon: no login, room_create or admin inventory' })
    const idle = DAEMON ? {} : await metricsNow()
    emit({ ev: 'metrics', phase: 'pre-soak idle', ...idle })

    const t0 = Date.now()
    emit({ ev: 'start', minutes, restarts, participants: roster.map(p => p.name), server: DAEMON ? 'local daemon' : HTTP, target: DAEMON ? 'daemon' : 'team' })
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ROOM_|CLAUDE_|CODEX_)/.test(k)))
    for (const p of roster) {
      const out = fs.openSync(path.join(LOGS, `${p.name}.log`), 'a')
      const child = spawn(process.execPath, [...process.execArgv, new URL(import.meta.url).pathname, 'participant', p.name, p.repo, restarts.join(','), String(count), String(minutes)],
        { env: { ...env, GIT_TERMINAL_PROMPT: '0', SOAK_DIR: DIR, SOAK_SERVER: HTTP, ...(process.env.SOAK_COMPACT_MIN_DELETED ? { ROOM_COMPACT_MIN_DELETED: process.env.SOAK_COMPACT_MIN_DELETED } : {}), ...(process.env.SOAK_BUS_KEEP ? { ROOM_BUS_KEEP: process.env.SOAK_BUS_KEEP } : {}) }, stdio: ['ignore', out, out] })
      fs.closeSync(out)
      child.on('exit', (code, signal) => emit({ ev: 'child-exit', name: p.name, code, signal }))
      children.set(p.name, child)
      await pause(jitter(1_000, 4_000))
    }
    if (DAEMON) {
      for (let i = 0; !discovery(); i++) {
        abort.signal.throwIfAborted()
        if (i >= 60) throw new Error('daemon discovery did not appear within 60 seconds; inspect participant logs')
        await pause(1000)
      }
    }
    observers.push(...await Promise.all(roomsForTarget().map(room => observer(room, sessions['soak-observer'], emitter(path.join(EVENTS, 'observer.jsonl'))))))
    const obsTimer = setInterval(() => observers.forEach(o => o.sample()), Math.min(30_000, SAMPLE_MIN * 60_000))
    const healthTimer = setInterval(async () => {
      const t = Date.now()
      try { const r = await fetch(`${healthURL()}/health`, { signal: AbortSignal.timeout(8_000) }); emit({ ev: 'health', status: r.status, ms: Date.now() - t }) }
      catch (e) { emit({ ev: 'health', status: 0, ms: Date.now() - t, error: String(e).slice(0, 120) }) }
    }, 10_000)
    const logFile = path.join(DIR, 'fly-logs.txt')
    // One `flyctl logs --no-tail` returns only the last ~100 lines, so poll every minute and report per sample.
    let pending = { lines: 0, errors: [] as string[] }
    const pollLogs = async () => { const l = await logsSince(logFile, t0); pending = { lines: pending.lines + l.lines, errors: [...pending.errors, ...l.errors] } }
    const logTimer = setInterval(() => void pollLogs(), 60_000)
    timers.push(obsTimer, healthTimer, logTimer)
    const pendingRestarts = APP || LOCAL || DAEMON ? restarts.filter(r => r > 0).sort((a, b) => a - b) : []
    // SOAK_RESTART_WHEN_DELETED=N: also restart once either room's observed deleted structs reach N, so restarts
    // compact at the server's real threshold whatever the rate. At most SOAK_RESTART_MAX (default 3) such
    // restarts, at least SOAK_RESTART_GAP_MIN (default 30) apart, none in the last 15 minutes.
    const whenDeleted = Number(process.env.SOAK_RESTART_WHEN_DELETED ?? 0)
    const restartMax = Number(process.env.SOAK_RESTART_MAX ?? 3), restartGap = Number(process.env.SOAK_RESTART_GAP_MIN ?? 30) * 60_000
    let lastRestart = t0, adaptive = 0
    const restartDue = () => {
      if (pendingRestarts.length && Date.now() >= t0 + pendingRestarts[0] * 60_000) { pendingRestarts.shift(); return 'scheduled' }
      if (!whenDeleted || adaptive >= restartMax || Date.now() - lastRestart < restartGap || Date.now() > t0 + (minutes - 15) * 60_000) return undefined
      observers.forEach(o => o.sample())
      const max = Math.max(...observers.map(o => o.history().deleted))
      if (max < whenDeleted) return undefined
      adaptive++
      return `deleted ${max} >= ${whenDeleted}`
    }
    for (let tick = 1; Date.now() - t0 < minutes * 60_000; tick++) {
      const next = t0 + tick * SAMPLE_MIN * 60_000
      while (Date.now() < Math.min(next, t0 + minutes * 60_000)) {
        abort.signal.throwIfAborted()
        const why = (APP || LOCAL || DAEMON) ? restartDue() : undefined
        if (why) {
          lastRestart = Date.now()
          observers.forEach(o => o.sample())
          emit({ ev: 'metrics', phase: 'before restart', ...await metricsNow() })
          const r0 = Date.now()
          emit({ ev: 'restart-begin', why })
          try {
            if (DAEMON) await signalDaemon()
            else if (LOCAL) { await stopLocalServer(); await startLocalServer() }
            else await run('flyctl', ['machine', 'restart', MACHINE, '-a', APP], { timeout: 300_000 })
            emit({ ev: 'restart-command-done', ms: Date.now() - r0 })
          }
          catch (e) { emit({ ev: 'restart-command-failed', error: String(e).slice(0, 300) }); throw e }
          let healthy = false
          while (Date.now() - r0 < 300_000) {
            abort.signal.throwIfAborted()
            try { if ((await fetch(`${healthURL()}/health`, { signal: AbortSignal.timeout(3_000) })).ok) { healthy = true; break } } catch { /* down */ }
            await pause(500)
          }
          if (!healthy) throw new Error('restart did not become healthy within 5 minutes')
          emit({ ev: 'restart-healthy', ms: Date.now() - r0 })
          emit({ ev: 'metrics', phase: 'after restart', ...await metricsNow() })
        }
        await pause(5_000)
      }
      observers.forEach(o => o.sample())
      if (DAEMON) copySnapshots(`min-${String(Math.round((Date.now() - t0) / 60_000)).padStart(3, '0')}`)
      const m = await metricsNow()
      await sampleGrowth(children)
      await pollLogs()
      const logs = pending; pending = { lines: 0, errors: [] }
      emit({ ev: 'metrics', phase: 'soak', minute: Math.round((Date.now() - t0) / 60_000), ...m, logLines: logs.lines, errors: logs.errors })
    }
    for (const name of children.keys()) if (!readEvents(path.join(EVENTS, `${name}.jsonl`)).some(e => e.ev === 'joined')) throw new Error(`${name} never joined`)
    emit({ ev: 'stopping-children' })
    for (const c of children.values()) c.kill('SIGTERM')
    await Promise.race([Promise.all([...children.values()].map(c => new Promise(r => c.exitCode !== null ? r(null) : c.once('exit', r)))), sleep(60_000)])
    for (const c of children.values()) if (c.exitCode === null) c.kill('SIGKILL')
    await pause(60_000) // leases released or expired
    observers.forEach(o => o.sample())
    clearInterval(obsTimer); clearInterval(healthTimer); clearInterval(logTimer)
    // Idle after the soak: does the server's RSS come back down with the participants gone?
    for (let i = 0; i < postIdle; i++) { emit({ ev: 'metrics', phase: 'post-soak idle', ...await metricsNow() }); await pause(120_000) }
    const logs = await logsSince(logFile, t0)
    emit({ ev: 'metrics', phase: 'final', logLines: logs.lines, errors: logs.errors })
    observers.forEach(o => o.stop())
    if (LOCAL) await stopLocalServer()
    emit({ ev: 'end' })
  } catch (e) { emit({ ev: 'failure', error: String(e) }); console.error(e); process.exitCode = 2 }
  finally {
    for (const timer of timers) clearInterval(timer)
    observers.forEach(o => o.stop())
    for (const c of children.values()) if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM')
    await Promise.all([...children.values()].map(c => new Promise<void>(resolve => {
      if (c.exitCode !== null || c.signalCode !== null) return resolve()
      const timer = setTimeout(() => c.kill('SIGKILL'), 15000)
      c.once('exit', () => { clearTimeout(timer); resolve() })
    })))
    try {
      if (LOCAL) await stopLocalServer()
      if (DAEMON && ownWork) await cleanupDaemon()
      if (ownWork && process.env.SOAK_KEEP_WORK !== '1') fs.rmSync(WORK, { recursive: true, force: true })
    } catch (e) { emit({ ev: 'failure', error: `cleanup: ${e}` }); console.error(e); process.exitCode = 2 }
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
  }
  report()
}

/** Sync each room read-only and count its Yjs structs: history (tombstones included) grows with every operation. */
async function structs(): Promise<void> {
  const { authorizedWebSocket } = await import('../packages/roomd/src/ws-auth.js')
  const { session } = JSON.parse(fs.readFileSync(path.join(CREDS, 'soak-observer.json'), 'utf8'))
  const emit = emitter(path.join(EVENTS, 'structs.jsonl'))
  for (const room of roomsForTarget()) {
    const doc = new Y.Doc()
    const { roomConnection } = await import('@room/shared')
    const p = new WebsocketProvider(WS, encodeURIComponent(room), doc, { WebSocketPolyfill: authorizedWebSocket({ session }) as any, ...roomConnection(doc) })
    p.awareness.setLocalState(null)
    await new Promise<void>(r => p.once('sync', () => r()))
    await sleep(3_000)
    let count = 0, items = 0, deleted = 0
    for (const list of (doc.store as any).clients.values()) for (const st of list) { count++; if (st.constructor.name === 'Item') { items++; if (st.deleted) deleted++ } }
    // A Y.Map's _map keeps one entry per key ever set, deleted ones included.
    const keys = Object.fromEntries([...doc.share].map(([k, v]) => [k, (v as any)._map?.size ?? (v as any)._length ?? 0]))
    // Structs per root (seen:<P> and chat:<P> grouped): which writers the history comes from.
    const rootName = new Map<unknown, string>([...doc.share].map(([k, v]) => [v, k.startsWith('seen:') ? 'seen:*' : k.startsWith('chat:') ? 'chat:*' : k]))
    const byRoot: Record<string, number> = {}
    for (const list of (doc.store as any).clients.values()) for (const st of list) {
      let parent = st.parent
      while (parent?._item) parent = parent._item.parent
      const name = rootName.get(parent) ?? (st.constructor.name === 'GC' ? '(gc)' : '?')
      byRoot[name] = (byRoot[name] ?? 0) + 1
    }
    const row = { room, clients: (doc.store as any).clients.size, structs: count, items, deleted, encodedKB: Math.round(Y.encodeStateAsUpdate(doc).length / 1024), keys, byRoot }
    emit(row); console.log(JSON.stringify(row))
    p.destroy(); doc.destroy()
  }
}

// ---------------------------------------------------------------- report

function report(): void {
  const orch = readEvents(path.join(EVENTS, 'orchestrator.jsonl')), obs = readEvents(path.join(EVENTS, 'observer.jsonl'))
  const people = Object.fromEntries(ROSTER.map(p => [p.name, readEvents(path.join(EVENTS, `${p.name}.jsonl`))]))
  const start = orch.find(e => e.ev === 'start'), t0 = start?.t ?? 0
  const daemon = start?.target === 'daemon'
  const REPOS = { alpha: daemon ? 'local/daemon-src' : 'github.com/soak/alpha', beta: daemon ? 'local/daemon-src' : 'github.com/soak/beta' }
  const roomsForTarget = () => [...new Set(Object.values(REPOS))]
  const min = (t: number) => Math.round((t - t0) / 60_000)
  // Every planned restart: when the command began and when /health answered again.
  const restarts = orch.filter(e => e.ev === 'restart-begin').map(b => ({ begin: b, healthy: orch.find(e => e.ev === 'restart-healthy' && e.t >= b.t) }))
    .filter((r): r is { begin: any; healthy: any } => !!r.healthy)
  // A daemon's planned compaction restart is a restart window too: the observer is replaced (close 4409), or, when the
  // observer rejoined through a discovery-nonce refresh instead and saw no 4409, most of the roster goes stale together.
  const staleTimes = Object.values(people).flatMap(evs => evs.filter(e => e.ev === 'stale').map(e => e.t as number)).sort((a, b) => a - b)
  const rosterStale = staleTimes.filter(t => staleTimes.filter(x => Math.abs(x - t) <= 5_000).length >= Math.max(2, Math.ceil(ROSTER.length / 2)))
  const compactions = [...obs.filter(e => e.ev === 'observer-replaced').map(e => e.t as number), ...rosterStale]
  const inRestart = (t: number, afterMs = 15_000) => restarts.some(r => t >= r.begin.t - 5_000 && t <= r.healthy.t + afterMs)
    || compactions.some(c => t >= c - 60_000 && t <= c + 60_000)
  const out: string[] = []
  const rows: { m: any; cpu?: number; steal?: number; bus?: number; live?: number }[] = []

  // Metrics table, every 10 minutes.
  const metrics = orch.filter(e => e.ev === 'metrics' && e.rssKb)
  const rooms = obs.filter(e => e.ev === 'room')
  const errorsAll: string[] = []
  out.push('| min | phase | server RSS MB | HWM MB | CPU % | steal % | /data KB | alpha doc KB | beta doc KB | alpha structs (deleted) | beta structs (deleted) | live leases | present | bus | mail | log lines | error lines |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  let prev: any
  for (const m of metrics) {
    // A restarted machine can reuse the pid; its uptime going down marks a new process.
    const same = prev && prev.pid === m.pid && !(m.uptimeS < prev.uptimeS)
    const cpu = same && prev.cpuTicks !== undefined ? (100 * (m.cpuTicks - prev.cpuTicks) / 100 / ((m.t - prev.t) / 1000)).toFixed(1) : '-'
    const steal = same && prev.totalTicks !== undefined && m.totalTicks > prev.totalTicks ? (100 * (m.stealTicks - prev.stealTicks) / (m.totalTicks - prev.totalTicks)).toFixed(1) : '-'
    // The room as sampled just before this metric (observers sample first at each tick).
    const near = (room: string) => rooms.filter(r => r.room === room && r.t <= m.t + 5_000 && m.t - r.t < 120_000).at(-1)
    const history = (r: any) => r?.structs !== undefined ? `${r.structs} (${r.deleted})` : '-'
    const a = near(REPOS.alpha), b = daemon ? undefined : near(REPOS.beta)
    const errs = (m.errors ?? []) as string[]
    errorsAll.push(...errs)
    rows.push({ m, cpu: cpu === '-' ? undefined : Number(cpu), steal: steal === '-' ? undefined : Number(steal), bus: a && b ? a.bus + b.bus : undefined, live: a && b ? a.live + b.live : undefined })
    out.push(`| ${m.t >= t0 ? min(m.t) : 'pre'} | ${m.phase} | ${(m.rssKb / 1024).toFixed(1)} | ${(m.hwmKb / 1024).toFixed(1)} | ${cpu} | ${steal} | ${m.dataKb ?? '-'} | ${a ? (a.docBytes / 1024).toFixed(0) : '-'} | ${b ? (b.docBytes / 1024).toFixed(0) : '-'} | ${history(a)} | ${history(b)} | ${a && b ? a.live + b.live : '-'} | ${a && b ? a.present.length + b.present.length : '-'} | ${a && b ? a.bus + b.bus : '-'} | ${a && b ? a.mail + b.mail : '-'} | ${m.logLines ?? '-'} | ${errs.length} |`)
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
  // Least-squares line over the soak samples after the first hour, leaving out the 10 minutes after each restart.
  const fit = (pts: [number, number][]) => {
    const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n
    const sxx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0), sxy = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0)
    return { slope: sxy / sxx, intercept: my - (sxy / sxx) * mx, n }
  }
  const fitFrom = Number(process.env.SOAK_FIT_FROM_MIN ?? 60) * 60_000
  const settled = rows.filter(r => r.m.phase === 'soak' && r.m.t - t0 >= fitFrom && !inRestart(r.m.t, 10 * 60_000))
  const rssFit = settled.length > 2 ? fit(settled.map(r => [(r.m.t - t0) / 3_600_000, r.m.rssKb / 1024])) : undefined
  const cpuPts = settled.filter(r => r.cpu !== undefined)
  const cpuFit = cpuPts.length > 2 ? fit(cpuPts.map(r => [(r.m.t - t0) / 3_600_000, r.cpu!])) : undefined
  const maxRss = Math.max(0, ...metrics.map(m => m.rssKb)) / 1024, maxHwm = Math.max(0, ...metrics.map(m => m.hwmKb)) / 1024
  const slopePass = !!rssFit && rssFit.slope < 2 && maxRss < 300
  const cpuFlat = !!cpuFit && Math.abs(cpuFit.slope) < 0.1

  // Delivery: every accepted addressed message is committed at its recipient at least once.
  const sent = Object.values(people).flat().filter(e => e.ev === 'sent' && e.to)
  const unsent = Object.values(people).flat().filter(e => e.ev === 'unsent')
  const deliveries = new Map<string, number>()
  for (const [n, evs] of Object.entries(people)) for (const e of evs) if (e.ev === 'delivered' && e.to === n) deliveries.set(`${n}\0${e.id}`, (deliveries.get(`${n}\0${e.id}`) ?? 0) + 1)
  // Accepted but never delivered: still in the room (owed at the stop) when the observer saw it appended, lost otherwise.
  const onBus = new Set(obs.filter(e => e.ev === 'bus').map(e => e.id))
  // The lost/owed split needs an observer that synced: a blind observer (it never connected) would call every
  // owed message lost. The run reported one such "lost" message on 2026-11-08 before the observer negotiated.
  const observerBlind = !rooms.some(e => e.synced)
  const undelivered = sent.filter(e => !deliveries.get(`${e.to}\0${e.id}`))
  const lost = observerBlind ? [] : undelivered.filter(e => !onBus.has(e.id))
  const owedAtStop = observerBlind ? [] : undelivered.filter(e => onBus.has(e.id))
  const dupsAll = [...deliveries.entries()].filter(([, c]) => c > 1)
  // At-least-once by design: the first delivery's receipt (seen:<P>) was written to a replica that was offline
  // then and was discarded by a leave before it reconnected, so the rejoined session was owed the message again.
  const lostReceipt = ([k]: [string, number]) => {
    const [n, id] = k.split('\0'), evs = people[n] ?? []
    const ds = evs.filter(e => e.ev === 'delivered' && e.id === id)
    // A replica refused after a compacting restart is discarded as a leave discards it.
    const leave = evs.find(e => (e.ev === 'leave' || e.ev === 'stale') && e.t > ds[0].t && e.t < ds[1].t)
    const offline = evs.filter(e => e.ev === 'status' && e.t <= ds[0].t + 5_000).at(-1)
    const resynced = evs.some(e => e.ev === 'status' && e.conn && e.synced && e.t > ds[0].t && leave && e.t < leave.t)
    return !!leave && (!offline?.conn || evs.some(e => e.ev === 'status' && !e.conn && Math.abs(e.t - ds[0].t) <= 5_000)) && !resynced
  }
  const dupsExplained = dupsAll.filter(lostReceipt), dups = dupsAll.filter(d => !lostReceipt(d))
  const resent = Object.values(people).flat().filter(e => e.ev === 'resent')
  const resentBad = resent.filter(e => !e.duplicate)
  const sentDup = sent.filter(e => e.duplicate)

  // Seqs: one id per seq, one seq per id, per room; epochs never repeat and rise per name.
  const seqProblems: string[] = []
  for (const room of roomsForTarget()) {
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
  const counterRows = restarts.map(r => {
    const preMaxSeq = Math.max(0, ...obs.filter(e => e.ev === 'bus' && e.t < r.begin.t).map(e => e.seq))
    const after = obs.filter(e => e.ev === 'bus' && e.t > r.healthy.t + 5_000 && incOf(e.seq) > incOf(preMaxSeq)).map(e => e.seq)
    const below = sent.filter(e => e.t > r.healthy.t + 5_000 && !e.duplicate && e.seq !== undefined && e.seq <= preMaxSeq)
    return { preMaxSeq, postMinSeq: after.length ? Math.min(...after) : NaN, below }
  })
  const postRestartBelow = counterRows.flatMap(c => c.below)
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
  const nameDrift = Object.entries(people).flatMap(([n, evs]) => evs.filter(e => (e.ev === 'joined' || e.ev === 'status' || e.ev === 'replaced') && e.name && e.name !== n).map(e => `${n} ran as ${e.name} at min ${min(e.t)}`))
  // Replicas refused after a compacting restart, and their replacements under the same name.
  const replacements = Object.entries(people).flatMap(([n, evs]) => evs.filter(e => e.ev === 'stale').map(e => ({ n, t: e.t, r: evs.find(x => x.ev === 'replaced' && x.t > e.t) })))
  const rejoins = Object.entries(people).map(([n, evs]) => ({ n, r: evs.find(e => e.ev === 'rejoined') }))
  const endChecks: string[] = []
  const lastRooms = rooms.filter(r => r.t > (orch.find(e => e.ev === 'stopping-children')?.t ?? Infinity) + 50_000)
  for (const r of lastRooms.slice(-2)) for (const h of r.holders) if (!h.ended && ROSTER.some(p => p.name === h.name)) endChecks.push(`${h.name} still live ${Math.round((r.t - (orch.find(e => e.ev === 'stopping-children')?.t ?? 0)) / 1000)} s after stop`)
  // The window in which /health failed outside the planned restart (CPU throttling on staging).
  const healthAll = orch.filter(e => e.ev === 'health')
  const outsideRestart = (t: number) => !inRestart(t)
  // Only clustered failures (3 or more within 5 minutes) make a stall window; isolated probe timeouts do not.
  const fails = healthAll.filter(e => e.status !== 200 && outsideRestart(e.t))
  const stallFails = fails.filter(e => fails.filter(f => Math.abs(f.t - e.t) <= 5 * 60_000).length >= 3)
  const stallFrom = stallFails.length ? stallFails[0].t - 5 * 60_000 : Infinity, stallTo = stallFails.at(-1)?.t ?? -Infinity
  const inStall = (t: number) => t >= stallFrom && t <= stallTo + 60_000
  // Leases of disconnected participants: disconnects longer than TTL + 15 s must show a new epoch after.
  const disc = Object.entries(people).flatMap(([n, evs]) => evs.filter(e => e.ev === 'disconnect').map(e => {
    // Back: the first unpaused status after reconnecting; kept: the epoch still held 60 s later (a lease can lapse after reconnecting).
    const back = evs.find(x => x.ev === 'status' && x.t > e.t + e.ms && x.hub && !x.paused && typeof x.epoch === 'number')
    const settledAt = evs.filter(x => x.ev === 'status' && x.t > e.t + e.ms && x.t <= e.t + e.ms + 60_000 && x.hub && !x.paused && typeof x.epoch === 'number').at(-1)
    return { n, t: e.t, ms: e.ms, before: e.epoch, after: settledAt?.epoch ?? back?.epoch, backMs: back ? back.t - e.t - e.ms : undefined }
  }))

  // Hub-side expiry of a disconnected holder: `hub: lease <epoch> on <name> expired`, measured from the disconnect.
  const expiries = flyLines.map(l => /^(\S+).*hub: lease (\d+) on (\S+) expired/.exec(l)).filter(Boolean)
    .map(m => ({ t: Date.parse(m![1]), epoch: Number(m![2]), name: m![3] }))
  const expiryRows = expiries.map(x => {
    const d = (people[x.name] ?? []).filter(e => e.ev === 'disconnect' && e.epoch === x.epoch && e.t <= x.t + 1_000).at(-1)
    return { ...x, afterDisconnectS: d ? (x.t - d.t) / 1000 : undefined }
  })
  const lateExpiry = expiryRows.filter(x => x.afterDisconnectS !== undefined && x.afterDisconnectS > 47)
  // A connected client losing its lease: a pause that begins while its socket and hub are up, outside a leave.
  const connectedLoss = Object.entries(people).flatMap(([n, evs]) => {
    const stop = evs.find(e => e.ev === 'stopping')?.t ?? Infinity
    const away = [...evs.filter(e => e.ev === 'leave').map(l => [l.t, evs.find(e => e.ev === 'rejoined' && e.t > l.t)?.t ?? Infinity]),
      ...evs.filter(e => e.ev === 'stale').map(l => [l.t, evs.find(e => e.ev === 'replaced' && e.t > l.t)?.t ?? Infinity])]
    const statuses = evs.filter(e => e.ev === 'status' && e.t < stop)
    return statuses.filter((e, i) => e.paused && !statuses[i - 1]?.paused && e.conn && e.hub && !away.some(([a, b]) => e.t >= a && e.t <= b + 5_000))
      .map(e => {
        const d = evs.filter(x => x.ev === 'disconnect' && x.t < e.t).at(-1), r = evs.filter(x => x.ev === 'reconnect-requested' && x.t < e.t).at(-1)
        // TTL edge: found right after reconnecting from a disconnect of 30 s or more. The lease's age is that
        // disconnect plus up to one renew interval (15 s), so it had usually run out while the client was away.
        const edge = !!d && !!r && r.t > d.t && e.t - r.t <= 5_000 && e.t - d.t >= 30_000
        return { n, t: e.t, edge, sinceDisconnectS: d ? Math.round((e.t - d.t) / 1000) : undefined, sinceReconnectS: r ? Math.round((e.t - r.t) / 1000) : undefined }
      })
  })
  const connectedTrue = connectedLoss.filter(c => !c.edge)
  // Hub expiries that no disconnect, leave or stop explains: a connected client's lease ran out.
  const unexplained = expiryRows.filter(x => x.afterDisconnectS === undefined)
  // A graceful leave ends the hub record (released) before the next observer sample.
  const leaveEnds = Object.entries(people).flatMap(([n, evs]) => evs.filter(e => e.ev === 'leave').map(e => {
    // A leave while disconnected cannot release: its lease must end by TTL instead (45 s, plus one 30 s sample).
    const offline = evs.filter(x => x.ev === 'status' && x.t <= e.t).at(-1)?.conn === false
    const sample = rooms.find(r => r.t > e.t + (offline ? 75_000 : 5_000) && r.holders.some((h: any) => h.name === n))
    const h = sample?.holders.find((h: any) => h.name === n)
    return { n, t: e.t, offline, ended: h?.ended ?? (h && h.epoch !== e.epoch ? 'rejoined' : null), epoch: h?.epoch, left: e.epoch }
  }))
  // Each restart: per participant, time from /health 200 until hub reachable again with a lease (status events).
  const restartSections = restarts.map(({ begin: restartBegin, healthy: restartHealthy }) => {
    const restartRows: string[] = []
    let maxBack = 0, sameEpoch = 0, sameName = 0
    for (const [n, evs] of Object.entries(people)) {
      // The incarnation comes from the room's hub mirror (meta.hubIncarnation): rc5's client no longer exposes it.
      const room = REPOS[ROSTER.find(p => p.name === n)!.repo]
      const incBefore = rooms.filter(r => r.room === room && r.t < restartBegin.t).at(-1)?.hubIncarnation
      const incAfter = rooms.find(r => r.room === room && r.t > restartHealthy.t && r.hubIncarnation !== incBefore)?.hubIncarnation
      const pre = { ...evs.filter(e => e.ev === 'status' && e.t < restartBegin.t).at(-1), inc: incBefore }
      const down = evs.find(e => e.ev === 'status' && e.t >= restartBegin.t && e.t < restartBegin.t + 60_000 && !e.hub)
      const backEv = evs.find(e => e.ev === 'status' && e.t >= (down?.t ?? restartBegin.t) && (down ? true : e.inc !== undefined && e.inc !== pre.inc) && e.hub && e.conn && typeof e.epoch === 'number' && !e.paused)
      const back = backEv ? { ...backEv, inc: backEv.inc ?? incAfter } : undefined
      const ms = back ? back.t - restartHealthy.t : undefined
      if (ms !== undefined) maxBack = Math.max(maxBack, ms)
      if (back && back.epoch === pre?.epoch) sameEpoch++
      if (back && back.name === n) sameName++
      restartRows.push(`| ${n} | ${pre?.epoch ?? '-'} (inc ${pre?.inc ?? '-'}) | ${back?.epoch ?? '-'} (inc ${back?.inc ?? '-'}) | ${back?.name ?? '-'} | ${down ? `${((down.t - restartBegin.t) / 1000).toFixed(0)} s` : 'already disconnected (planned)'} | ${ms !== undefined ? `${(ms / 1000).toFixed(1)} s` : '-'} |`)
    }
    return { restartBegin, restartHealthy, restartRows, maxBack, sameEpoch, sameName }
  })

  // Health.
  const health = orch.filter(e => e.ev === 'health')
  const badHealth = health.filter(e => e.status !== 200 && !inRestart(e.t, 60_000))

  const counts = (ev: string) => Object.values(people).flat().filter(e => e.ev === ev).length
  const pf = (b: boolean) => b ? '**PASS**' : '**FAIL**'
  const md: string[] = []
  md.push(`## Metrics every 10 minutes`, '', ...out, '')
  md.push(`Activity: ${counts('sent')} posts accepted (${sent.length} addressed, ${sentDup.length} answered as duplicates on a retry), ${unsent.length} given up after 5 min, ${counts('delivered')} ledger deliveries, ${Object.values(people).flat().filter(e => e.ev === 'claim' && e.ok).length} claims taken (${counts('claim')} attempted), ${Object.values(people).flat().filter(e => e.ev === 'release' && String(e.out).startsWith('released')).length} releases, ${counts('big-edit')} large edits, ${counts('disconnect')} disconnects, ${rejoins.filter(r => r.r).length} leave-and-rejoins, ${resent.length} same-id resends.`, '')
  restartSections.forEach(({ restartBegin, restartHealthy, restartRows, maxBack, sameEpoch, sameName }, i) => {
    const c = counterRows[i]
    md.push(`## Hub restart ${i + 1} at minute ${min(restartBegin.t)}`, '', `Machine restart command to /health 200: ${((restartHealthy.t - restartBegin.t) / 1000).toFixed(1)} s. Slowest participant back (hub hello + valid lease) after health returned: ${(maxBack / 1000).toFixed(1)} s. Same name ${sameName}/${restartRows.length}, same epoch ${sameEpoch}/${restartRows.length}.`, '',
      '| participant | epoch before (incarnation) | epoch after (incarnation) | name after | first drop seen | back after /health 200 |', '|---|---|---|---|---|---|', ...restartRows, '',
      `Highest seq before the restart: ${c.preMaxSeq} (incarnation ${incOf(c.preMaxSeq)}); new posts after it at or below that: ${c.below.length}. Lowest post-restart seq in a new incarnation: ${Number.isFinite(c.postMinSeq) ? `${c.postMinSeq} (incarnation ${incOf(c.postMinSeq)})` : '-'}.`, '')
  })
  // Compaction at each restart: each room's history and the server's RSS just before, and after it.
  if (restarts.length && rooms.some(r => r.structs !== undefined)) {
    md.push('## Document history and memory around each restart', '', '| restart | room | structs (deleted) before | generation before | structs (deleted) after | generation after | RSS MB before | RSS MB after restart | RSS MB next sample |', '|---|---|---|---|---|---|---|---|---|')
    restarts.forEach((r, i) => {
      const rssBefore = metrics.filter(m => m.t <= r.begin.t).at(-1), rssAfter = metrics.find(m => m.t >= r.healthy.t && m.phase === 'after restart'), rssNext = metrics.find(m => m.t > r.healthy.t + 60_000 && m.phase === 'soak')
      for (const room of roomsForTarget()) {
        const before = rooms.filter(x => x.room === room && x.t <= r.begin.t && x.structs !== undefined).at(-1)
        const after = rooms.find(x => x.room === room && x.t > r.healthy.t + 20_000 && x.synced && x.structs !== undefined)
        md.push(`| ${i + 1} (min ${min(r.begin.t)}) | ${room} | ${before ? `${before.structs} (${before.deleted})` : '-'} | ${before?.generation ?? '-'} | ${after ? `${after.structs} (${after.deleted})` : '-'} | ${after?.generation ?? '-'} | ${rssBefore ? (rssBefore.rssKb / 1024).toFixed(1) : '-'} | ${rssAfter ? (rssAfter.rssKb / 1024).toFixed(1) : '-'} | ${rssNext ? (rssNext.rssKb / 1024).toFixed(1) : '-'} |`)
      }
    })
    md.push('', `Replicas refused after a compacting restart: ${replacements.length}; replaced under the same name ${replacements.filter(x => x.r?.sameName).length}/${replacements.length}; slowest replacement ${(Math.max(0, ...replacements.map(x => x.r?.ms ?? 0)) / 1000).toFixed(1)} s.`, '')
  }
  // Hourly summary of the 10-minute samples (soak phase), with health failures and error lines per hour.
  const hours = Math.ceil(Math.max(0, ...rows.filter(r => r.m.phase === 'soak').map(r => r.m.t - t0)) / 3_600_000)
  if (hours >= 2) {
    const mean = (xs: (number | undefined)[]) => { const v = xs.filter((x): x is number => x !== undefined); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : '-' }
    md.push('## Hourly summary', '', '| hour | RSS MB avg | RSS MB max | HWM MB | CPU % avg | steal % avg | /data KB (end) | bus (end) | live leases (end) | health fails | restarts |', '|---|---|---|---|---|---|---|---|---|---|---|')
    for (let h = 0; h < hours; h++) {
      const inH = (t: number) => t - t0 > h * 3_600_000 && t - t0 <= (h + 1) * 3_600_000
      const hr = rows.filter(r => r.m.phase === 'soak' && inH(r.m.t))
      if (!hr.length) continue
      const last = hr.at(-1)!
      md.push(`| ${h + 1} | ${mean(hr.map(r => r.m.rssKb / 1024))} | ${(Math.max(...hr.map(r => r.m.rssKb)) / 1024).toFixed(1)} | ${(last.m.hwmKb / 1024).toFixed(1)} | ${mean(hr.map(r => r.cpu))} | ${mean(hr.map(r => r.steal))} | ${last.m.dataKb ?? '-'} | ${last.bus ?? '-'} | ${last.live ?? '-'} | ${health.filter(e => e.status !== 200 && inH(e.t)).length} | ${restarts.filter(r => inH(r.begin.t)).length || ''} |`)
    }
    md.push('')
  }
  md.push('## Pass criteria', '')
  md.push(`- Memory: first-hour average ${memFirst.toFixed(1)} MB, last-hour average ${memLast.toFixed(1)} MB. Line fit over ${rssFit?.n ?? 0} samples from hour 1 on (10 min after each restart left out): ${rssFit ? `${rssFit.slope.toFixed(2)} MB/hour, intercept ${rssFit.intercept.toFixed(1)} MB` : '-'}; maximum RSS ${maxRss.toFixed(1)} MB, HWM ${maxHwm.toFixed(1)} MB (pass: slope < 2 MB/hour and RSS < 300 MB). ${pf(slopePass)}`)
  md.push(`- CPU: line fit ${cpuFit ? `${cpuFit.slope.toFixed(3)} percentage points of a core per hour over ${cpuFit.n} samples` : '-'} (flat: |slope| < 0.1). ${pf(cpuFlat)}`)
  md.push(`- Leases: name drift ${nameDrift.length ? nameDrift.join('; ') : 'none'}; rejoins under the same name ${rejoins.filter(r => r.r?.sameName).length}/${rejoins.filter(r => r.r).length}; replacements under the same name ${replacements.filter(x => x.r?.sameName).length}/${replacements.length}; leases still live 50+ s after stop: ${endChecks.length ? endChecks.join('; ') : 'none'}. Disconnects: ${disc.length}; shorter than 30 s (inside the 45 s TTL even 15 s after a renew) kept their epoch ${disc.filter(d => d.ms < 30_000 && d.after === d.before).length}/${disc.filter(d => d.ms < 30_000).length}, or ${disc.filter(d => d.ms < 30_000 && d.after === d.before && !inStall(d.t)).length}/${disc.filter(d => d.ms < 30_000 && !inStall(d.t)).length} outside the CPU-throttled window; past it (over 50 s) re-acquired a new, higher epoch ${disc.filter(d => d.ms > 50_000 && d.after !== undefined && d.after > d.before).length}/${disc.filter(d => d.ms > 50_000).length}; slowest back to an unpaused lease after reconnecting ${(Math.max(0, ...disc.filter(d => !inStall(d.t)).map(d => d.backMs ?? 0)) / 1000).toFixed(1)} s outside that window, ${(Math.max(0, ...disc.filter(d => inStall(d.t)).map(d => d.backMs ?? 0)) / 1000).toFixed(1)} s inside it. Hub expiries of disconnected holders: ${expiryRows.length}, seconds after the disconnect began ${expiryRows.map(x => x.afterDisconnectS?.toFixed(0) ?? '?').join(', ') || '-'} (TTL 45 s from the last renew); later than 47 s: ${lateExpiry.length} (${lateExpiry.filter(x => inStall(x.t)).length} of them in the CPU-throttled window). Leaves ended on the hub by the next sample (released, or already replaced by the rejoin; a leave while disconnected by TTL expiry): ${leaveEnds.filter(l => l.ended).length}/${leaveEnds.length}${leaveEnds.some(l => l.offline) ? ` (${leaveEnds.filter(l => l.offline).map(l => `${l.n} left while disconnected: ${l.ended}`).join('; ')})` : ''}${leaveEnds.some(l => !l.ended) ? ` (not yet: ${leaveEnds.filter(l => !l.ended).map(l => `${l.n} at min ${min(l.t)}${inStall(l.t) ? ', throttled window' : ''}`).join('; ')})` : ''}. Connected clients that lost their lease: ${connectedTrue.length}${connectedTrue.length ? ` (${connectedTrue.slice(0, 12).map(c => `${c.n} at min ${min(c.t)}, ${c.sinceReconnectS ?? '-'} s after reconnecting, ${c.sinceDisconnectS ?? '-'} s after its last disconnect`).join('; ')})` : ''}; leases found expired right after a 30 s+ disconnect (TTL edge, expected): ${connectedLoss.length - connectedTrue.length}; hub expiries with no disconnect to explain them: ${unexplained.length}${unexplained.length ? ` (${unexplained.slice(0, 10).map(x => `${x.name} at min ${min(x.t)}`).join(', ')})` : ''}. ${pf(!nameDrift.length && !endChecks.length && !connectedTrue.length && rejoins.every(r => !r.r || r.r.sameName) && replacements.every(x => x.r?.sameName) && leaveEnds.every(l => l.ended))}`)
  if (observerBlind) md.push(`- Delivery: FAIL the observer never synced with the room, so ${undelivered.length} undelivered message${undelivered.length === 1 ? '' : 's'} cannot be classified as lost or owed`)
  else md.push(`- Delivery: ${sent.length} addressed messages accepted; lost (accepted, never in the room, never delivered) ${lost.length}; still owed at the stop (in the room, recipient offline or stalled) ${owedAtStop.length}; duplicate deliveries ${dupsAll.length} (${dupsExplained.length} at-least-once: the receipt was written offline and its replica discarded by a leave or a compacting restart before reconnecting${dupsExplained.length ? `: ${dupsExplained.map(([k]) => k.replace('\0', ':')).join(', ')}` : ''}); same-id resends answered with the original (duplicate) ${resent.length - resentBad.length}/${resent.length}. ${pf(lost.length === 0 && dups.length === 0 && resentBad.length === 0)}${lost.length ? `\n  - lost: ${lost.slice(0, 10).map(e => `${e.id}→${e.to} (min ${min(e.t)})`).join(', ')}` : ''}${owedAtStop.length ? `\n  - owed at the stop: ${owedAtStop.slice(0, 10).map(e => `${e.id}→${e.to} (min ${min(e.t)})`).join(', ')}` : ''}${dups.length ? `\n  - duplicates: ${dups.slice(0, 10).map(([k, c]) => `${k.replace('\0', ':')}×${c}`).join(', ')}` : ''}`)
  md.push(`- Monotonic counters: seq problems ${seqProblems.length}, epoch problems ${epochProblems.length}, post-restart values at or below pre-restart ${postRestartBelow.length}. ${pf(!seqProblems.length && !epochProblems.length && !postRestartBelow.length)}${[...seqProblems, ...epochProblems].slice(0, 10).map(p => `\n  - ${p}`).join('')}`)
  md.push(`- Health: ${health.length} probes, ${badHealth.length} non-200 outside the restart windows (restart command to 60 s after /health 200)${badHealth.length ? ` at minutes ${badHealth.length > 8 ? `${min(badHealth[0].t)}–${min(badHealth.at(-1)!.t)}` : badHealth.map(h => min(h.t)).join(', ')}` : ''}; clustered (3+ within 5 min) ${stallFails.length}. ${pf(!badHealth.length)}`)
  md.push(`- Fly log lines since the start: ${flyLines.length}; matching error words: ${flyErrors.length}.${flyErrors.slice(0, 15).map(l => `\n  - \`${l.slice(0, 220).replace(/`/g, "'")}\``).join('')}`)
  md.push(`  - known info lines: ${[...kinds].map(([k, c]) => `${c} × ${k}`).join('; ') || 'none'}`)
  md.push(`  - other lines (${other.length}):${other.slice(0, 25).map(l => `\n    - \`${l.slice(0, 200).replace(/`/g, "'")}\``).join('')}`)
  const inv = orch.find(e => e.ev === 'inventory-probe')
  if (inv) md.push(`- Admin inventory probe: HTTP ${inv.status} (${String(inv.body).trim().slice(0, 80)}).`)
  md.push('', '## Growth trends', '', 'First/last thirds; OLS on the last two thirds (warm-up excluded). Both later means must rise. Threshold/hour: max(10% first mean, 1 MiB bytes, 2 counts, 10 ms latency, 1 CPU percentage point). At least 9 samples and 30 minutes required; PASS is not proof of boundedness.', '', '| Metric | first third | last third | slope/hour | threshold/hour | result |', '|---|---|---|---|---|---|')
  const samples: { t: number; metrics: Record<string, number> }[] = orch.filter(e => e.ev === 'growth-sample')
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length
  let growing = false
  for (const key of [...new Set(samples.flatMap(s => Object.keys(s.metrics)))].sort()) {
    const points = samples.filter(s => Number.isFinite(s.metrics[key]))
    const n = Math.floor(points.length / 3)
    if (!n) { md.push(`| ${key} | - | - | - | - | WARN insufficient samples |`); continue }
    const a = mean(points.slice(0, n).map(s => s.metrics[key]))
    const b = mean(points.slice(n, 2 * n).map(s => s.metrics[key]))
    const c = mean(points.slice(-n).map(s => s.metrics[key]))
    const tail = points.slice(n), xs = tail.map(s => (s.t - points[0].t) / 3600000)
    const ys = tail.map(s => s.metrics[key]), xm = mean(xs), ym = mean(ys)
    const variance = xs.reduce((v, x) => v + (x - xm) ** 2, 0)
    const slope = variance ? xs.reduce((v, x, i) => v + (x - xm) * (ys[i] - ym), 0) / variance : 0
    const floor = /Bytes/.test(key) ? 1048576 : /Ms/.test(key) ? 10 : /cpuPercent/.test(key) ? 1 : 2
    const threshold = Math.max(Math.abs(a) * .1, floor)
    const enough = points.length >= 9 && points.at(-1)!.t - points[0].t >= 30 * 60000
    const rises = enough && slope > threshold && b > a && c > b
    growing ||= rises
    md.push(`| ${key} | ${a.toFixed(2)} | ${c.toFixed(2)} | ${slope.toFixed(2)} | ${threshold.toFixed(2)} | ${rises ? 'WARN GROWING' : enough ? 'PASS' : 'WARN insufficient duration/samples'} |`)
  }
  if (!samples.length) md.push('WARN no active samples')
  if (growing) process.exitCode = Math.max(Number(process.exitCode ?? 0), 1)
  if (orch.some(e => e.ev === 'failure') || !orch.some(e => e.ev === 'end')) { md.push('WARN failed/incomplete run'); process.exitCode = 2 }
  fs.writeFileSync(path.join(DIR, 'report.md'), md.join('\n') + '\n')
  console.log(md.join('\n'))
}

// ---------------------------------------------------------------- main

const [mode, ...rest] = process.argv.slice(2)
const flag = (n: string, d: number) => { const i = rest.indexOf(n); return i >= 0 ? Number(rest[i + 1]) : d }
const restartList = (v: string | undefined) => (v ?? '').split(',').map(Number).filter(n => Number.isFinite(n) && n > 0)
if (mode === 'participant') await participant(rest[0], rest[1] as RepoKey, restartList(rest[2]), Number(rest[3] ?? ROSTER.length), Number(rest[4] ?? 180))
else if (mode === 'run') { const i = rest.indexOf('--restart-at'); await orchestrate(flag('--minutes', 180), i >= 0 ? restartList(rest[i + 1]) : [90], flag('--participants', 8), flag('--post-idle', 3)) }
else if (mode === 'metrics') console.log(JSON.stringify(await metricsNow()))
else if (mode === 'structs') { await structs(); process.exit(0) }
else if (mode === 'report') report()
else if (mode === 'cleanup') { fs.rmSync(CREDS, { recursive: true, force: true }); console.log(`removed ${CREDS}`) }
else { console.error('usage: npx tsx scripts/soak.mts run|report|cleanup [--minutes 180] [--restart-at 90] [--participants 8]'); process.exit(2) }
