// Shared helpers for the room hooks. No dependencies: hooks run from the plugin cache.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'

export function readStdinJson() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}') } catch { return {} }
}

/** Walk up from cwd to the directory containing .git (file or dir). */
export function gitRoot(start) {
  let d = path.resolve(String(start || process.env.PWD || process.cwd()).replace(/^file:\/\//, ''))
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d
    const up = path.dirname(d)
    if (up === d) return undefined
    d = up
  }
}

/** .git/<name> for a clone; works for worktrees where .git is a file. */
export function gitStatePath(root, name) {
  const dotgit = path.join(root, '.git')
  try {
    const st = fs.statSync(dotgit)
    if (st.isFile()) {
      const m = fs.readFileSync(dotgit, 'utf8').match(/gitdir:\s*(.+)/)
      if (m?.[1].trim()) return path.join(path.resolve(root, m[1].trim()), name)
    }
  } catch { /* fall through */ }
  return path.join(dotgit, name)
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

/** Newest real assistant model in a bounded JSONL transcript tail. */
export function newestModelInTranscriptTail(tail, startsMidLine = false) {
  const lines = tail.split('\n')
  if (startsMidLine) lines.shift()
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry
    try { entry = JSON.parse(lines[i]) } catch { continue }
    const model = typeof entry?.message?.model === 'string' ? entry.message.model.trim() : ''
    if (model && !model.startsWith('<')) return model
  }
}

/** The clone's common git directory (shared by its worktrees), without spawning git. */
export function gitCommonDir(root) {
  const own = path.dirname(gitStatePath(root, 'x'))
  try { return path.resolve(own, fs.readFileSync(path.join(own, 'commondir'), 'utf8').trim()) } catch { return own }
}

/** `<common>/room/sessions/<sid>/`, sid = sha256(host session id)[0:16] (room-mcp session.ts sessionDirectory). */
export function sessionDir(root, sessionId) {
  return path.join(gitCommonDir(root), 'room', 'sessions', createHash('sha256').update(sessionId).digest('hex').slice(0, 16))
}

/** Temp-and-rename, so a reader never sees half a file (ledger R5). */
export function writeJsonAtomic(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    fs.writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600 })
    fs.renameSync(temp, file)
  } catch { /* hooks are best effort */ }
}

/**
 * A connection to this session's MCP arbitration endpoint (mcp.json), or undefined when it cannot be
 * reached within `budgetMs`. `request` answers one JSON line, or undefined when the budget runs out.
 */
export async function openMcp(dir, budgetMs) {
  const endpoint = readJson(path.join(dir, 'mcp.json'), null)
  if (!Number.isInteger(endpoint?.port) || typeof endpoint?.key !== 'string') return undefined
  const deadline = Date.now() + budgetMs
  const socket = net.connect({ host: '127.0.0.1', port: endpoint.port })
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  const connected = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), budgetMs)
    socket.once('connect', () => { clearTimeout(timer); resolve(true) })
    socket.once('error', () => { clearTimeout(timer); resolve(false) })
  })
  if (!connected) { socket.destroy(); return undefined }
  let buffered = ''
  const waiting = []
  socket.on('data', chunk => {
    buffered += chunk
    for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
      const line = buffered.slice(0, nl)
      buffered = buffered.slice(nl + 1)
      let reply
      try { reply = JSON.parse(line) } catch { reply = undefined }
      waiting.shift()?.(reply)
    }
  })
  socket.once('close', () => { for (const w of waiting.splice(0)) w(undefined) })
  return {
    request(body, ms = Math.max(0, deadline - Date.now())) {
      return new Promise(resolve => {
        const timer = setTimeout(() => resolve(undefined), ms)
        waiting.push(reply => { clearTimeout(timer); resolve(reply) })
        socket.write(JSON.stringify({ ...body, key: endpoint.key }) + '\n')
      })
    },
    close() { socket.destroy() },
  }
}

/** Write to stdout and call back once the bytes were accepted (the handoff the ledger receipts). */
export function writeStdout(text) {
  return new Promise(resolve => {
    try { process.stdout.write(text, error => resolve(!error)) } catch { resolve(false) }
  })
}

/**
 * This hook's ancestor processes as `{pid, startTime, executable}`, the identity room-mcp's probeProcess
 * reads (relay/src/process.ts), so the MCP can find the record whose chain holds its host (registry §17).
 */
export function processChain(start = process.ppid, depth = 8) {
  const table = processTable()
  const chain = []
  for (let pid = start; pid > 1 && chain.length < depth; pid = table.get(pid)?.ppid ?? 0) {
    const entry = table.get(pid)
    if (!entry?.startTime) break
    chain.push({ pid, startTime: entry.startTime, executable: entry.executable })
  }
  return chain
}

function processTable() {
  const table = new Map()
  try {
    if (process.platform === 'linux') {
      const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue
        try {
          const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8')
          const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
          let executable
          try { executable = path.basename(fs.readlinkSync(`/proc/${name}/exe`)) } catch { /* not ours to read */ }
          table.set(Number(name), { ppid: Number(fields[1]), startTime: `linux:${bootId}:${fields[19]}`, executable })
        } catch { /* exited while listing */ }
      }
    } else if (process.platform === 'darwin') {
      const env = { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' }
      const boot = execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 1000, env }).match(/sec\s*=\s*(\d+)/)?.[1]
      const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8', timeout: 2000, env, maxBuffer: 8 * 1024 * 1024 })
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+\w{3} (\w{3})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})\s+(.*)$/.exec(line)
        if (!m || !boot) continue
        const seconds = Date.UTC(Number(m[8]), months.indexOf(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])) / 1000
        table.set(Number(m[1]), { ppid: Number(m[2]), startTime: `darwin:${boot}:${seconds}`, executable: path.basename(m[9].trim()) })
      }
    }
  } catch { /* no identity: the session binds by other means (registry §17) */ }
  return table
}

/** Keep write evidence per host session: two sessions in one worktree have separate directories. */
export function recordWriteIntents(dir, root, paths, now = Date.now()) {
  if (!paths.length) return
  const file = path.join(dir, 'write-intents.json')
  const prior = readJson(file, null)
  const writes = (Array.isArray(prior?.writes) ? prior.writes : []).filter(w =>
    typeof w?.path === 'string' && Number.isFinite(w.at) && w.at <= now && now - w.at < 600_000)
  for (const p of paths) writes.push({ path: path.resolve(root, p), at: now })
  writeJsonAtomic(file, { at: now, writes: writes.slice(-200) })
}

// Both hook manifests include shell tools. Bash is Codex's documented canonical name;
// the remaining aliases cover host/version differences (exec is also a display name).
export function isShellTool(name) {
  return /^(?:Bash|PowerShell|shell|local_shell|exec|exec_command|unified_exec)$/.test(name)
}

function* inputStrings(value) {
  if (typeof value === 'string') yield value
  else if (Array.isArray(value)) { for (const item of value) yield* inputStrings(item) }
  else if (value && typeof value === 'object') { for (const item of Object.values(value)) yield* inputStrings(item) }
}

/** Advisory write heuristic, not a shell parser. Never scan oversized command strings. */
export function shellLooksLikeWrite(input) {
  const command = input?.command ?? input?.cmd ?? input
  const strings = Array.isArray(command) && command.every(v => typeof v === 'string')
    ? [command.reduce((s, v) => s.length > 20_000 ? s : s + ' ' + v, '')] : inputStrings(command)
  for (const text of strings) {
    if (text.length > 20_000) continue
    if (/>|(?:^|[\s;|&()])(?:\S*\/)?(?:sed\s+[^\n;|&]*?-[^\s]*i|perl\s+[^\n;|&]*?-[^\s]*i|(?:tee|mv|cp|rm|apply_patch)(?=\s|$)|git\s+(?:apply|checkout|restore|stash|merge|rebase)(?=\s|$)|(?:python[\d.]*|node)\s+[^\n;|&]*?(?:-[ce](?=\s|['"]|$)|<<))/.test(text)
      || /(?:^|[;|&(){}\n])\s*(?:set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|sc|ac|ni|ri|del|mv|cp|ren)(?=\s|$)/i.test(text)) return true
  }
  return false
}

/** Repo-relative paths touched by an edit or shell tool. Shell scanning skips strings
 * over 20,000 chars and checks at most 200 tokens across the entire tool input. */
export function pathsOf(toolName, input, root) {
  const out = new Set()
  const shell = isShellTool(toolName)
  let candidates = 0
  const rel = p => {
    const windows = /^(?:[a-z]:[\\/]|\\\\)/i.test(root)
    const lib = windows ? path.win32 : path
    const value = windows ? p.replaceAll('/', '\\') : p.replaceAll('\\', '/')
    const abs = lib.isAbsolute(value) ? value : lib.resolve(root, value)
    const r = lib.relative(root, abs)
    return r && r !== '..' && !r.startsWith('..' + lib.sep) ? r.split(lib.sep).join('/') : undefined
  }
  if (!shell && input && typeof input === 'object') {
    for (const key of ['file_path', 'path', 'filePath']) if (typeof input[key] === 'string') {
      const r = rel(input[key]); if (r) out.add(r)
    }
  }
  for (const text of inputStrings(input)) {
    if (shell && text.length > 20_000) continue
    if (!shell) {
      for (const m of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) { const r = rel(m[1].trim()); if (r) out.add(r) }
    }
    // Keep whole values for edit tools (including paths containing spaces). Shell
    // punctuation separates tokens so redirects and quoted arguments work too.
    const tokens = toolName === 'PowerShell'
      ? Array.from(text.matchAll(/"(?:\x60.|[^"\x60])*"|'(?:''|[^'])*'|[^\s'"\x60;|&<>()]+/g), m => [m[0].replace(/^(?:"|')|(?:"|')$/g, '')])
      : shell ? text.matchAll(/[^\s'"\x60;|&<>()]+/g) : [[text.trim()]]
    for (const [token] of tokens) {
      if (shell && candidates++ >= 200) return Array.from(out)
      if (!token || token.length >= 400 || token.includes('\n')) continue
      const r = rel(token)
      if (r && (fs.existsSync(path.join(root, r)) || (shell && !token.startsWith('-') && /[/\\.]\w/.test(token)))) out.add(r)
    }
  }
  return Array.from(out)
}

/** Identical company wording at session start and before tools. */
export function companyLine(state) {
  if (typeof state.companyLine === 'string') return state.companyLine
  const names = Array.isArray(state.others) && state.others.length ? state.others : ['Someone']
  return '[room] ' + names.join(', ') + (names.length > 1 ? ' are here.' : ' is here.')
}

/**
 * Claude Code caps a hook's additionalContext at 10,000 characters; over it, the model sees a file path and
 * a 2,000-character preview it is not asked to read (hooks reference, "JSON output"). Hooks stay under it.
 */
export const CONTEXT_CAP = 10_000
const CUT = '… (more: call room_state)'

/** `lines`, in order, while they fit `budget` characters joined by newlines; the first misfit is cut short. */
export function fitLines(lines, budget) {
  const out = []
  let used = 0
  for (const line of lines) {
    const sep = out.length ? 1 : 0
    if (used + sep + line.length <= budget) { out.push(line); used += sep + line.length; continue }
    const room = budget - used - sep - CUT.length
    if (room >= 0) out.push(line.slice(0, room) + CUT)
    break
  }
  return out
}

/** Characters of `lines` joined by newlines. */
export const joinedLength = lines => lines.reduce((n, line, i) => n + line.length + (i ? 1 : 0), 0)

/** Dependency-free mirrors of shared near.ts; parity-tested. */
export function normalizeCoordinationPath(p) {
  const parts = []
  for (const part of p.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/') || '.'
}

export function containsPath(parent, child) {
  const valid = p => p.trim().length > 0 && !/^(?:[\\/]|[a-z]:)/i.test(p) &&
    (normalizeCoordinationPath(p) !== '.' || p === '.' || p === './')
  if (!valid(parent) || !valid(child)) return false
  const a = normalizeCoordinationPath(parent), b = normalizeCoordinationPath(child)
  return a === '.' || a === b || b.startsWith(a + '/')
}

export function coversPath(a, b) {
  return containsPath(a, b) || containsPath(b, a)
}
