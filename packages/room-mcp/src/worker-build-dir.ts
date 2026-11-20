/** Disposable output belongs to the worker's own Room state, never to collection. */
import fs from 'node:fs'
import path from 'node:path'
import { git } from '@room/roomd/git'

const IGNORE = '*\n'

/** Only called for a checkout Room created for this worker. No configurable path or inherited env. */
export async function prepareWorkerBuildDir(dir: string, tag: string): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(tag)) throw new Error('invalid worker build directory tag')
  if (!fs.lstatSync(dir).isDirectory()) throw new Error('worker build checkout is not a plain directory')
  const root = fs.realpathSync.native(dir)
  // Refuse tracked state before writing anything, even in a project that tracks .room.
  if ((await git(root, ['ls-files', '-z', '--', '.room/scratch'])).length)
    throw new Error('worker build directory conflicts with tracked .room/scratch files')
  const scratch = path.join(root, '.room', 'scratch')
  const build = path.join(scratch, tag)
  for (const folder of [path.join(root, '.room'), scratch, build]) {
    try { fs.mkdirSync(folder, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    // lstat rejects symlinks and Windows junctions, including a planted ancestor.
    if (!fs.lstatSync(folder).isDirectory()) throw new Error(`worker build directory parent is not a plain directory: ${folder}`)
  }
  fs.accessSync(build, fs.constants.W_OK | fs.constants.X_OK)
  // Ignore the tag directory itself: files generated beneath it cannot unignore their way out.
  // This is local to the worker, and never edits .gitignore or the clone's shared Git excludes.
  const ignore = path.join(scratch, '.gitignore')
  try { fs.writeFileSync(ignore, IGNORE, { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const stat = fs.lstatSync(ignore)
  if (!stat.isFile() || stat.size !== Buffer.byteLength(IGNORE) || fs.readFileSync(ignore, 'utf8') !== IGNORE)
    throw new Error('worker build directory ignore file is not Room\'s expected plain file')
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
