/** Remove only resolved ownership bookkeeping, never the item it once described. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { retainedWorkerItemPresent, type RetainedWorkerItem } from './worker-retained.js'

export function collectResolvedWorkerMetadata(common: string, dryRun = false): string[] {
  const removed: string[] = []
  for (const kind of ['retained', 'ref-writes'] as const) {
    const dir = path.join(common, 'room', 'registry', kind)
    let names: string[]
    try {
      if (![path.join(common, 'room'), path.join(common, 'room/registry'), dir].every(at => fs.lstatSync(at).isDirectory())) continue
      names = fs.readdirSync(dir)
    } catch { continue }
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const file = path.join(dir, name)
      try {
        const stat = fs.lstatSync(file)
        if (!stat.isFile() || stat.size > 16384) continue
        const bytes = fs.readFileSync(file, 'utf8'), value = JSON.parse(bytes)
        if (kind === 'retained') {
          const item = value as RetainedWorkerItem
          if (!['directory', 'file', 'registration', 'worktree', 'ref', 'branch'].includes(item.kind) || typeof item.path !== 'string' || typeof item.reason !== 'string'
            || createHash('sha256').update(item.kind + '\0' + item.path).digest('hex') + '.json' !== name) continue
          if (retainedWorkerItemPresent(common, item)) continue
        } else {
          if (typeof value.owner !== 'string' || !value.owner || typeof value.oid !== 'string' || !/^[a-f0-9]{40,64}$/.test(value.oid)
            || typeof value.ref !== 'string' || !/^refs\/(heads|room)\/[A-Za-z0-9._/-]+$/.test(value.ref)
            || value.ref.includes('..') || createHash('sha256').update(value.ref).digest('hex') + '.json' !== name) continue
          if (retainedWorkerItemPresent(common, { kind: 'ref', path: value.ref, reason: '' })) continue
        }
        if (fs.readFileSync(file, 'utf8') !== bytes) continue
        if (!dryRun) fs.unlinkSync(file)
        removed.push(file)
      } catch { /* malformed, unreadable or concurrently replaced metadata is retained */ }
    }
  }
  return removed
}
