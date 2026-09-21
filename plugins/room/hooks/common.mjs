// Shared helpers for the room hooks. No dependencies: hooks run from the plugin cache.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

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
      if (m) return path.join(path.resolve(root, m[1].trim()), name)
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
  return { seen: Array.isArray(value?.seen) ? value.seen : [], companyTold: value?.companyTold === true, ...(value?.transcript && typeof value.transcript === 'object' ? { transcript: value.transcript } : {}), ...(value?.shown && typeof value.shown === 'object' ? { shown: value.shown } : {}) }
}

export function writeHookSeen(file, value) {
  const seen = value.seen.slice(-2000)
  const shown = value.shown ? Object.fromEntries(seen.filter(id => typeof value.shown[id] === 'string').map(id => [id, value.shown[id]])) : undefined
  try { fs.writeFileSync(file, JSON.stringify({ seen, companyTold: value.companyTold === true, ...(value.transcript ? { transcript: value.transcript } : {}), ...(shown ? { shown } : {}) })) } catch { /* best effort */ }
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
  return /^(?:Bash|shell|local_shell|exec|exec_command|unified_exec)$/.test(name)
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
    if (/>|(?:^|[\s;|&()])(?:\S*\/)?(?:sed\s+[^\n;|&]*?-[^\s]*i|perl\s+[^\n;|&]*?-[^\s]*i|(?:tee|mv|cp|rm|apply_patch)(?=\s|$)|git\s+(?:apply|checkout|restore|stash|merge|rebase)(?=\s|$)|(?:python[\d.]*|node)\s+[^\n;|&]*?(?:-[ce](?=\s|['"]|$)|<<))/.test(text)) return true
  }
  return false
}

/** Repo-relative paths touched by an edit or shell tool. Shell scanning skips strings
 * over 20,000 chars and checks at most 200 tokens across the entire tool input. */
export function pathsOf(toolName, input, root) {
  const out = new Set()
  const shell = isShellTool(toolName)
  let candidates = 0
  const rel = p => { const abs = path.isAbsolute(p) ? p : path.resolve(root, p); const r = path.relative(root, abs); return r && r !== '..' && !r.startsWith('..' + path.sep) ? r.split(path.sep).join('/') : undefined }
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
    const tokens = shell ? text.matchAll(/[^\s'"\x60;|&<>()]+/g) : [[text.trim()]]
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

/** Same segment-boundary overlap as shared coversPath; parity-tested. */
export function coversPath(a, b) {
  const normalize = p => {
    const parts = []
    for (const part of p.replaceAll('\\', '/').split('/')) {
      if (!part || part === '.') continue
      if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop()
      else parts.push(part)
    }
    return parts.join('/') || '.'
  }
  const left = normalize(a), right = normalize(b)
  return left === '.' || right === '.' || left === right || left.startsWith(right + '/') || right.startsWith(left + '/')
}
