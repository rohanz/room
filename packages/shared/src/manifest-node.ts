import { createHash } from 'node:crypto'
import { normalizeCoordinationPath } from './near.js'

/** Path digests contain no path bytes and use the room's decoded 32-byte salt. */
export function digestPath(roomSalt: string, path: string): string {
  if (!/^[a-f0-9]{64}$/i.test(roomSalt)) throw new Error('invalid roomSalt')
  return createHash('sha256').update(Buffer.from(roomSalt, 'hex')).update(normalizeCoordinationPath(path), 'utf8').digest('hex')
}

export function gitBlobHash(text: string, format: 'sha1' | 'sha256' = 'sha1'): string {
  const bytes = Buffer.from(text)
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}
