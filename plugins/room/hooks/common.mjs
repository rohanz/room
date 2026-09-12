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

/** Repo-relative paths an edit tool call touches. Scans every string in the input: patch
 *  file markers (apply_patch) and any value that resolves to a file inside the clone. */
export function pathsOf(toolName, input, root) {
  const out = new Set()
  const rel = p => { const abs = path.isAbsolute(p) ? p : path.resolve(root, p); const r = path.relative(root, abs); return r && !r.startsWith('..') ? r.split(path.sep).join('/') : undefined }
  const strings = []
  const walk = v => { if (typeof v === 'string') strings.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk) }
  walk(input)
  for (const text of strings) {
    for (const m of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) { const r = rel(m[1].trim()); if (r) out.add(r) }
    if (!text.includes('\n') && text.length < 400 && /[\w./-]+\.[A-Za-z0-9]+$/.test(text.trim())) { const r = rel(text.trim()); if (r && fs.existsSync(path.join(root, r))) out.add(r) }
  }
  return Array.from(out)
}
