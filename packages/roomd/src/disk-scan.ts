import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { git, gitBlobInfoMany } from './git.js'
import type { DiskFact, PublicationInputs } from './policy.js'

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
export async function changedSince(dir: string, base: string, previous: Iterable<string> = []): Promise<{ paths: string[]; changed: ReadonlySet<string> }> {
  const [diff, untracked] = await Promise.all([
    git(dir, ['diff', '--no-renames', '--name-only', '-z', base, '--']),
    git(dir, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])
  const changed = new Set([...diff.split('\0'), ...untracked.split('\0')].filter(Boolean))
  return { paths: [...new Set([...changed, ...previous].filter(Boolean))].sort(), changed }
}

/** Read facts without deciding what may be disclosed. plan() owns that decision. */
export async function readDisk(dir: string, inputs: PublicationInputs, previous: Iterable<string>, safe: (p: string) => boolean,
  oversizedCache: Map<string, { size: number; mtimeMs: number; base: string; hash: string }> = new Map(),
  carried: ReadonlyMap<string, { sha: string }> = new Map()): Promise<DiskFact[]> {
  if (inputs.policy.level === 'intent' || !inputs.policy.publisher) return []
  const { paths, changed } = await changedSince(dir, inputs.head, previous)
  const [blobs, format] = await Promise.all([gitBlobInfoMany(dir, inputs.head, paths), objectFormat(dir)])
  const facts: DiskFact[] = []
  for (const p of paths) {
    const baseHash = blobs.get(p)?.hash ?? carried.get(p)?.sha
    let stat: fs.Stats | undefined
    try { stat = fs.lstatSync(path.join(dir, p)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { facts.push({ path: p, kind: 'error', baseHash }); continue }
    }
    if (!stat) { facts.push({ path: p, kind: 'absent', baseHash }); continue }
    if (!safe(p) || !stat.isFile()) { facts.push({ path: p, kind: 'unsafe', baseHash, changed: changed.has(p) }); continue }
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
    try { bytes = fs.readFileSync(path.join(dir, p)) }
    catch { facts.push({ path: p, kind: 'error', baseHash }); continue }
    const hash = createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    let text: string | undefined
    let binary = false
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { binary = true }
    facts.push({ path: p, kind: 'file', hash, baseHash, size: bytes.length, text, binary, at: stat.mtimeMs,
      ...(!changed.has(p) && !baseHash ? { changed: false } : {}) })
  }
  return facts
}
