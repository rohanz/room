/** Full-life checkout identity, with conservative compatibility for established pre-witness records. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { boundedGitSync } from '@room/roomd/baseline'
import { withGitWorktreeOperation } from '@room/roomd/git'
import { createExclusive } from './leases.js'
import { deleteWorkerRef } from './worker-refs.js'
import { retainWorkerItem, clearRetainedWorkerItem } from './worker-retained.js'
import type { WorkerRecord } from './worker-status.js'

export interface PreparationIdentity { id: string; nonce: string }
export interface RootReceipt { dev: string; ino: string; birthtimeNs: string }
export interface PreparationWitness extends PreparationIdentity {
  v: 1; token: string; adminDir: string; branch: string; dev: string; ino: string
  root?: RootReceipt; branchOid?: string
}
export const PREPARATION_WITNESS_FILE = 'room-preparation.json'
const identityContext = new AsyncLocalStorage<PreparationIdentity>()
export const withPreparationIdentity = <T>(identity: PreparationIdentity, work: () => T): T => identityContext.run(identity, work)
export const preparationIdentity = (): PreparationIdentity => identityContext.getStore() ?? { id: randomUUID(), nonce: randomUUID() }
const trimLine = (text: string) => text.replace(/\r?\n$/, '')
const smallFile = (file: string): string => {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.size > 4096) throw new Error(`not a small regular file: ${file}`)
  return fs.readFileSync(file, 'utf8')
}
export function rootIdentity(dir: string): RootReceipt {
  const stat = fs.lstatSync(dir, { bigint: true })
  if (!stat.isDirectory() || (stat.ino === 0n || stat.birthtimeNs <= 0n)) throw new Error(`cannot establish plain directory identity: ${dir}`)
  return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) }
}
function verifyRoot(dir: string, root: RootReceipt): void {
  const actual = rootIdentity(dir)
  if (actual.dev !== root.dev || actual.ino !== root.ino || actual.birthtimeNs !== root.birthtimeNs) throw new Error('root directory identity changed')
}
/** Resolve both directions of Git's linked-worktree metadata. */
function adminOf(dir: string): { adminDir: string; common: string } {
  const gitfile = path.join(dir, '.git'), contents = trimLine(smallFile(gitfile))
  if (!contents.startsWith('gitdir: ')) throw new Error('invalid worktree gitfile')
  const adminDir = fs.realpathSync.native(path.resolve(dir, contents.slice(8)))
  const common = fs.realpathSync.native(path.resolve(adminDir, trimLine(smallFile(path.join(adminDir, 'commondir')))))
  if (fs.realpathSync.native(path.dirname(adminDir)) !== fs.realpathSync.native(path.join(common, 'worktrees'))) throw new Error('not a linked-worktree admin directory')
  const backlink = path.resolve(adminDir, trimLine(smallFile(path.join(adminDir, 'gitdir'))))
  if (fs.realpathSync.native(backlink) !== fs.realpathSync.native(gitfile)) throw new Error('worktree backlink changed')
  return { adminDir, common }
}
/** Called synchronously immediately after add, using the root receipt from our exclusive mkdir. */
export function witnessPreparation(dir: string, branch: string, identity: PreparationIdentity, root?: RootReceipt, branchOid?: string): PreparationWitness {
  if (root) verifyRoot(dir, root)
  const { adminDir } = adminOf(dir), stat = fs.statSync(adminDir, { bigint: true })
  if (trimLine(smallFile(path.join(adminDir, 'HEAD'))) !== (branch === 'HEAD' ? branchOid : `ref: refs/heads/${branch}`)) throw new Error('worktree branch changed before witness')
  const witness: PreparationWitness = { v: 1, ...identity, branch, adminDir, dev: String(stat.dev), ino: String(stat.ino), token: randomUUID(), root, branchOid }
  const marker = path.join(adminDir, PREPARATION_WITNESS_FILE)
  if (fs.existsSync(marker)) throw new Error('worktree witness already exists')
  if (!createExclusive(marker, witness)) throw new Error('worktree witness already exists')
  verifyPreparation(dir, witness)
  return witness
}
export function verifyPreparation(dir: string, expected: PreparationIdentity & { branch: string; adminDir?: string; token?: string; root?: RootReceipt }, commonDir?: string): PreparationWitness {
  try {
    const { adminDir, common } = adminOf(dir)
    if (commonDir && fs.realpathSync.native(commonDir) !== common) throw new Error('worktree belongs to another clone')
    const value = JSON.parse(smallFile(path.join(adminDir, PREPARATION_WITNESS_FILE))) as PreparationWitness
    const stat = fs.statSync(adminDir, { bigint: true })
    if (value.v !== 1 || value.id !== expected.id || value.nonce !== expected.nonce || value.branch !== expected.branch
      || typeof value.token !== 'string' || !value.token || value.adminDir !== adminDir || value.dev !== String(stat.dev) || value.ino !== String(stat.ino)
      || expected.adminDir && expected.adminDir !== adminDir || expected.token && expected.token !== value.token) throw new Error('missing or mismatched worktree witness')
    if (expected.root && !value.root) throw new Error('missing root creation receipt')
    if (value.root) verifyRoot(dir, value.root)
    if (expected.root) verifyRoot(dir, expected.root)
    if (trimLine(smallFile(path.join(adminDir, 'HEAD'))) !== (expected.branch === 'HEAD' ? value.branchOid : `ref: refs/heads/${expected.branch}`)) throw new Error('worktree branch changed')
    return value
  } catch (error) {
    throw new Error(`kept preparation ${dir}: cannot verify its worktree identity (${error instanceof Error ? error.message : String(error)})`)
  }
}
/** Established old records retain their historical recorded-facts verification, never new/unfinished ones. */
export function verifyWorkerCheckout(common: string, record: Pick<WorkerRecord, 'id' | 'dir' | 'branch' | 'prep' | 'runs' | 'phase' | 'outside' | 'sharedWith'>): void {
  if (record.outside || record.sharedWith) throw new Error('supplied or borrowed checkout is non-owning')
  if (record.prep.root) verifyRoot(record.dir, record.prep.root)
  if (record.prep.witness) {
    const verified = verifyPreparation(record.dir, { ...record.prep.witness, id: record.id, nonce: record.runs[0].nonce, branch: record.branch }, common)
    if (record.prep.identityRequired && !verified.root) throw new Error('missing root creation receipt')
    return
  }
  const { adminDir, common: actual } = adminOf(record.dir)
  if (actual !== fs.realpathSync.native(common)) throw new Error('checkout belongs to another repository')
  const marker = path.join(adminDir, PREPARATION_WITNESS_FILE)
  let markerExists = false
  try { fs.lstatSync(marker); markerExists = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (record.prep.identityRequired || ['intent', 'preparing'].includes(record.phase) || markerExists) {
    const verified = verifyPreparation(record.dir, { id: record.id, nonce: record.runs[0].nonce, branch: record.branch, ...(record.prep.root ? { root: record.prep.root } : {}) }, common)
    if (record.prep.identityRequired && !verified.root) throw new Error('missing root creation receipt')
  } else if (trimLine(smallFile(path.join(adminDir, 'HEAD'))) !== `ref: refs/heads/${record.branch}`) throw new Error('legacy checkout branch changed')
}
/** Verify then remove synchronously; the single known check/use race is intentionally documented. */
export async function removePreparation(commonDir: string, dir: string, expected: PreparationIdentity & { branch: string; adminDir?: string; token?: string; root?: RootReceipt; branchOid?: string }, removeBranch: boolean): Promise<void> {
  const witnessed = await withGitWorktreeOperation(commonDir, () => {
    const witnessed = verifyPreparation(dir, expected, commonDir)
    boundedGitSync(commonDir, ['--git-dir', commonDir, '-c', 'core.hooksPath=/dev/null', 'worktree', 'remove', '--force', dir])
    return witnessed
  })
  clearRetainedWorkerItem(commonDir, 'worktree', dir)
  if (removeBranch) deleteWorkerRef(commonDir, `refs/heads/${expected.branch}`, expected.id, expected.branchOid ?? witnessed.branchOid)
}
/** Preserve spelling through the nearest existing ancestor when nested roots vanished. */
export function canonicalMissingWorkerPath(dir: string): string {
  let current = path.resolve(dir)
  const suffix: string[] = []
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), ...suffix) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      suffix.unshift(path.basename(current)); current = parent
    }
  }
}
/** Remove only a witnessed admin entry, independently of the reusable checkout path. */
export async function removeWorkerRegistration(common: string, admin: string, expected: PreparationWitness, dir: string): Promise<void> {
  await withGitWorktreeOperation(common, () => {
    const realCommon = fs.realpathSync.native(common)
    const expectedBacklink = path.join(canonicalMissingWorkerPath(dir), '.git')
    if (path.resolve(admin, trimLine(smallFile(path.join(admin, 'gitdir')))) !== expectedBacklink) throw new Error('registration moved away from the recorded root')
    try { fs.lstatSync(dir); throw new Error('checkout reappeared; registration retained') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (path.dirname(admin) !== path.join(realCommon, 'worktrees') || admin !== expected.adminDir) throw new Error('unsafe admin entry')
    const marker = JSON.parse(smallFile(path.join(admin, PREPARATION_WITNESS_FILE))) as PreparationWitness
    const stat = fs.lstatSync(admin, { bigint: true })
    if (!stat.isDirectory() || marker.v !== 1 || typeof marker.id !== 'string' || !marker.id || typeof marker.nonce !== 'string' || !marker.nonce || typeof marker.token !== 'string' || !marker.token || marker.id !== expected.id || marker.nonce !== expected.nonce || marker.token !== expected.token
      || marker.dev !== String(stat.dev) || marker.ino !== String(stat.ino) || marker.adminDir !== admin) throw new Error('registration identity changed')
    if (fs.realpathSync.native(path.resolve(admin, trimLine(smallFile(path.join(admin, 'commondir'))))) !== realCommon) throw new Error('registration common directory changed')
    if (trimLine(smallFile(path.join(admin, 'HEAD'))) !== (marker.branch === 'HEAD' ? marker.branchOid : `ref: refs/heads/${marker.branch}`)) throw new Error('registration branch changed')
    if (fs.existsSync(path.join(admin, 'locked'))) throw new Error('user-locked registration retained')
    fs.rmSync(admin, { recursive: true })
  })
  clearRetainedWorkerItem(common, 'registration', admin)
}
export function retainCheckout(common: string, record: { id?: string; tag?: string; dir: string; branch?: string; witness?: Pick<PreparationWitness, 'adminDir'>; prep?: { witness?: Pick<PreparationWitness, 'adminDir'> } }, reason: string): string {
  const lines = [retainWorkerItem(common, { kind: 'worktree', path: record.dir, id: record.id, tag: record.tag, reason })]
  if (record.branch) lines.push(retainWorkerItem(common, { kind: 'branch', path: `refs/heads/${record.branch}`, id: record.id, tag: record.tag, reason: 'checkout identity could not be verified; branch retained in place' }))
  const admins = new Set<string>()
  const reportAdmin = (admin: string) => {
    try { fs.lstatSync(admin) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return }
    try { admin = fs.realpathSync.native(admin) } catch { /* unreadable recorded metadata remains uncertain */ }
    if (!admins.has(admin)) lines.push(retainWorkerItem(common, { kind: 'registration', path: admin, id: record.id, tag: record.tag, reason }))
    admins.add(admin)
  }
  const recordedAdmin = record.prep?.witness?.adminDir ?? record.witness?.adminDir
  if (recordedAdmin) reportAdmin(recordedAdmin)
  try {
    const expectedBacklink = path.join(canonicalMissingWorkerPath(record.dir), '.git')
    for (const name of fs.readdirSync(path.join(common, 'worktrees'))) {
      const admin = path.join(common, 'worktrees', name)
      try {
        if (path.resolve(admin, trimLine(smallFile(path.join(admin, 'gitdir')))) === expectedBacklink)
          reportAdmin(admin)
      } catch { /* unreadable unrelated metadata grants no deletion authority */ }
    }
  } catch { /* the checkout itself remains reported */ }
  return lines.join('\n')
}
