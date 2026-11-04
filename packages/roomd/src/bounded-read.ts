import fs from 'node:fs'

/** A control or probe file exceeded its explicit read limit; callers must not treat it as absent. */
class FileTooLarge extends Error {
  readonly code = 'ROOM_FILE_TOO_LARGE'
  constructor(readonly file: string, readonly limit: number) { super(`file too large for Room read (over ${limit} bytes): ${file}`) }
}

/**
 * Read a small regular file through one descriptor, never more than `limit` bytes. Symbolic links are refused
 * (ELOOP); a missing file keeps its ENOENT so callers can tell absence from an unreadable or oversized file.
 */
export function readBoundedFileSync(file: string, limit: number): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw Object.assign(new Error(`not a regular file: ${file}`), { code: 'ROOM_NOT_A_FILE' })
    if (stat.size > limit) throw new FileTooLarge(file, limit)
    const bytes = Buffer.allocUnsafe(limit + 1)
    let used = 0
    while (used <= limit) {
      const count = fs.readSync(fd, bytes, used, Math.min(64 * 1024, bytes.length - used), null)
      if (count === 0) return bytes.subarray(0, used).toString('utf8')
      used += count
    }
    throw new FileTooLarge(file, limit)
  } finally { fs.closeSync(fd) }
}
