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

// Advisory shell parser: recognize explicit write forms and their destinations.
// Unknown commands stay silent. Quotes protect separators and spaces in path names.
function shellCommands(input) {
  const command = input?.command ?? input?.cmd ?? input
  const values = Array.isArray(command) && command.every(v => typeof v === 'string') ? [command.join(' ')] : inputStrings(command)
  const commands = []
  for (const value of values) {
    if (value.length > 20_000) continue
    let segment = '', quote = ''
    for (let i = 0; i < value.length; i++) {
      const c = value[i]
      if (quote) {
        segment += c
        if (c === quote && value[i - 1] !== '\\') quote = ''
      } else if (c === '"' || c === "'" || c === '`') { quote = c; segment += c }
      else if (c === '\n' || c === ';' || c === '|' || (c === '&' && value[i + 1] !== '>' && value[i - 1] !== '>')) {
        if (segment.trim()) commands.push(segment.trim())
        segment = ''
      } else segment += c
    }
    if (segment.trim()) commands.push(segment.trim())
  }
  return commands
}

function shellWords(command) {
  return Array.from(command.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|`[^`]*`|(?:\d+|&)?>>?|<|[^\s<>"'`]+/g), m => {
    const word = m[0]
    const quoted = /^['"`]/.test(word)
    return { text: quoted ? word.slice(1, -1) : word, quoted }
  }).slice(0, 200)
}

function writeTargets(input, powerShell = false, root = '') {
  const targets = []
  let cwd = ''
  const add = value => targets.push(cwd && !/^(?:[a-z]:[\\/]|[\\/])/.test(value) ? `${cwd}/${value}` : value)
  for (const raw of inputStrings(input?.command ?? input?.cmd ?? input)) {
    if (raw.length > 20_000 || !/(?:^|[;&|\n])\s*(?:[^\s/]+\/)?apply_patch(?:\s|$)/m.test(raw)) continue
    for (const match of raw.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) add((match[1] ?? match[2]).trim())
  }
  for (const command of shellCommands(input)) {
    const tokens = shellWords(command)
    const words = []
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      if (!token.quoted && /^(?:\d+|&)?>>?$|^<$/.test(token.text)) {
        const target = tokens[++i]?.text
        if (token.text.includes('>') && target && target !== '/dev/null' && !/^&\d+$/.test(target)) add(target)
      } else words.push(token.text)
    }
    while (words.length && (/^[A-Za-z_][\w]*=/.test(words[0]) || words[0] === 'env' || words[0] === 'sudo')) words.shift()
    const name = (words.shift() || '').split('/').at(-1).toLowerCase()
    if (!name) continue
    const args = words
    const positional = args.filter(w => !w.startsWith('-'))
    const last = positional.at(-1)
    if (name === 'cd') { if (args[0]) cwd = path.posix.join(cwd, args[0]); continue }
    if (powerShell) {
      const take = (...flags) => {
        for (let i = 0; i < args.length - 1; i++) if (flags.includes(args[i].toLowerCase())) add(args[i + 1])
        if (!args.some(a => flags.includes(a.toLowerCase())) && positional[0]) add(positional[0])
      }
      if (/^(?:set-content|add-content|out-file|new-item|remove-item|sc|ac|ni|ri|del|rm)$/.test(name)) {
        take('-path', '-literalpath', '-filepath')
        continue
      }
      else if (name === 'rename-item' || name === 'ren') {
        const source = args.findIndex(a => /^-(?:path|literalpath)$/i.test(a))
        if (source >= 0 && args[source + 1]) add(args[source + 1])
        else if (positional[0]) add(positional[0])
        const i = args.findIndex(a => /^-newname$/i.test(a))
        if (i >= 0 && args[i + 1]) add(args[i + 1])
        else if (last) add(last)
        continue
      }
      else if (/^(?:move-item|copy-item|mv|cp)$/.test(name)) {
        if (name === 'move-item' || name === 'mv') {
          const source = args.findIndex(a => /^-(?:path|literalpath)$/i.test(a))
          if (source >= 0 && args[source + 1]) add(args[source + 1])
          else if (positional[0]) add(positional[0])
        }
        const i = args.findIndex(a => /^-destination$/i.test(a))
        if (i >= 0 && args[i + 1]) add(args[i + 1])
        else if (last) add(last)
        continue
      }
    }
    if (name === 'sed' || name === 'perl') {
      const inPlace = args.some(a => name === 'sed' ? /^-(?:[^-\s]*i[^\s]*|i)$/.test(a) || /^--in-place(?:=.*)?$/.test(a) : /^-[^-\s]*i/.test(a))
      if (inPlace) {
        let scriptSupplied = false, scriptSkipped = false
        for (let i = 0; i < args.length; i++) {
          const arg = args[i]
          if (arg === '--') continue
          if ((name === 'sed' && ['-e', '-f', '--expression', '--file'].includes(arg)) || (name === 'perl' && arg === '-e')) { scriptSupplied = true; i++; continue }
          if (name === 'sed' && /^(?:--expression=|--file=|-e.+|-f.+)/.test(arg)) { scriptSupplied = true; continue }
          if (name === 'perl' && /^-e.+/.test(arg)) { scriptSupplied = true; continue }
          if (name === 'sed' && arg === '-i' && args[i + 1] === '') { i++; continue }
          if (arg.startsWith('-')) continue
          if (name === 'sed' && !scriptSupplied && !scriptSkipped) { scriptSkipped = true; continue }
          add(arg)
        }
      }
    } else if (name === 'patch') {
      const options = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'))
      if (!options.some(arg => ['--dry-run', '--check', '-C'].includes(arg)) && positional[0]) add(positional[0])
    } else if (['tee', 'rm', 'touch', 'truncate', 'apply_patch'].includes(name)) {
      if (name === 'rm' || name === 'touch' || name === 'tee') for (const arg of positional) add(arg)
      else if (last) add(last)
    } else if (name === 'mv') {
      for (const arg of positional) add(arg)
    } else if (name === 'cp') {
      if (last) add(last)
    } else if (name === 'find' && args.some(a => /^-(?:delete|exec|execdir|ok)$/.test(a))) {
      if (positional[0]) add(positional[0])
    } else if (name === 'dd') {
      for (const arg of args) if (arg.startsWith('of=')) add(arg.slice(3))
    } else if (name === 'git') {
      const action = args[0]
      if (action === 'mv' || action === 'rm') {
        const options = args.slice(1, args.indexOf('--') < 0 ? args.length : args.indexOf('--'))
        if (action !== 'rm' || !options.some(arg => ['--dry-run', '-n', '--cached'].includes(arg))) {
          for (const arg of args.slice(1).filter(a => !a.startsWith('-'))) add(arg)
        }
      } else if (action === 'restore') {
        const files = args.slice(1)
        for (let i = 0; i < files.length; i++) {
          if (files[i] === '-s' || files[i] === '--source') { i++; continue }
          if (files[i] !== '--' && !files[i].startsWith('-')) add(files[i])
        }
      } else if ((action === 'checkout' || action === 'stash') && args.includes('--')) {
        for (const arg of args.slice(args.indexOf('--') + 1)) add(arg)
      } else if (action === 'checkout' && !args.some(a => /^(?:-b|-B|--orphan)$/.test(a))) {
        for (const arg of args.slice(1)) {
          if (arg.startsWith('-')) continue
          try { if (fs.statSync(path.resolve(root, cwd, arg)).isFile()) add(arg) } catch { /* branch or absent path */ }
        }
      }
    }
  }
  return targets.filter(t => t && !t.startsWith('-') && t !== '/dev/null')
}

/** Repo-relative paths touched by an edit or shell tool. Shell commands are bounded above. */
export function pathsOf(toolName, input, root) {
  const out = new Set()
  const shell = isShellTool(toolName)
  const rel = p => {
    const windows = /^(?:[a-z]:[\\/]|\\\\)/i.test(root)
    const lib = windows ? path.win32 : path
    const value = windows ? p.replaceAll('/', '\\') : p.replaceAll('\\', '/')
    const abs = lib.isAbsolute(value) ? value : lib.resolve(root, value)
    const r = lib.relative(root, abs)
    return r && r !== '..' && !r.startsWith('..' + lib.sep) ? r.split(lib.sep).join('/') : undefined
  }
  if (shell) {
    for (const token of writeTargets(input, toolName === 'PowerShell', root)) {
      const r = rel(token)
      if (r && (fs.existsSync(path.join(root, r)) || /[/\\.]\w/.test(token))) out.add(r)
    }
    return Array.from(out)
  }
  if (input && typeof input === 'object') {
    for (const key of ['file_path', 'path', 'filePath']) if (typeof input[key] === 'string') {
      const r = rel(input[key]); if (r) out.add(r)
    }
  }
  for (const text of inputStrings(input)) {
    for (const m of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) { const r = rel(m[1].trim()); if (r) out.add(r) }
    // Edit tool path fields may contain spaces; keep each value intact.
    for (const token of [text.trim()]) {
      if (!token || token.length >= 400 || token.includes('\n')) continue
      const r = rel(token)
      if (r && fs.existsSync(path.join(root, r))) out.add(r)
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

/** A session id Room will name a receipt after: bounded, printable. Anything else gets no receipt. */
export function receiptSessionId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id) ? id : undefined
}
/** One before-edit receipt per session, named by a hash of its id, so no session ever rewrites another's. */
export function hookReceiptFile(stateDir, sessionId) {
  return path.join(stateDir, 'room-hook-receipts', createHash('sha256').update(sessionId).digest('hex').slice(0, 32) + '.json')
}
const RECEIPT_MAX_AGE_MS = 7 * 86400_000
const RECEIPT_PRUNE_EVERY_MS = 10 * 60_000
const RECEIPT_PRUNE_SCAN = 500
const RECEIPT_MAX_BYTES = 4096
/** Read only bounded receipt bytes, including files supplied by another local process. */
export function readReceipt(file) {
  const fd = fs.openSync(file, 'r')
  try {
    if (fs.fstatSync(fd).size > RECEIPT_MAX_BYTES) return undefined
    const bytes = Buffer.alloc(RECEIPT_MAX_BYTES + 1)
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0)
    return count <= RECEIPT_MAX_BYTES ? JSON.parse(bytes.toString('utf8', 0, count)) : undefined
  } finally { fs.closeSync(fd) }
}
/**
 * Record this session's before-edit receipt (throttled to one write per 5 s) with a temp file and a rename in
 * the receipts directory: no read-modify-write of shared state, no lock, no wait. At most every ten minutes,
 * remove receipts older than a week, checking at most 500 files per pass and advancing a cursor. Never throws.
 */
export function writeHookReceipt(stateDir, rawId, now = Date.now()) {
  const sessionId = receiptSessionId(rawId)
  if (!sessionId) return false
  const file = hookReceiptFile(stateDir, sessionId)
  const dir = path.dirname(file)
  try {
    const last = readReceipt(file)?.at
    if (typeof last === 'number' && last <= now && now - last < 5000) return false
  } catch { /* first receipt, or unreadable: write one */ }
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(temp, JSON.stringify({ sessionId, at: now }))
    fs.renameSync(temp, file)
  } catch {
    try { fs.rmSync(temp, { force: true }) } catch { /* best effort */ }
    return false
  }
  pruneHookReceipts(dir, now)
  return true
}
export function pruneHookReceipts(dir, now = Date.now()) {
  const marker = path.join(dir, '.pruned')
  const cursorFile = path.join(dir, '.prune-cursor')
  try { if (now - fs.statSync(marker).mtimeMs < RECEIPT_PRUNE_EVERY_MS) return } catch { /* never pruned */ }
  try {
    fs.writeFileSync(marker, '')
    // Names are cheap to enumerate; only 500 files are statted in one hook call.
    const names = fs.readdirSync(dir).filter(name => /\.(json|tmp)$/.test(name)).sort()
    let cursor = ''
    try { cursor = fs.readFileSync(cursorFile, 'utf8').slice(0, 255) } catch { /* first pass */ }
    const start = names.findIndex(name => name > cursor)
    const offset = start < 0 ? 0 : start
    const batch = names.slice(offset, offset + RECEIPT_PRUNE_SCAN)
    fs.writeFileSync(cursorFile, batch.at(-1) ?? '')
    for (const name of batch) {
      const file = path.join(dir, name)
      const maxAge = name.endsWith('.tmp') ? 3600_000 : RECEIPT_MAX_AGE_MS
      try {
        const before = fs.statSync(file)
        if (!before.isFile() || now - before.mtimeMs <= maxAge) continue
        // Move the pathname away before the final age check. If another hook refreshed
        // the receipt, preserve it, even if the refresh raced with the first stat.
        const tomb = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.pruning.json`
        fs.renameSync(file, tomb)
        const moved = fs.statSync(tomb)
        if (now - moved.mtimeMs > maxAge) fs.rmSync(tomb, { force: true })
        else {
          try { fs.linkSync(tomb, file); fs.rmSync(tomb, { force: true }) }
          catch (error) {
            if (error?.code === 'EEXIST') fs.rmSync(tomb, { force: true })
            else {
              try { fs.copyFileSync(tomb, file, fs.constants.COPYFILE_EXCL); fs.rmSync(tomb, { force: true }) }
              catch (copyError) { if (copyError?.code === 'EEXIST') fs.rmSync(tomb, { force: true }) }
            }
          }
        }
      } catch { /* raced; pruning is best effort */ }
    }
  } catch { /* best effort */ }
}
