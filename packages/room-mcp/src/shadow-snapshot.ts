/** Policy-equivalent raw-byte snapshots; omitted paths are coverage gaps, never deletion evidence. */
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { containedRepoPath, MATERIALIZED_PATH, validRepoPath, worktreeGitDirFromDotGit } from '@room/roomd'
import { git, gitStream } from '@room/roomd/git'
import { readDisk, ignoredTrackedPaths } from '@room/roomd/disk-scan'
import { defaultExcludedPath, defaultIgnoredPath, policyFromLevel, rulesFromText, plan } from '@room/roomd/policy'
import { ShadowGraph, type ShadowEntry } from './shadow-graph.js'

const LIMIT = 2000, SIZE = 512 * 1024, BUDGET = 8 * 1024 * 1024
// Byte conversions, the legacy spelling of text/eol, and file-level merge semantics.
// Diff/linguist/export/whitespace/marker-size attributes do not change a path-level merge answer.
const ATTRIBUTES = ['filter', 'merge', 'text', 'eol', 'crlf', 'working-tree-encoding', 'ident']
async function checkAttributes(dir: string, covered: string[], config: Map<string, string>): Promise<void> {
  if (!covered.length) return
  const output = (await gitStream(dir, ['check-attr', '-z', '--stdin', ...ATTRIBUTES], covered.join('\0') + '\0',
    { timeoutMs: 3000, maxBytes: 4 * 1024 * 1024 })).toString().split('\0')
  if (output.pop() !== '' || output.length !== covered.length * ATTRIBUTES.length * 3) throw new Error('invalid shadow attributes')
  for (let i = 0; i < covered.length; i++) {
    const file = covered[i], values = new Map<string, string>()
    for (const attribute of ATTRIBUTES) {
      const offset = (i * ATTRIBUTES.length + values.size) * 3
      if (output[offset] !== file || output[offset + 1] !== attribute) throw new Error('invalid shadow attributes')
      values.set(attribute, output[offset + 2])
    }
    const reject = (attribute: string, value: string) => {
      throw new Error(`unmodelled history: attribute ${attribute}=${value} on ${JSON.stringify(file)}`)
    }
    const named = (value: string) => !['unspecified', 'unset', 'set', ''].includes(value)
    const filter = values.get('filter')!, merge = values.get('merge')!, ident = values.get('ident')!
    if (named(filter)) reject('filter', filter)
    // Explicit text merges equal the private repo's default. Binary, union and named drivers do not.
    if (!['unspecified', 'set', 'text'].includes(merge)) reject('merge', merge)
    const defaultMerge = config.get('merge.default')
    if (merge === 'unspecified' && defaultMerge && defaultMerge !== 'text') reject('merge.default', defaultMerge)
    const encoding = values.get('working-tree-encoding')!
    if (named(encoding)) reject('working-tree-encoding', encoding)
    if (ident === 'set') reject('ident', ident)
    const text = values.get('text')!, eol = values.get('eol')!, crlf = values.get('crlf')!
    // An undefined text action falls back to legacy crlf. An explicit unset disables
    // normalization, including eol and autocrlf; input/auto are accepted by both spellings.
    const normalization = ['set', 'unset', 'auto', 'input'].includes(text) ? 'text' : 'crlf'
    const action = values.get(normalization)!
    if (action === 'unset') continue
    if (eol === 'lf' || eol === 'crlf') reject('eol', eol)
    if (['set', 'auto', 'input'].includes(action)) reject(normalization, action)
    const autocrlf = config.get('core.autocrlf')?.toLowerCase()
    if (autocrlf && !['false', 'no', 'off', '0'].includes(autocrlf)) reject('core.autocrlf', autocrlf)
  }
}
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
  const inventoryArgs = ['ls-files', '-z', '-t', '--cached', '--others', '--exclude-standard']
  const inventory = (await git(dir, inventoryArgs)).split('\0').filter(Boolean)
  const paths = [...new Set([...raw.keys(), ...inventory.map(entry => entry.slice(2))])].sort()
  // readDisk already hashes every path against its base. Treat every candidate as potentially
  // changed, preserving its policy/budget decisions without a diff that could execute filters.
  const scanInventory = { paths, changed: new Set(paths), indexed: new Set(inventory.filter(entry => entry[0] !== '?').map(entry => entry.slice(2))) }
  if (paths.length > LIMIT) throw new Error('over budget: file count')
  // Only sparse/partial state is repository-wide. Driver definitions and attribute files alone are harmless.
  const config = new Map((await gitStream(dir, ['config', '-z', '--get-regexp', '^(merge\\.default|core\\.(autocrlf|sparsecheckout|sparsecheckoutcone)|remote\\..*\\.promisor|extensions\\.partialclone)$'], '',
    { timeoutMs: 3000, maxBytes: 65536, okCodes: [0, 1] })).toString().split('\0').filter(Boolean).map(record => {
      const at = record.indexOf('\n'); return [record.slice(0, at), record.slice(at + 1)] as const
    }))
  if ([...config.keys()].some(key => key !== 'core.autocrlf' && key !== 'merge.default'))
    throw new Error('unmodelled history: sparse checkout or partial clone')
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
  const scan = () => readDisk(dir, inputs, paths, safe, new Map(), new Map(carried.map(e => [e.path, e])), () => performance.now() < graph.deadline, undefined, scanInventory)
  const facts = await scan()
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
  // Include covered deletions, but never let a private/binary/oversized path disable a participant.
  await checkAttributes(dir, paths.filter(p => !gaps.has(p)), config)
  const signature = (values: typeof facts) => JSON.stringify(values.map(f => [f.path, f.kind, f.hash, f.baseHash, f.size, f.at, f.ino, f.excluded, f.binary]))
  const fingerprint = JSON.stringify([expectedHead, policyText, [...gaps].sort(), signature(facts)])
  const current = async () => {
    const nextRoot = await fs.stat(dir), nextMarker = await fs.lstat(path.join(dir, '.git'))
    if (root.dev !== nextRoot.dev || root.ino !== nextRoot.ino || marker.dev !== nextMarker.dev || marker.ino !== nextMarker.ino) return false
    if (await controls() !== policyText || (await git(dir, ['rev-parse', 'HEAD'])).trim() !== expectedHead) return false
    const listed = (await git(dir, inventoryArgs)).split('\0').filter(Boolean)
    if (JSON.stringify(listed) !== JSON.stringify(inventory)) return false
    return signature(await scan()) === signature(facts)
  }
  if (!await current()) throw new Error('moving snapshot')
  return { entries, gaps, head: expectedHead, fingerprint, current }
}
