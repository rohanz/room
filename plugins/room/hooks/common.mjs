// Shared helpers for the room hooks. No dependencies: hooks run from the plugin cache.
import fs from 'node:fs'
import path from 'node:path'

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

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

/** Hook-local delivery state. Versions before 0.7.0 stored only the seen-id array. */
export function readHookSeen(file) {
  const value = readJson(file, { seen: [], companyTold: false })
  if (Array.isArray(value)) return { seen: value, companyTold: false }
  return { seen: Array.isArray(value?.seen) ? value.seen : [], companyTold: value?.companyTold === true }
}

export function writeHookSeen(file, value) {
  try { fs.writeFileSync(file, JSON.stringify({ seen: value.seen.slice(-2000), companyTold: value.companyTold === true })) } catch { /* best effort */ }
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
      if (r && fs.existsSync(path.join(root, r))) out.add(r)
    }
  }
  return Array.from(out)
}
