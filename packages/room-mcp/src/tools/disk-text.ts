import fs from 'node:fs'

/** Local reads use the same per-file ceiling as the default publisher. */
export const DISK_TEXT_LIMIT = 512 * 1024

/** Read from one descriptor, with a hard byte limit even if the file grows after stat. */
export async function readBoundedDiskText(file: string, encoding: BufferEncoding = 'utf8'): Promise<string> {
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('not a file: ' + file)
    if (stat.size > DISK_TEXT_LIMIT) throw new Error(`file too large for Room read (${stat.size} bytes): ${file}`)
    const bytes = Buffer.allocUnsafe(DISK_TEXT_LIMIT + 1)
    let used = 0
    while (used <= DISK_TEXT_LIMIT) {
      const { bytesRead } = await handle.read(bytes, used, Math.min(64 * 1024, bytes.length - used), null)
      if (bytesRead === 0) return bytes.subarray(0, used).toString(encoding)
      used += bytesRead
    }
    throw new Error(`file too large for Room read (over ${DISK_TEXT_LIMIT} bytes): ${file}`)
  } finally { await handle.close() }
}
