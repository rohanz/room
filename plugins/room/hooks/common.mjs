// Shared helpers for the room hooks. No dependencies: hooks run from the plugin cache.
import fs from 'node:fs'
import path from 'node:path'

export function readStdinJson() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}') } catch { return {} }
}

/** Walk up from cwd to the directory containing .git (file or dir). */
export function gitRoot(start) {
  let d = path.resolve(start || process.cwd())
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

/** Repo-relative paths an edit tool call touches. */
export function pathsOf(toolName, input, root) {
  const out = new Set()
  const rel = p => { const abs = path.isAbsolute(p) ? p : path.resolve(root, p); const r = path.relative(root, abs); return r.startsWith('..') ? undefined : r.split(path.sep).join('/') }
  if (!input || typeof input !== 'object') return []
  if (toolName === 'apply_patch' || typeof input.input === 'string' || typeof input.patch === 'string') {
    const text = typeof input.input === 'string' ? input.input : typeof input.patch === 'string' ? input.patch : ''
    for (const m of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) { const r = rel(m[1].trim()); if (r) out.add(r) }
  }
  for (const k of ['file_path', 'path', 'filePath', 'file']) if (typeof input[k] === 'string') { const r = rel(input[k]); if (r) out.add(r) }
  return Array.from(out)
}
