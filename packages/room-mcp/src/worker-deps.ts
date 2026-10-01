/**
 * A worker worktree lives inside the lead's clone, so with no node_modules of its own Node resolves
 * packages from the lead's install, and a workspace package resolves to the lead's sources. This gives
 * the worktree its own node_modules: a directory of links to the lead's installed packages, except that
 * workspace packages link to the worktree's own package directories. Nothing is installed or copied.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { git } from '@room/roomd/git'

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']
const DEFAULT_TIMEOUT_MS = 3000
/** Workspace discovery stops after this many directories; `**` patterns stop at this depth. */
const MAX_WALK = 5000, MAX_DEPTH = 8

interface WorkspaceLinkResult {
  /** The worktree's node_modules resolves workspace packages to its own sources. */
  linked: boolean
  /** Workspace package names; empty when the repository declares no workspaces. */
  names: string[]
  /** Why nothing was linked. */
  reason?: string
  /** Editable installs in the lead's .venv of packages whose sources are the lead's checkout. */
  python?: string[]
}

class TimedOut extends Error {}

const lstat = (p: string) => { try { return fs.lstatSync(p) } catch { return undefined } }
const isRealDir = (p: string) => !!lstat(p)?.isDirectory()
const inside = (root: string, p: string) => { const rel = path.relative(root, p); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) }

/** Patterns from package.json `workspaces` (npm, yarn: array or {packages}) and pnpm-workspace.yaml. */
function workspacePatterns(root: string): string[] | undefined {
  let found = false
  const patterns: string[] = []
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { workspaces?: unknown }
    const declared = Array.isArray(pkg?.workspaces) ? pkg.workspaces : (pkg?.workspaces as { packages?: unknown } | undefined)?.packages
    if (Array.isArray(declared)) { found = true; patterns.push(...declared.filter((p): p is string => typeof p === 'string')) }
  } catch { /* no or unreadable package.json */ }
  let yaml: string | undefined
  try { yaml = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8') } catch { /* not pnpm */ }
  if (yaml !== undefined) {
    found = true
    const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2')
    let list = false
    for (const line of yaml.split(/\r?\n/)) {
      const key = /^packages\s*:\s*(.*)$/.exec(line)
      if (key) {
        const inline = /^\[(.*)\]/.exec(key[1].trim())
        if (inline) patterns.push(...inline[1].split(',').map(unquote).filter(Boolean))
        list = !inline
        continue
      }
      if (!list) continue
      const item = /^\s+-\s*(.+?)\s*(?:#.*)?$/.exec(line)
      if (item) patterns.push(unquote(item[1]))
      else if (/^\S/.test(line)) list = false
    }
  }
  return found ? patterns : undefined
}

/** One compiled path segment per directory level; `**` spans any number of levels. */
type Glob = (RegExp | '**')[]
const segment = (glob: string) => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$')
function matches(parts: string[], pattern: Glob): boolean {
  if (!pattern.length) return !parts.length
  const [head, ...rest] = pattern
  if (head === '**') return matches(parts, rest) || (parts.length > 0 && matches(parts.slice(1), pattern))
  return parts.length > 0 && head.test(parts[0]) && matches(parts.slice(1), rest)
}
function couldMatchBelow(parts: string[], pattern: Glob): boolean {
  if (!parts.length) return true
  if (!pattern.length) return false
  const [head, ...rest] = pattern
  if (head === '**') return true
  return head.test(parts[0]) && couldMatchBelow(parts.slice(1), rest)
}

/** Workspace package name -> repo-relative directory, expanding the patterns under the lead's checkout. */
async function workspacePackages(root: string, patterns: string[], tick: (cheap?: boolean) => Promise<void>): Promise<Map<string, string>> {
  const compile = (p: string): Glob => p.replace(/^\.\//, '').split('/').filter(s => s && s !== '.').map(s => s === '**' ? s : segment(s))
  const include = patterns.filter(p => !p.startsWith('!')).map(compile).filter(p => p.length)
  const exclude = patterns.filter(p => p.startsWith('!')).map(p => compile(p.slice(1)))
  const packages = new Map<string, string>()
  let visited = 0
  const walk = async (parts: string[]): Promise<void> => {
    if (parts.length >= MAX_DEPTH) return
    for (const entry of fs.readdirSync(path.join(root, ...parts), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      if (++visited > MAX_WALK) throw new Error(`more than ${MAX_WALK} directories to search for workspace packages`)
      await tick(true)
      const next = [...parts, entry.name]
      if (include.some(p => matches(next, p)) && !exclude.some(p => matches(next, p))) {
        try {
          const name = (JSON.parse(fs.readFileSync(path.join(root, ...next, 'package.json'), 'utf8')) as { name?: unknown }).name
          if (typeof name === 'string' && name) packages.set(name, next.join('/'))
        } catch { /* not a package */ }
      }
      if (include.some(p => couldMatchBelow(next, p))) await walk(next)
    }
  }
  await walk([])
  return packages
}

/** Editable installs in the lead's .venv whose sources are in the lead's checkout (not a worker's). */
function editablePythonInstalls(leadDir: string, workerDir: string): string[] {
  const venv = path.join(leadDir, '.venv')
  if (!isRealDir(venv) || lstat(path.join(workerDir, '.venv'))) return []
  const sites = [path.join(venv, 'Lib', 'site-packages')]
  try { for (const v of fs.readdirSync(path.join(venv, 'lib'))) sites.push(path.join(venv, 'lib', v, 'site-packages')) } catch { /* Windows layout */ }
  const names = new Set<string>()
  for (const site of sites) {
    let entries: string[]
    try { entries = fs.readdirSync(site).filter(e => e.endsWith('.dist-info')).slice(0, 2000) } catch { continue }
    for (const info of entries) {
      try {
        const direct = JSON.parse(fs.readFileSync(path.join(site, info, 'direct_url.json'), 'utf8')) as { url?: string; dir_info?: { editable?: boolean } }
        if (!direct.dir_info?.editable || !direct.url?.startsWith('file:')) continue
        const source = fileURLToPath(direct.url)
        const rel = path.relative(leadDir, source)
        if ((rel === '' || inside(leadDir, source)) && !rel.split(path.sep).includes('.room')) names.add(info.replace(/-[^-]*\.dist-info$/, ''))
      } catch { /* not a direct install */ }
    }
  }
  return [...names].sort()
}

/**
 * Give a new worker worktree its own node_modules. Bounded in time, never throws: on any failure or
 * timeout it removes what it made and says why, and the worktree resolves packages from the lead's clone.
 */
export async function linkWorkspaceDeps(leadDir: string, workerDir: string,
  options: { timeoutMs?: number; now?: () => number } = {}): Promise<WorkspaceLinkResult> {
  const now = options.now ?? Date.now, timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deadline = now() + timeoutMs
  let ticks = 0
  // Discovery checks the clock and yields every 64 directories; linking does on every entry.
  const tick = async (cheap = false) => {
    if (cheap && ++ticks % 64) return
    if (now() > deadline) throw new TimedOut()
    if (!cheap && ++ticks % 64) return
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  let python: string[] = []
  try { python = editablePythonInstalls(leadDir, workerDir) } catch { /* reported only when found */ }
  const result = (r: WorkspaceLinkResult): WorkspaceLinkResult => python.length ? { ...r, python } : r
  const created: string[] = []
  let names: string[] = []
  try {
    const patterns = workspacePatterns(leadDir)
    if (!patterns) return result({ linked: false, names })
    const packages = await workspacePackages(leadDir, patterns, tick)
    names = [...packages.keys()].sort()
    if (!names.length) return result({ linked: false, names })
    if (!isRealDir(path.join(leadDir, 'node_modules'))) return result({ linked: false, names, reason: 'your clone has no node_modules' })
    if (!LOCKFILES.some(f => lstat(path.join(leadDir, f)))) return result({ linked: false, names, reason: `your clone has no lockfile (${LOCKFILES.join(', ')})` })
    const dirs = ['', ...[...packages.values()].filter(rel => isRealDir(path.join(leadDir, rel, 'node_modules')) && isRealDir(path.join(workerDir, rel)))]
    // A node_modules holding only tool caches (vitest's .vite, .cache) is not an install; link beside them.
    const cachesOnly = (dir: string) => !lstat(dir) || (isRealDir(dir) && fs.readdirSync(dir).every(e => e.startsWith('.') && e !== '.bin'))
    for (const rel of dirs) {
      if (!cachesOnly(path.join(workerDir, rel, 'node_modules'))) return result({ linked: false, names, reason: `${path.join(rel, 'node_modules')} already exists in the worktree` })
    }
    // Links Git could see would be collected into the lead; only link where Git ignores node_modules.
    const probes = dirs.map(rel => path.posix.join(rel, 'node_modules', '.room-probe'))
    const ignored = new Set((await git(workerDir, ['check-ignore', '--', ...probes], Math.max(1, deadline - now())).catch(() => '')).split('\n').filter(Boolean))
    const tracked = probes.filter(p => !ignored.has(p))
    if (tracked.length) return result({ linked: false, names, reason: `Git does not ignore ${path.posix.dirname(tracked[0])}` })
    const link = (target: string, at: string) => {
      const type = process.platform === 'win32' ? (fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() ? 'junction' : 'file') : undefined
      fs.symlinkSync(target, at, type)
    }
    const linkPackage = (from: string, to: string, name: string) => {
      const own = packages.get(name)
      let target = own !== undefined && isRealDir(path.join(workerDir, own)) ? path.join(workerDir, own) : from
      if (target === from && lstat(from)?.isSymbolicLink()) {
        // A link into the lead's own sources that the manifest does not name (file: or link: dependencies).
        const resolved = path.resolve(path.dirname(from), fs.readlinkSync(from))
        const rel = path.relative(leadDir, resolved)
        if (inside(leadDir, resolved) && !rel.split(path.sep).some(p => p === 'node_modules' || p === '.room') && lstat(path.join(workerDir, rel))) target = path.join(workerDir, rel)
      }
      link(target, to)
    }
    const mirror = async (src: string, dst: string) => {
      const existed = !!lstat(dst)
      if (!existed) { fs.mkdirSync(dst); created.push(dst) }
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        await tick()
        const from = path.join(src, entry.name), to = path.join(dst, entry.name)
        if (existed && (!entry.name.startsWith('.') || entry.name === '.bin')) created.push(to)
        if (entry.name === '.bin' && entry.isDirectory()) {
          // Relative bin links resolve through this node_modules, so a workspace package's bin runs the worktree's
          // code; shims (pnpm, Windows) are small scripts that find their package relative to themselves.
          fs.mkdirSync(to)
          for (const bin of fs.readdirSync(from, { withFileTypes: true })) {
            await tick()
            const source = path.join(from, bin.name), target = path.join(to, bin.name)
            if (bin.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target)
            else if (bin.isFile()) { fs.copyFileSync(source, target); fs.chmodSync(target, fs.statSync(source).mode) }
          }
        } else if (entry.name.startsWith('.')) {
          continue // package-manager state and caches (.package-lock.json, .modules.yaml, .pnpm, .vite) stay the lead's
        } else if (entry.name.startsWith('@') && entry.isDirectory()) {
          fs.mkdirSync(to)
          for (const scoped of fs.readdirSync(from)) {
            await tick()
            linkPackage(path.join(from, scoped), path.join(to, scoped), `${entry.name}/${scoped}`)
          }
        } else linkPackage(from, to, entry.name)
      }
    }
    for (const rel of dirs) await mirror(path.join(leadDir, rel, 'node_modules'), path.join(workerDir, rel, 'node_modules'))
    return result({ linked: true, names })
  } catch (error) {
    // Remove only what this step made. fs.rmSync removes links without following them, so the lead's install is never touched.
    for (const made of created.reverse()) try { fs.rmSync(made, { recursive: true, force: true }) } catch { /* reported below */ }
    const reason = error instanceof TimedOut ? `linking timed out after ${timeoutMs} ms` : `linking failed: ${error instanceof Error ? error.message : String(error)}`
    return result({ linked: false, names, reason })
  }
}

/** Lines for the spawn reply and the worker's brief. */
export function workspaceDepsNotes(result: WorkspaceLinkResult): { reply: string[]; prompt?: string } {
  const list = (names: string[]) => names.length > 8 ? `${names.slice(0, 8).join(', ')} and ${names.length - 8} more` : names.join(', ')
  const reply: string[] = [], prompt: string[] = []
  if (result.names.length && result.linked) {
    reply.push(`node_modules: links to your install, with workspace packages ${list(result.names)} pointing at the worktree's own sources`)
    prompt.push(`node_modules here links the lead's installed packages, with workspace packages (${list(result.names)}) pointing at this worktree. To change dependencies, delete node_modules first (that removes only the links), then install.`)
  } else if (result.names.length) {
    const warning = `cross-package tests in this worktree would run the lead's code for ${list(result.names)}`
    reply.push(`warning: ${warning} (${result.reason})`)
    prompt.push(`Warning: ${warning} (${result.reason}); install dependencies in this worktree before relying on them.`)
  }
  if (result.python?.length) {
    reply.push(`warning: Python tests in this worktree would import the lead's code for ${list(result.python)} (editable installs in your .venv); the worker is told to run uv sync`)
    prompt.push(`Python: the lead's .venv has editable installs of ${list(result.python)} from the lead's checkout. Run \`uv sync\` here (then \`uv run …\`) so this worktree gets its own .venv; otherwise Python tests import the lead's code.`)
  }
  return prompt.length ? { reply, prompt: prompt.join('\n') } : { reply }
}
