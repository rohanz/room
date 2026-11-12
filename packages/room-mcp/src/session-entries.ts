import fs from 'node:fs'
import path from 'node:path'

export type SessionEntry = { kind: 'directory'; path: string } | { kind: 'issue'; path: string; message: string }

/**
 * Whether every folder from `root` (exclusive) down to `dir` (inclusive) is a real directory, read without following
 * links. A missing folder means nothing below it exists; a link or special entry is an issue, never an empty folder.
 */
function directoryChain(root: string, dir: string): { state: 'present' | 'absent' } | { state: 'issue'; message: string } {
  const relative = path.relative(root, dir)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { state: 'issue', message: `${dir} is outside ${root}` }
  let current = root
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part)
    try {
      const stat = fs.lstatSync(current)
      if (!stat.isDirectory()) return { state: 'issue', message: `${current} must be a directory, not a ${stat.isSymbolicLink() ? 'symlink' : 'file or special entry'} (Room never follows links in its state)` }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' }
      return { state: 'issue', message: `Cannot inspect ${current}: ${(error as NodeJS.ErrnoException).code ?? String(error)}` }
    }
  }
  return { state: 'present' }
}

/** Never follow a session entry link. Regular clone-wide files make no session claim. */
export function sessionEntries(root: string, within = path.dirname(path.dirname(root))): SessionEntry[] {
  const result: SessionEntry[] = []
  const chain = directoryChain(within, root)
  if (chain.state === 'issue') return [{ kind: 'issue', path: root, message: chain.message }]
  if (chain.state === 'absent') return []
  try {
    const names = fs.readdirSync(root).sort()
    if (names.length > 4096) result.push({ kind: 'issue', path: root, message: `Inventory exceeds 4096 records at ${root}; session inspection is incomplete` })
    for (const name of names.slice(0, 4096)) {
      const file = path.join(root, name)
      try {
        const stat = fs.lstatSync(file)
        if (stat.isDirectory()) result.push({ kind: 'directory', path: file })
        else if (!stat.isFile()) result.push({ kind: 'issue', path: file, message: `Session entry ${file} is a ${stat.isSymbolicLink() ? 'symlink' : 'special file'}; inspect it before using Room (Room never follows links in its state)` })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.push({ kind: 'issue', path: file, message: `Cannot inspect ${file}: ${(error as NodeJS.ErrnoException).code ?? String(error)}` })
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.push({ kind: 'issue', path: root, message: `Cannot list ${root}: ${(error as Error).message}` })
  }
  return result
}
