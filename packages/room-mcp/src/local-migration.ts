/** One-time, local-only migration of 0.16 hook records. Message seen/shown fields are never receipts. */
import fs from 'node:fs'
import path from 'node:path'
import { writeAtomic } from './leases.js'

const legacyName = (name: string): boolean =>
  ['room-hook-seen.json', 'room-state.json', 'room-session.json', 'room-hook-activity.json'].includes(name)
  || /^room-write-intents-.*\.json$/.test(name) || name.endsWith('.notice-lock')

function readObject(file: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

/** Called after host binding is known; crashes replay without importing uncertain message receipts. */
export function migrateLocalState(legacyDir: string, sessionDir: string, sessionId: string, registryDir?: string): boolean {
  const record = readObject(path.join(legacyDir, 'room-session.json'))
  if (record?.session_id !== sessionId) return true
  // A legacy worker's own session file grants its resume capability during registry import.
  // Preserve it until that import has durably completed, then retry on the next bound access.
  if (record.worker_id && registryDir && readObject(path.join(registryDir, 'migration.json'))?.done !== true) return false
  const oldHook = readObject(path.join(legacyDir, 'room-hook-seen.json'))
  if (oldHook) {
    const file = path.join(sessionDir, 'hook.json')
    const existing = readObject(file) ?? {}
    const imported: Record<string, unknown> = {}
    for (const field of ['companyTold', 'near', 'claims'] as const) {
      const value = oldHook[field]
      if (field === 'companyTold' ? typeof value === 'boolean' : value && typeof value === 'object' && !Array.isArray(value)) imported[field] = value
    }
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
    writeAtomic(file, { ...imported, ...existing })
  }
  for (const name of fs.readdirSync(legacyDir)) {
    if (!legacyName(name)) continue
    fs.renameSync(path.join(legacyDir, name), path.join(legacyDir, `${name}.migrated`))
  }
  return true
}
