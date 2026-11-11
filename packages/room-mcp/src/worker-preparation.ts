/** Identity proof for preparation cleanup only; established worker lifecycle uses its registry record. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { boundedGitSync } from '@room/roomd/baseline'

export interface PreparationIdentity { id: string; nonce: string }
export interface PreparationWitness extends PreparationIdentity {
  v: 1; token: string; adminDir: string; branch: string; dev: string; ino: string
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

/** Resolve both directions of Git's linked-worktree metadata, including moved worktrees. */
function adminOf(dir: string): { adminDir: string; common: string } {
  const gitfile = path.join(dir, '.git'), contents = trimLine(smallFile(gitfile))
  if (!contents.startsWith('gitdir: ')) throw new Error('invalid worktree gitfile')
  const adminDir = fs.realpathSync.native(path.resolve(dir, contents.slice(8)))
  const common = fs.realpathSync.native(path.resolve(adminDir, trimLine(smallFile(path.join(adminDir, 'commondir')))))
  if (fs.realpathSync.native(path.dirname(adminDir)) !== fs.realpathSync.native(path.join(common, 'worktrees')))
    throw new Error('not a linked-worktree admin directory')
  const backlink = path.resolve(adminDir, trimLine(smallFile(path.join(adminDir, 'gitdir'))))
  if (fs.realpathSync.native(backlink) !== fs.realpathSync.native(gitfile)) throw new Error('worktree backlink changed')
  return { adminDir, common }
}

/** Called immediately after our successful add, before publishing creation in the journal. */
export function witnessPreparation(dir: string, branch: string, identity: PreparationIdentity): PreparationWitness {
  const { adminDir } = adminOf(dir), stat = fs.statSync(adminDir, { bigint: true })
  const witness: PreparationWitness = { v: 1, ...identity, branch, adminDir, dev: String(stat.dev), ino: String(stat.ino), token: randomUUID() }
  fs.writeFileSync(path.join(adminDir, PREPARATION_WITNESS_FILE), JSON.stringify(witness), { flag: 'wx', mode: 0o600 })
  verifyPreparation(dir, witness)
  return witness
}

/** No guessed flag, stale pathname, symlinked marker or unreadable evidence can satisfy this proof. */
export function verifyPreparation(dir: string, expected: PreparationIdentity & { branch: string; adminDir?: string; token?: string }, commonDir?: string): PreparationWitness {
  try {
    const { adminDir, common } = adminOf(dir)
    if (commonDir && fs.realpathSync.native(commonDir) !== common) throw new Error('worktree belongs to another clone')
    const value = JSON.parse(smallFile(path.join(adminDir, PREPARATION_WITNESS_FILE))) as Partial<PreparationWitness>
    const stat = fs.statSync(adminDir, { bigint: true })
    if (value.v !== 1 || value.id !== expected.id || value.nonce !== expected.nonce || value.branch !== expected.branch
      || typeof value.token !== 'string' || !value.token || value.adminDir !== adminDir || value.dev !== String(stat.dev) || value.ino !== String(stat.ino)
      || expected.adminDir && expected.adminDir !== adminDir || expected.token && expected.token !== value.token)
      throw new Error('missing or mismatched worktree witness')
    if (trimLine(smallFile(path.join(adminDir, 'HEAD'))) !== `ref: refs/heads/${expected.branch}`) throw new Error('worktree branch changed')
    return value as PreparationWitness
  } catch (error) {
    throw new Error(`kept preparation ${dir}: cannot verify its worktree identity (${error instanceof Error ? error.message : String(error)})`)
  }
}

/** Verification and Git removal are adjacent, but are not an atomic filesystem transaction. */
export function removePreparation(commonDir: string, dir: string, expected: PreparationIdentity & { branch: string; adminDir?: string; token?: string }, removeBranch: boolean): void {
  const run = (args: string[]) => boundedGitSync(commonDir, ['--git-dir', commonDir, '-c', 'core.hooksPath=/dev/null', ...args]).toString()
  verifyPreparation(dir, expected, commonDir)
  run(['worktree', 'remove', '--force', dir])
  // The branch must be the branch of the checkout just verified and removed. Git also refuses
  // deletion if another worktree has since checked it out. This is still not atomic with removal.
  if (removeBranch) run(['branch', '-D', expected.branch])
}
