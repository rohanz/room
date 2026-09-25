/** Exclusive files shared by local Room processes. Stale removal is serialized by a
 * second owned file, so two readers of the same dead owner cannot delete a successor. */
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { pidAlive } from './workers.js'

function ownerPid(file: string): number | undefined {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const plainPid = /^\d+$/.test(raw.trim())
    const value: unknown = plainPid ? Number(raw.trim()) : JSON.parse(raw)
    const pid = plainPid ? value
      : value && typeof value === 'object' && 'pid' in value ? value.pid : undefined
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  } catch { return undefined }
}

/** Acquire once. A missing parent directory is the caller's responsibility. */
export function acquireOwnedFile(file: string, record: { pid: number } & Record<string, unknown>): (() => void) | undefined {
  const token = JSON.stringify({ ...record, nonce: randomUUID() })
  const create = (): (() => void) | undefined => {
    let fd: number
    try { fd = fs.openSync(file, 'wx', 0o600) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return undefined; throw e }
    try { fs.writeFileSync(fd, token) }
    catch (e) { try { fs.unlinkSync(file) } catch { /* preserve original write error */ } throw e }
    finally { fs.closeSync(fd) }
    return () => {
      try { if (fs.readFileSync(file, 'utf8') === token) fs.unlinkSync(file) }
      catch { /* already removed */ }
    }
  }

  const release = create()
  if (release) return release
  const owner = ownerPid(file)
  if (owner === undefined || pidAlive(owner)) return undefined

  // A stale guard is recovered under its own guard, recursively. This terminates
  // at the first absent guard and avoids a second stale-guard unlink race.
  const releaseGuard = acquireOwnedFile(`${file}.recover`, { pid: process.pid })
  if (!releaseGuard) return undefined
  try {
    const current = ownerPid(file)
    if (current === undefined || pidAlive(current)) return undefined
    try { fs.unlinkSync(file) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    return create()
  } finally { releaseGuard() }
}
