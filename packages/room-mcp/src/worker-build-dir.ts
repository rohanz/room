/** Disposable output belongs to the worker's own Room state, never to collection. */
import fs from 'node:fs'
import path from 'node:path'
import { git } from '@room/roomd/git'

const IGNORE = '*\n'

/** Only called for a checkout Room created for this worker. No configurable path or inherited env. */
export async function prepareWorkerBuildDir(dir: string, tag: string): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(tag)) throw new Error('invalid worker build directory tag')
  if (!(await fs.promises.lstat(dir)).isDirectory()) throw new Error('worker build checkout is not a plain directory')
  const root = await fs.promises.realpath(dir)
  // Refuse tracked state before writing anything, even in a project that tracks .room.
  if ((await git(root, ['ls-files', '-z', '--', '.room/scratch'])).length)
    throw new Error('worker build directory conflicts with tracked .room/scratch files')
  const scratch = path.join(root, '.room', 'scratch')
  const build = path.join(scratch, tag)
  // Ordinary checkout output inherits the already protected worker root. It stores no
  // Room credentials/registry state and needs no additional private-state ACL queries.
  for (const folder of [path.join(root, '.room'), scratch, build]) {
    try { await fs.promises.mkdir(folder, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const stat = await fs.promises.lstat(folder)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`worker build directory parent is not a plain directory: ${folder}`)
  }
  await fs.promises.access(build, fs.constants.W_OK | fs.constants.X_OK)
  // Ignore the tag directory itself: files generated beneath it cannot unignore their way out.
  // This is local to the worker, and never edits .gitignore or the clone's shared Git excludes.
  const ignore = path.join(scratch, '.gitignore')
  try { await fs.promises.writeFile(ignore, IGNORE, { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const stat = await fs.promises.lstat(ignore)
  if (!stat.isFile() || stat.size !== Buffer.byteLength(IGNORE))
    throw new Error('worker build directory ignore file is not Room\'s expected plain file')
  const handle = await fs.promises.open(ignore, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat(), content = Buffer.alloc(Buffer.byteLength(IGNORE) + 1)
    if (!opened.isFile() || opened.size !== Buffer.byteLength(IGNORE) || opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw new Error('worker build directory ignore file changed')
    const { bytesRead } = await handle.read(content, 0, content.length, 0)
    if (content.subarray(0, bytesRead).toString() !== IGNORE)
      throw new Error('worker build directory ignore file is not Room\'s expected plain file')
  } finally { await handle.close() }
  // Check the actual repository's ignore policy, rather than assuming a project ignores .room.
  await git(root, ['check-ignore', '-q', '--', `.room/scratch/${tag}/`])
  return build
}

export function workerBuildDirNote(buildDir?: string, unavailableReason?: string): string {
  return buildDir
    ? `Your build and scratch directory is ${buildDir} (WORKER_BUILD_DIR). Use it for disposable output. Room guarantees it is Git-ignored, never carried or collected, and deletes it with your worktree; put deliverables elsewhere in the worktree.`
    : unavailableReason
      ? `No build directory is available (${unavailableReason}). WORKER_BUILD_DIR is unset; choose your own output location inside the worktree.`
      : 'No build directory is provided for a supplied dir= checkout; Room leaves its files alone. Choose your own output location there.'
}
