import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import { containsPath, digestPath, manifestKey, type ManifestEntry, type ManifestHead, type RoomDoc, type ShareLevel } from '@room/shared'
import { git, gitBlobInfoMany } from './git.js'

export interface ManifestFact {
  path: string
  change: 'M' | 'A' | 'D'
  hash?: string
  size?: number
  baseHash?: string
  text?: string
  binary?: boolean
  excluded?: boolean
  at?: number
}
export interface ManifestPublication {
  room: RoomDoc
  name: string
  fence: string
  base: string
  level: ShareLevel
  prefixes: readonly string[]
  complete: boolean
  publisher?: string
  scannedAt?: number
}

const authorized = (i: ManifestPublication, p: string) => i.level === 'full' || (i.level === 'declared' && i.prefixes.some(prefix => containsPath(prefix, p)))
const contentIdentity = (e: ManifestEntry) => JSON.stringify({ change: e.change, state: e.state, held: e.held, hash: e.hash, size: e.size, baseHash: e.baseHash, fence: e.fence })
const headIdentity = (h: ManifestHead) => JSON.stringify({ base: h.base, fence: h.fence, coverage: h.coverage, level: h.level, complete: h.complete, publisher: h.publisher, textPrefixes: h.textPrefixes })
const objectFormats = new Map<string, 'sha1' | 'sha256'>()

async function objectFormat(dir: string): Promise<'sha1' | 'sha256'> {
  const cached = objectFormats.get(dir)
  if (cached) return cached
  const format = (await git(dir, ['rev-parse', '--show-object-format'])).trim()
  if (format !== 'sha1' && format !== 'sha256') throw new Error(`unsupported git object format: ${format}`)
  objectFormats.set(dir, format)
  return format
}

/** Whole-snapshot writer; old overlay publication remains untouched during rollout step 1. */
export function publishManifest(input: ManifestPublication, facts: readonly ManifestFact[]): ManifestHead {
  const { room, name, fence } = input
  const salt = room.ensureRoomSalt()
  const key = manifestKey(name, fence)
  const previous = room.manifestHead.get(name)
  const old = room.manifest.get(key)
  const entries = new Map<string, ManifestEntry>()
  const excluded: string[] = []
  if (input.level !== 'intent' && !input.publisher) {
    for (const fact of facts) {
      if (fact.excluded) { excluded.push(digestPath(salt, fact.path)); continue }
      const permit = authorized(input, fact.path)
      const prior = old?.get(fact.path)
      const at = fact.at ?? (prior && prior.hash === (permit ? fact.hash : undefined) && prior.change === fact.change ? prior.at : Date.now())
      const entry: ManifestEntry = { change: fact.change, state: fact.change === 'D' || (permit && !fact.binary && fact.text !== undefined) ? 'shared' : 'held', at, fence }
      if (fact.change !== 'D' && entry.state === 'held') entry.held = permit ? 'binary' : 'scope'
      if (permit) {
        if (fact.hash) entry.hash = fact.hash
        if (fact.size !== undefined) entry.size = fact.size
        if (fact.baseHash) entry.baseHash = fact.baseHash
      }
      entries.set(fact.path, entry)
    }
  }
  excluded.sort()
  const priorEntries = new Map(old?.entries() ?? [])
  const entryChanged = entries.size !== priorEntries.size || [...entries].some(([p, e]) => contentIdentity(e) !== contentIdentity(priorEntries.get(p) ?? {} as ManifestEntry))
  const exclusionChanged = JSON.stringify(excluded) !== JSON.stringify(previous?.excluded ?? [])
  const rev = (previous?.rev ?? 0) + (entryChanged || exclusionChanged ? 1 : 0)
  const head: ManifestHead = {
    base: input.base, fence, coverage: input.publisher ? { kind: 'none', reason: 'not-publisher' } : input.level === 'intent' ? { kind: 'none', reason: 'intent' } : { kind: 'all' },
    level: input.level, ...(input.level === 'declared' ? { textPrefixes: [...input.prefixes] } : {}), excluded,
    rev, semRev: 0, scannedAt: input.scannedAt ?? Date.now(), complete: input.complete,
    ...(input.publisher ? { publisher: input.publisher } : {}),
  }
  head.semRev = (previous?.semRev ?? 0) + (rev !== previous?.rev || !previous || headIdentity(head) !== headIdentity(previous) ? 1 : 0)
  room.doc.transact(() => {
    let map = room.manifest.get(key)
    if (!map) { map = new Y.Map<ManifestEntry>(); room.manifest.set(key, map) }
    for (const p of [...map.keys()]) if (!entries.has(p)) map.delete(p)
    for (const [p, e] of entries) if (JSON.stringify(map.get(p)) !== JSON.stringify(e)) map.set(p, e)
    room.manifestHead.set(name, head)
  })
  return head
}

/** Read the checkout against its publication base; never place excluded names in the Y.Doc. */
export async function scanManifest(input: ManifestPublication & { dir: string; sizeCap: number; totalBudget: number; safe: (path: string) => boolean }): Promise<ManifestFact[]> {
  if (input.level === 'intent' || input.publisher) return []
  const [diff, untracked] = await Promise.all([
    git(input.dir, ['diff', '--name-only', '-z', input.base, '--']),
    git(input.dir, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])
  const own = input.room.manifest.get(manifestKey(input.name, input.fence))
  const diffPaths = new Set(diff.split('\0').filter(Boolean))
  const untrackedPaths = new Set(untracked.split('\0').filter(Boolean))
  const paths = [...new Set([...diffPaths, ...untrackedPaths, ...own?.keys() ?? []].filter(Boolean))].sort()
  const basePaths = paths.filter(p => diffPaths.has(p) && !untrackedPaths.has(p))
  const blobs = basePaths.length ? await gitBlobInfoMany(input.dir, input.base, basePaths) : new Map()
  const format = await objectFormat(input.dir)
  const facts: ManifestFact[] = []
  let budget = 0
  for (const relpath of paths) {
    if (!diffPaths.has(relpath) && !untrackedPaths.has(relpath)) continue
    const base = blobs.get(relpath)
    const absolute = path.join(input.dir, relpath)
    let stat: fs.Stats | undefined
    try { stat = fs.lstatSync(absolute) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    if (!input.safe(relpath)) { facts.push({ path: relpath, change: base ? 'M' : 'A', excluded: true }); continue }
    if (!stat) { if (base) facts.push({ path: relpath, change: 'D', baseHash: base.hash }); continue }
    if (!stat.isFile() || stat.size > input.sizeCap) { facts.push({ path: relpath, change: base ? 'M' : 'A', excluded: true }); continue }
    const bytes = fs.readFileSync(absolute)
    const hash = createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    if (hash === base?.hash) continue
    if (budget + bytes.length > input.totalBudget) { facts.push({ path: relpath, change: base ? 'M' : 'A', excluded: true }); continue }
    const permit = authorized(input, relpath)
    let text: string | undefined
    let binary = false
    if (permit) {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      catch { binary = true }
      if (text !== undefined) budget += bytes.length
    }
    facts.push({ path: relpath, change: base ? 'M' : 'A', hash, size: bytes.length, baseHash: base?.hash, ...(text !== undefined ? { text } : {}), binary })
  }
  return facts
}
