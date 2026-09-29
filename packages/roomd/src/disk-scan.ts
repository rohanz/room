import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { setImmediate } from 'node:timers/promises'
import { git, gitBlobInfoMany, wholeTreeTimeoutMs, type GitBlobInfo } from './git.js'
import { defaultExcludedPath, defaultIgnoredPath, isTrackedOnlyLockfile, type DiskFact, type PublicationInputs } from './policy.js'

/** Thrown when the inputs a scan or prepare captured are replaced mid-way; the caller drops that publication. */
export class StalePublication extends Error {}

/** --no-index applies Git ignore rules to tracked paths too. NUL framing preserves unusual names. */
export async function ignoredTrackedPaths(dir: string, paths: readonly string[]): Promise<Set<string>> {
  if (!paths.length) return new Set()
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['check-ignore', '--no-index', '-z', '--stdin'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
    const timeout = wholeTreeTimeoutMs(paths.length)
    const timer = setTimeout(() => { child.kill(); reject(new Error(`git check-ignore timed out after ${timeout}ms`)) }, timeout)
    const output: Buffer[] = []
    let error = ''
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => { error += chunk })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => { clearTimeout(timer); code === 0 || code === 1
      ? resolve(new Set(Buffer.concat(output).toString().split('\0').filter(Boolean)))
      : reject(new Error(`git check-ignore failed: ${error.trim() || `exit ${code}`}`)) })
    child.stdin.end(paths.join('\0') + '\0')
  })
}

const formats = new Map<string, 'sha1' | 'sha256'>()
async function objectFormat(dir: string): Promise<'sha1' | 'sha256'> {
  const known = formats.get(dir)
  if (known) return known
  const actual = (await git(dir, ['rev-parse', '--show-object-format'])).trim()
  if (actual !== 'sha1' && actual !== 'sha256') throw new Error(`unsupported Git object format: ${actual}`)
  formats.set(dir, actual)
  return actual
}

/** Enumerate the full worktree/index difference from the participant's resolved base. */
export async function changedSince(dir: string, base: string, previous: Iterable<string> = []): Promise<{ paths: string[]; changed: ReadonlySet<string>; indexed: ReadonlySet<string> }> {
  const [diff, inventory] = await Promise.all([
    git(dir, ['diff', '--no-renames', '--name-only', '-z', base, '--']),
    git(dir, ['ls-files', '-z', '-t', '--cached', '--others', '--exclude-standard']),
  ])
  const indexed = new Set<string>(), untracked: string[] = []
  for (const entry of inventory.split('\0')) {
    if (!entry) continue
    if (entry[0] === '?') untracked.push(entry.slice(2))
    else indexed.add(entry.slice(2))
  }
  const changed = new Set([...diff.split('\0'), ...untracked].filter(Boolean))
  return { paths: [...new Set([...changed, ...previous].filter(Boolean))].sort(), changed, indexed }
}

/** Read facts without deciding what may be disclosed. plan() owns that decision. */
export async function readDisk(dir: string, inputs: PublicationInputs, previous: Iterable<string>, safe: (p: string) => boolean,
  oversizedCache: Map<string, { size: number; mtimeMs: number; base: string; hash: string }> = new Map(),
  carried: ReadonlyMap<string, { sha: string }> = new Map(),
  valid: () => boolean = () => true,
  onBaseBlobs?: (blobs: ReadonlyMap<string, GitBlobInfo | undefined>) => void): Promise<DiskFact[]> {
  if (inputs.policy.level === 'intent' || !inputs.policy.publisher) return []
  const { paths, changed, indexed } = await changedSince(dir, inputs.head, previous)
  const [blobs, format, gitIgnored] = await Promise.all([gitBlobInfoMany(dir, inputs.head, paths), objectFormat(dir), ignoredTrackedPaths(dir, paths)])
  onBaseBlobs?.(blobs)
  const facts: DiskFact[] = []
  let lastYield = performance.now()
  let sinceYield = 0
  for (const p of paths) {
    if (!valid()) throw new StalePublication('publication inputs changed during disk scan')
    if (++sinceYield >= 32 || performance.now() - lastYield >= 15) {
      await setImmediate()
      lastYield = performance.now()
      sinceYield = 0
      if (!valid()) throw new StalePublication('publication inputs changed during disk scan')
    }
    const baseHash = blobs.get(p)?.hash ?? carried.get(p)?.sha
    // Path rules are independent of whether the file still exists or is readable.
    if (gitIgnored.has(p) || defaultExcludedPath(p) || defaultIgnoredPath(p) || inputs.rules.roomIgnore.ignores(p) || !safe(p)) {
      facts.push({ path: p, kind: 'unsafe', excluded: true, baseHash, changed: changed.has(p) })
      continue
    }
    let stat: fs.Stats | undefined
    try { stat = fs.lstatSync(path.join(dir, p)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { facts.push({ path: p, kind: 'error', baseHash, changed: changed.has(p) }); continue }
    }
    if (!stat) { facts.push({ path: p, kind: 'absent', baseHash }); continue }
    if (isTrackedOnlyLockfile(p) && !indexed.has(p)) {
      facts.push({ path: p, kind: 'unsafe', excluded: true, exclusionReason: 'untracked lockfile', baseHash, changed: changed.has(p) })
      continue
    }
    if (!stat.isFile()) { facts.push({ path: p, kind: 'unsafe', baseHash, changed: changed.has(p) }); continue }
    if (stat.size > inputs.rules.sizeCap) {
      const base = blobs.get(p)
      if (!base || base.size !== stat.size) {
        facts.push({ path: p, kind: 'file', baseHash, size: stat.size, changed: changed.has(p) })
        continue
      }
      const cached = oversizedCache.get(p)
      const hash = cached?.base === inputs.head && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs
        ? cached.hash : (await git(dir, ['hash-object', '--no-filters', '--', p])).trim()
      oversizedCache.set(p, { base: inputs.head, size: stat.size, mtimeMs: stat.mtimeMs, hash })
      facts.push({ path: p, kind: 'file', baseHash, hash, size: stat.size })
      continue
    }
    let bytes: Buffer
    let after: fs.Stats
    try {
      const fd = fs.openSync(path.join(dir, p), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try {
        const chunks: Buffer[] = []
        let length = 0
        while (length <= inputs.rules.sizeCap) {
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, inputs.rules.sizeCap + 1 - length))
          const n = fs.readSync(fd, chunk, 0, chunk.length, null)
          if (n === 0) break
          chunks.push(chunk.subarray(0, n))
          length += n
        }
        after = fs.fstatSync(fd)
        if (length > inputs.rules.sizeCap) { facts.push({ path: p, kind: 'error', baseHash, changed: changed.has(p) }); continue }
        bytes = Buffer.concat(chunks, length)
      } finally { fs.closeSync(fd) }
      if (!after.isFile() || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
        facts.push({ path: p, kind: 'error', baseHash, changed: changed.has(p) }); continue
      }
    } catch { facts.push({ path: p, kind: 'error', baseHash, changed: changed.has(p) }); continue }
    const hash = createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    let text: string | undefined
    let binary = false
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { binary = true }
    facts.push({ path: p, kind: 'file', hash, baseHash, size: bytes.length, text, binary, at: stat.mtimeMs, ino: stat.ino,
      ...(!changed.has(p) && !baseHash ? { changed: false } : {}) })
  }
  return facts
}
