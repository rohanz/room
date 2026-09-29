// Shared helpers for the room hooks. No dependencies: hooks run from the plugin cache.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

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

/** Resolve hook state by session identity when a shell has moved to another worktree. */
export function sessionStateDir(root, sessionId) {
  const initial = path.dirname(gitStatePath(root, 'room-session.json'))
  if (!sessionId || readJson(path.join(initial, 'room-session.json'), null)?.session_id === sessionId) return initial
  let common = initial
  try { common = path.resolve(initial, fs.readFileSync(path.join(initial, 'commondir'), 'utf8').trim()) } catch { /* main worktree */ }
  const candidates = [common]
  try { for (const entry of fs.readdirSync(path.join(common, 'worktrees'))) candidates.push(path.join(common, 'worktrees', entry)) } catch { /* no linked worktrees */ }
  return candidates.find(dir => readJson(path.join(dir, 'room-session.json'), null)?.session_id === sessionId) ?? initial
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

/** Hook-local delivery state. Versions before 0.7.0 stored only the seen-id array. */
export function readHookSeen(file) {
  const value = readJson(file, { seen: [], companyTold: false })
  if (Array.isArray(value)) return { seen: value, companyTold: false }
  return { seen: Array.isArray(value?.seen) ? value.seen : [], companyTold: value?.companyTold === true, ...(value?.transcript && typeof value.transcript === 'object' ? { transcript: value.transcript } : {}), ...(value?.shown && typeof value.shown === 'object' ? { shown: value.shown } : {}), ...(value?.near && typeof value.near === 'object' ? { near: value.near } : {}), ...(value?.claims && typeof value.claims === 'object' ? { claims: value.claims } : {}) }
}

export function writeHookSeen(file, value) {
  const seen = value.seen.slice(-2000)
  const shown = value.shown ? Object.fromEntries(seen.filter(id => typeof value.shown[id] === 'string').map(id => [id, value.shown[id]])) : undefined
  const near = value.near && typeof value.near === 'object' ? Object.fromEntries(Object.entries(value.near).slice(-200)) : undefined
  const claims = value.claims && typeof value.claims === 'object' ? Object.fromEntries(Object.entries(value.claims).slice(-200)) : undefined
  try { fs.writeFileSync(file, JSON.stringify({ seen, companyTold: value.companyTold === true, ...(value.transcript ? { transcript: value.transcript } : {}), ...(shown ? { shown } : {}), ...(near && Object.keys(near).length ? { near } : {}), ...(claims && Object.keys(claims).length ? { claims } : {}) })) } catch { /* best effort */ }
}

/** Consume hook context under a tiny cross-process lock. The delivered value remains as
 * an acknowledgement so the MCP process cannot restore or repeat it through a tool reply. */
export function takePendingContext(file, state, fields = ['pendingDisclosure', 'pendingNotice']) {
  const release = acquireNoticeLock(file)
  if (!release) return []
  try {
    const current = readJson(file, state)
    const lines = []
    for (const field of fields) {
      if (typeof current?.[field] !== 'string' || !current[field]) continue
      lines.push(current[field])
      current[field === 'pendingDisclosure' ? 'deliveredDisclosure' : 'deliveredNotice'] = current[field]
      delete current[field]
    }
    if (lines.length) fs.writeFileSync(file, JSON.stringify(current, null, 1) + '\n')
    return lines
  } catch { return [] }
  finally { release() }
}

/** Mirrored in hooks-bridge.ts; hooks cannot import package dependencies. */
function acquireNoticeLock(file) {
  const lock = file + '.notice-lock'
  const owner = { pid: process.pid, startedAt: Date.now() - process.uptime() * 1000, token: randomUUID() }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600)
      try { fs.writeFileSync(fd, JSON.stringify(owner)) } finally { fs.closeSync(fd) }
      return () => {
        try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).token === owner.token) fs.rmSync(lock, { force: true }) } catch { /* best effort */ }
      }
    } catch (error) {
      if (error.code !== 'EEXIST') return undefined
      try {
        const stat = fs.statSync(lock)
        const prior = JSON.parse(fs.readFileSync(lock, 'utf8'))
        let alive = typeof prior.pid === 'number' && Number.isInteger(prior.pid)
        if (alive) { try { process.kill(prior.pid, 0) } catch (e) { alive = e.code === 'EPERM' } }
        if (prior.pid === process.pid && Math.abs((prior.startedAt ?? 0) - owner.startedAt) > 5000) alive = false
        if (alive && Date.now() - stat.mtimeMs < 10_000) return undefined
        if (fs.readFileSync(lock, 'utf8') === JSON.stringify(prior)) fs.rmSync(lock, { force: true })
      } catch { /* another process may have replaced it */ }
      try { if (Date.now() - fs.statSync(lock).mtimeMs >= 10_000) fs.rmSync(lock, { force: true }) } catch { /* best effort */ }
    }
  }
  return undefined
}

/** Keep evidence separate for two agent sessions using the same worktree. */
export function recordWriteIntents(stateDir, sessionId, root, paths, now = Date.now()) {
  if (typeof sessionId !== 'string' || !sessionId) return
  const file = path.join(stateDir, `room-write-intents-${createHash('sha256').update(sessionId).digest('hex')}.json`)
  const prior = readJson(file, null)
  const writes = (Array.isArray(prior?.writes) ? prior.writes : []).filter(w =>
    typeof w?.path === 'string' && Number.isFinite(w.at) && w.at <= now && now - w.at < 600_000)
  for (const p of paths) writes.push({ path: path.resolve(root, p), at: now })
  try { fs.writeFileSync(file, JSON.stringify({ session_id: sessionId, at: now, writes: writes.slice(-200) })) } catch { /* best effort */ }
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
      else if (c === '\n' || c === ';' || c === '|' || c === '&') {
        if (segment.trim()) commands.push(segment.trim())
        segment = ''
      } else segment += c
    }
    if (segment.trim()) commands.push(segment.trim())
  }
  return commands
}

function shellWords(command) {
  return Array.from(command.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|`[^`]*`|>>?|[^\s<>"'`]+/g), m => {
    const word = m[0]
    const quoted = /^['"`]/.test(word)
    return { text: quoted ? word.slice(1, -1) : word, quoted }
  }).slice(0, 200)
}

function writeTargets(input, powerShell = false) {
  const targets = []
  let cwd = ''
  const add = value => targets.push(cwd && !/^(?:[a-z]:[\\/]|[\\/])/.test(value) ? `${cwd}/${value}` : value)
  for (const command of shellCommands(input)) {
    const tokens = shellWords(command)
    const words = tokens.map(token => token.text)
    for (let i = 0; i < words.length - 1; i++) {
      if (!tokens[i].quoted && (words[i] === '>' || words[i] === '>>') && words[i + 1] !== '&1' && words[i + 1] !== '/dev/null') add(words[i + 1])
    }
    while (words.length && (/^[A-Za-z_][\w]*=/.test(words[0]) || words[0] === 'env' || words[0] === 'sudo')) words.shift()
    const name = (words.shift() || '').split('/').at(-1).toLowerCase()
    if (!name) continue
    const args = words.filter(w => w !== '>' && w !== '>>')
    const positional = args.filter(w => !w.startsWith('-'))
    const last = positional.at(-1)
    if (name === 'cd') { if (args[0]) cwd = path.posix.join(cwd, args[0]); continue }
    if (powerShell) {
      const take = (...flags) => {
        for (let i = 0; i < args.length - 1; i++) if (flags.includes(args[i].toLowerCase())) add(args[i + 1])
        if (!args.some(a => flags.includes(a.toLowerCase())) && positional[0]) add(positional[0])
      }
      if (/^(?:set-content|add-content|out-file|new-item|remove-item|sc|ac|ni|ri|del)$/.test(name)) take('-path', '-literalpath', '-filepath')
      else if (name === 'rename-item' || name === 'ren') {
        const i = args.findIndex(a => /^-newname$/i.test(a))
        if (i >= 0 && args[i + 1]) add(args[i + 1])
        else if (last) add(last)
      }
      else if (/^(?:move-item|copy-item|mv|cp)$/.test(name)) {
        const i = args.findIndex(a => /^-destination$/i.test(a))
        if (i >= 0 && args[i + 1]) add(args[i + 1])
        else if (last) add(last)
      }
      continue
    }
    if (name === 'sed' || name === 'perl') {
      const inPlace = args.some(a => name === 'sed' ? /^-(?:[^-\s]*i[^\s]*|i)$/.test(a) || a === '--in-place' : /^-[^-\s]*i/.test(a))
      if (inPlace && last) add(last)
    } else if (name === 'patch') {
      if (!command.includes('<') && positional[0]) add(positional[0])
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
        for (const arg of args.slice(1).filter(a => !a.startsWith('-'))) add(arg)
      } else if (action === 'restore' || (action === 'checkout' && args.includes('--')) || (action === 'stash' && args.includes('--'))) {
        if (last && last !== action) add(last)
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
    for (const token of writeTargets(input, toolName === 'PowerShell')) {
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
