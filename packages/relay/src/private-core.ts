/** Dependency-free directory policy, also emitted as hooks/private-core.mjs by build-plugin. */
import fs from 'node:fs'
import path from 'node:path'

export function privateDirectoryPath(dir: string): { directories: string[]; root: string; inState: boolean } {
  dir = path.resolve(dir)
  const directories = [dir]
  let root = dir
  while (path.basename(root) !== 'room' && path.dirname(root) !== root) {
    root = path.dirname(root)
    directories.unshift(root)
    if (directories.length > 64) throw new Error(`Room state directory path is too deep: ${dir}`)
  }
  return { directories, root, inState: path.basename(root) === 'room' }
}

export function verifyPosixPath(file: string, stat = fs.lstatSync(file)): void {
  if (stat.isSymbolicLink() || !process.getuid || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Room state must be owned by the current user and private: ${file}`)
  }
}

/** POSIX repairs only an owned directory through a no-follow descriptor. On Windows this is deliberately
 * plain creation: hooks initially inherit the Git directory ACL. The MCP/daemon's first root inspection
 * protects room/ and normalizes existing descendants; subsequent plain children inherit that private ACL. */
export function initializePrivateDirectory(dir: string, repair: boolean, exclusive = false): void {
  let created = false
  try { fs.mkdirSync(dir, { mode: 0o700 }); created = true }
  catch (error) { if (exclusive || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Room state path must be a directory, not a symlink or junction: ${dir}`)
  if (process.platform === 'win32') return
  if (!process.getuid || stat.uid !== process.getuid()) throw new Error(`Room state must be owned by the current user and private: ${dir}`)
  if (created || repair && (stat.mode & 0o777) !== 0o700) {
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY)
    try {
      const opened = fs.fstatSync(fd)
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.uid !== process.getuid()) throw new Error(`Room state must be owned by the current user and private: ${dir}`)
      fs.fchmodSync(fd, 0o700)
    } finally { fs.closeSync(fd) }
    if (!created) console.error(`Room repaired private state directory: ${dir}`)
  }
  verifyPosixPath(dir)
}
