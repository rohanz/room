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
  for (const [key, value] of config) {
    if (key === 'core.autocrlf' ? value !== 'false' : key === 'merge.default' || /^(filter|merge)\.(set|unset|unspecified)\./.test(key))
      throw new Error(`unmodelled history: attribute configuration ${key} on ${JSON.stringify(covered[0])}`)
  }
  const output = (await gitStream(dir, ['check-attr', '-z', '--stdin', ...ATTRIBUTES], covered.join('\0') + '\0',
    { timeoutMs: 3000, maxBytes: 4 * 1024 * 1024 })).toString().split('\0')
  if (output.pop() !== '' || output.length !== covered.length * ATTRIBUTES.length * 3) throw new Error('invalid shadow attributes')
  // State words can also be literal values. Accept only unspecified, with ambiguous driver names barred above.
  for (let i = 0; i < output.length; i += 3) {
    const file = covered[Math.floor(i / (ATTRIBUTES.length * 3))], attribute = ATTRIBUTES[i / 3 % ATTRIBUTES.length]
    if (output[i] !== file || output[i + 1] !== attribute) throw new Error('invalid shadow attributes')
    if (output[i + 2] !== 'unspecified')
      throw new Error(`unmodelled history: attribute ${attribute}=${output[i + 2]} on ${JSON.stringify(file)}`)
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
  // Index metadata recognizes newly added gitlinks too; never inspect submodule HEAD,
  // objects, worktree or attributes. A staged pointer change is outside coverage.
  const stageArgs = ['ls-files', '--stage', '-z']
  const stages = await git(dir, stageArgs)
  const gitlinks = new Map([...raw].filter(([, e]) => e.mode === '160000'))
  const baseGitlinks = [...gitlinks.keys()]
  const indexedGitlinks = (text: string) => text.split('\0').flatMap(line => {
    const m = /^160000 [a-f0-9]+ [0-3]\t([\s\S]+)$/.exec(line)
    return m ? [m[1]] : []
  })
  const linkSignature = (text: string) => JSON.stringify([...new Set([...baseGitlinks, ...indexedGitlinks(text)])].sort())
  for (const line of stages.split('\0').filter(Boolean)) {
    const m = /^160000 ([a-f0-9]+) [0-3]\t([\s\S]+)$/.exec(line)
    if (m && !gitlinks.has(m[2])) gitlinks.set(m[2], { mode: '160000', oid: m[1] })
  }
  const opaque = (p: string) => [...gitlinks.keys()].some(link => p === link || p.startsWith(link + '/'))
  const comparableCarried = carried.filter(entry => !opaque(entry.path))
  for (const entry of comparableCarried) raw.set(entry.path, { mode: entry.mode && entry.mode & 0o111 ? '100755' : '100644', oid: entry.sha })
  const inventoryArgs = ['ls-files', '-z', '-t', '--cached', '--others', '--exclude-standard']
  const inventory = (await git(dir, inventoryArgs)).split('\0').filter(Boolean)
  const inventorySignature = (listed: string[]) => JSON.stringify(listed.filter(entry => !opaque(entry.slice(2))))
  const allPaths = new Set([...raw.keys(), ...inventory.map(entry => entry.slice(2))])
  if (allPaths.size > LIMIT) throw new Error('over budget: file count')
  const paths = [...allPaths].filter(p => !opaque(p)).sort()
  // readDisk already hashes every path against its base. Treat every candidate as potentially
  // changed, preserving its policy/budget decisions without a diff that could execute filters.
  const scanInventory = { paths, changed: new Set(paths), indexed: new Set(inventory.filter(entry => entry[0] !== '?').map(entry => entry.slice(2))) }
  // Ordinary unused drivers are harmless; state-word names are ambiguous in check-attr's output.
  const config = new Map((await gitStream(dir, ['config', '-z', '--get-regexp', '^((filter|merge)\\.(set|unset|unspecified)\\..*|merge\\.default|core\\.(autocrlf|sparsecheckout|sparsecheckoutcone)|remote\\..*\\.promisor|extensions\\.partialclone)$'], '',
    { timeoutMs: 3000, maxBytes: 65536, okCodes: [0, 1] })).toString().split('\0').filter(Boolean).map(record => {
      const at = record.indexOf('\n'); return [record.slice(0, at), record.slice(at + 1)] as const
    }))
  if ([...config.keys()].some(key => /^(core\.sparsecheckout|remote\..*\.promisor|extensions\.partialclone)/.test(key)))
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
  const scan = () => readDisk(dir, inputs, paths, safe, new Map(), new Map(comparableCarried.map(e => [e.path, e])), () => performance.now() < graph.deadline, undefined, scanInventory)
  const facts = await scan()
  const metadata = new Map([...raw].map(([p, e]) => [p, e.size]))
  if (comparableCarried.length) {
    const sizes = await graph.run(['cat-file', '--batch-check=%(objectname) %(objectsize)'], comparableCarried.map(e => e.sha).join('\n') + '\n')
    const byHash = new Map(sizes.split('\n').map(line => { const [hash, size] = line.split(' '); return [hash, Number(size)] }))
    for (const e of comparableCarried) { const size = byHash.get(e.sha); if (!Number.isFinite(size)) throw new Error('missing carried object'); raw.get(e.path)!.size = size }
  }
  for (const fact of facts) fact.baseSize = metadata.get(fact.path) ?? raw.get(fact.path)?.size
  const publication = plan(inputs, facts, '00'.repeat(32))
  if (publication.unsettled.length) throw new Error('moving snapshot')
  const ignored = await ignoredTrackedPaths(dir, paths)
  const gaps = new Set([...gitlinks.keys(), ...publication.excludedPaths, ...paths.filter(p => ignored.has(p) || !safe(p) || inputs.rules.roomIgnore.ignores(p))])
  const entries = new Map<string, ShadowEntry>(gitlinks)
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
    if (inventorySignature(listed) !== inventorySignature(inventory)) return false
    // Opaque pointer movement cannot make an otherwise stable observation unavailable.
    // Only a new gitlink boundary can change which ordinary paths were scanned.
    if (linkSignature(await git(dir, stageArgs)) !== linkSignature(stages)) return false
    return signature(await scan()) === signature(facts)
  }
  if (!await current()) throw new Error('moving snapshot')
  return { entries, gaps, head: expectedHead, fingerprint, current }
}
