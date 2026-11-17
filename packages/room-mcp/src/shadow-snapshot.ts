/** Policy-equivalent raw-byte snapshots; omitted paths are coverage gaps, never deletion evidence. */
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { containedRepoPath, MATERIALIZED_PATH, validRepoPath, worktreeGitDirFromDotGit, commonGitDirFromDotGit } from '@room/roomd'
import { git, gitStream } from '@room/roomd/git'
import { readDisk, ignoredTrackedPaths } from '@room/roomd/disk-scan'
import { defaultExcludedPath, defaultIgnoredPath, policyFromLevel, rulesFromText, plan } from '@room/roomd/policy'
import { ShadowGraph, type ShadowEntry } from './shadow-graph.js'

const LIMIT = 2000, SIZE = 512 * 1024, BUDGET = 8 * 1024 * 1024
export interface ShadowCapture {
  entries: Map<string, ShadowEntry>; gaps: Set<string>; fingerprint: string; head: string
  current(): Promise<boolean>
}
export async function captureShadow(graph: ShadowGraph, dir: string, base: string,
  carried: readonly { path: string; sha: string; mode?: number }[] = [], initial = false): Promise<ShadowCapture> {
  dir = await fs.realpath(dir)
  const root = await fs.stat(dir), marker = await fs.lstat(path.join(dir, '.git'))
  const raw = await graph.entries(base)
  for (const entry of carried) raw.set(entry.path, { mode: entry.mode && entry.mode & 0o111 ? '100755' : '100644', oid: entry.sha })
  const inventory = (await git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean)
  const paths = [...new Set([...raw.keys(), ...inventory])].sort()
  if (paths.length > LIMIT) throw new Error('over budget: file count')
  // No external drivers/filters, normalization or attributes whose behavior differs in a foreign bare repo.
  const config = (await gitStream(dir, ['config', '--get-regexp', '^(filter\\.|merge\\..*driver|core\\.(autocrlf|eol|attributesfile|sparsecheckout|sparsecheckoutcone)|remote\\..*\\.promisor|extensions\\.partialclone)'], '', { timeoutMs: 3000, maxBytes: 65536, okCodes: [0, 1] })).toString()
  if (config.split('\n').filter(Boolean).some(line => !/^core\.autocrlf (false|input)$/.test(line)) || /core\.autocrlf input/.test(config)
    || paths.some(p => p.split('/').at(-1) === '.gitattributes')
    || fsSync.existsSync(path.join(commonGitDirFromDotGit(dir), 'info/attributes')))
    throw new Error('unmodelled history: attributes or filters')
  const attrs = (await gitStream(dir, ['check-attr', '--all', '-z', '--stdin'], paths.join('\0') + '\0', { timeoutMs: 3000, maxBytes: 4 * 1024 * 1024 })).toString()
  if (attrs) throw new Error('unmodelled history: attributes')
  const safe = (p: string): boolean => {
    if (!validRepoPath(p, MATERIALIZED_PATH) || defaultExcludedPath(p) || defaultIgnoredPath(p)) return false
    try {
      if (!containedRepoPath(dir, path.join(dir, p), { leaf: 'reject-link', allowMissing: true }).ok) return false
      const parts = p.split('/').slice(0, -1)
      return !parts.some((_, i) => fsSync.existsSync(path.join(dir, ...parts.slice(0, i + 1), '.git')))
    } catch { return false }
  }
  const controls = async () => {
    const file = path.join(dir, '.roomignore')
    const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!stat) return ''
    if (!safe('.roomignore')) throw new Error('unreadable policy')
    if (!stat.isFile() || stat.size > 65536) throw new Error('unreadable policy')
    const text = await fs.readFile(file, 'utf8')
    if (text.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#')).length > 2000) throw new Error('unreadable policy')
    return text
  }
  const policyText = await controls(), inputs = { policy: policyFromLevel('full'), rules: rulesFromText(policyText, SIZE, BUDGET), head: base }
  const expectedHead = (await git(dir, ['rev-parse', 'HEAD'])).trim()
  const admin = worktreeGitDirFromDotGit(dir)
  if (['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'].some(p => fsSync.existsSync(path.join(admin, p)))) throw new Error('unmodelled history: Git operation')
  const facts = await readDisk(dir, inputs, paths, safe, new Map(), new Map(carried.map(e => [e.path, e])), () => performance.now() < graph.deadline)
  const metadata = new Map((await graph.run(['ls-tree', '-r', '-l', '-z', base])).split('\0').filter(Boolean).map(line => {
    const m = /^\d+ blob [a-f0-9]+ +([0-9]+)\t([\s\S]+)$/.exec(line)
    return m ? [m[2], Number(m[1])] as const : ['', 0] as const
  }))
  if (carried.length) {
    const sizes = await graph.run(['cat-file', '--batch-check=%(objectname) %(objectsize)'], carried.map(e => e.sha).join('\n') + '\n')
    const byHash = new Map(sizes.split('\n').map(line => { const [hash, size] = line.split(' '); return [hash, Number(size)] }))
    for (const e of carried) { const size = byHash.get(e.sha); if (!Number.isFinite(size)) throw new Error('missing carried object'); raw.get(e.path)!.size = size }
  }
  for (const fact of facts) fact.baseSize = metadata.get(fact.path) ?? raw.get(fact.path)?.size
  const publication = plan(inputs, facts, '00'.repeat(32))
  if (publication.unsettled.length) throw new Error('moving snapshot')
  const ignored = await ignoredTrackedPaths(dir, paths)
  const gaps = new Set([...publication.excludedPaths, ...paths.filter(p => ignored.has(p) || !safe(p) || inputs.rules.roomIgnore.ignores(p))])
  const entries = new Map<string, ShadowEntry>()
  for (const fact of facts) {
    if (gaps.has(fact.path)) continue
    const entry = publication.entries.get(fact.path)
    if ((fact.baseSize ?? 0) > SIZE || entry?.state === 'held' || fact.binary || fact.kind === 'unsafe' || (fact.size ?? 0) > SIZE) { gaps.add(fact.path); continue }
    if (initial) {
      const start = raw.get(fact.path)
      if (start) {
        const size = start.size ?? Number(await graph.run(['cat-file', '-s', start.oid]))
        if (size > SIZE || start.mode !== '100644' && start.mode !== '100755') gaps.add(fact.path)
        else entries.set(fact.path, start)
      }
    } else if (fact.kind === 'file' && fact.hash) {
      const mode = (await fs.lstat(path.join(dir, fact.path))).mode & 0o111 ? '100755' : '100644'
      entries.set(fact.path, { mode, oid: fact.text === undefined ? fact.hash : await graph.blob(fact.text) })
    }
  }
  const signature = (values: typeof facts) => JSON.stringify(values.map(f => [f.path, f.kind, f.hash, f.baseHash, f.size, f.at, f.ino, f.excluded, f.binary]))
  const fingerprint = JSON.stringify([expectedHead, policyText, [...gaps].sort(), signature(facts)])
  const current = async () => {
    const nextRoot = await fs.stat(dir), nextMarker = await fs.lstat(path.join(dir, '.git'))
    if (root.dev !== nextRoot.dev || root.ino !== nextRoot.ino || marker.dev !== nextMarker.dev || marker.ino !== nextMarker.ino) return false
    if (await controls() !== policyText || (await git(dir, ['rev-parse', 'HEAD'])).trim() !== expectedHead) return false
    const listed = (await git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean)
    if (JSON.stringify(listed) !== JSON.stringify(inventory)) return false
    return signature(await readDisk(dir, inputs, paths, safe, new Map(), new Map(carried.map(e => [e.path, e])), () => performance.now() < graph.deadline)) === signature(facts)
  }
  if (!await current()) throw new Error('moving snapshot')
  return { entries, gaps, head: expectedHead, fingerprint, current }
}
