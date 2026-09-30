/** Read-only inventory of stored documents against the room registry: what 0.17 migrates, what it leaves.
 *  Shared by the server (startup log, admin endpoint) and scripts/room-inventory.mts (operator pre-flight). */
import type { OpenRepo } from './store.js'
import { levelOversizedTables, type levelStoredTables, type StoredSize } from './stored.js'
import { archiveOwnerOf, parseRoomName, parseLegacyRoomName } from './names.js'

export type DocKind =
  | 'canonical'     // the repository's schema-2 room (or the 0.16 bare-repo room it replaces)
  | 'served'        // a 0.16.40 branch room: migrated
  | 'archive'       // a migration archive owned by the repository
  | 'never-served'  // an older encoded key 0.16.40 could not reach: left in place, never loaded
  | 'unregistered'  // no registry entry owns it: left in place, never loaded
interface InventoryDoc extends StoredSize { name: string; repo?: string; kind: DocKind; reason?: string }
export interface Inventory { budgetBytes: number; docs: InventoryDoc[]; tables: ReturnType<typeof levelOversizedTables> }

/** 0.16.40 admitted literal repo prefixes; three decodes could still leave '%' in a suffix. */
export function servedBy016(name: string): boolean {
  const parsed = parseLegacyRoomName(name)
  return !!parsed && (!parsed.github || /^github\.com\/([^/]+)\/([^/]+)\/(.+)$/i.test(name))
}

/** Which registered repository, if any, owns a stored document, and in what role. */
export function classifyDoc(name: string, registry: Readonly<Record<string, OpenRepo>>): { repo?: string; kind: DocKind; reason?: string } {
  const repos = new Map(Object.entries(registry).flatMap(([key, entry]) => {
    const parsed = parseRoomName(key, true)
    return parsed ? [[parsed.repo, entry] as const] : []
  }))
  if (name.startsWith('archive:')) {
    const owner = archiveOwnerOf(name)
    const entry = owner ? repos.get(owner) : undefined
    return entry && [...entry.legacy ?? [], ...entry.plan?.sources ?? []].includes(name) || owner && entry?.plan?.moved === name
      ? { repo: owner, kind: 'archive' } : { repo: owner, kind: 'unregistered', reason: 'archive key no registry entry records' }
  }
  const historical = parseLegacyRoomName(name), parsed = historical ?? parseRoomName(name)
  if (!parsed) return { kind: 'unregistered', reason: 'not a room name' }
  const recorded = (entry: OpenRepo) => entry.branches.includes(name) || !!entry.legacy?.includes(name) || !!entry.plan?.sources.includes(name)
  const repo = parsed.github ? (repos.has(parsed.repo) ? parsed.repo : undefined)
    : [...repos].find(([key, entry]) => name === key || name.startsWith(`${key}/`) && recorded(entry))?.[0]
  if (!repo) return { repo: parsed.github ? parsed.repo : undefined, kind: 'unregistered', reason: 'no registry entry for this repository' }
  if (name === repo) return { repo, kind: 'canonical' }
  if (!servedBy016(name)) return { repo, kind: 'never-served', reason: 'encoded or invalid literal repository prefix; 0.16.40 could not admit this stored key' }
  return { repo, kind: 'served' }
}

/** Sizes every document with an early exit at the budget; nothing is loaded into a Y.Doc. */
export async function takeInventory(names: Iterable<string>, registry: Readonly<Record<string, OpenRepo>>,
  size: (name: string, limit: number) => Promise<StoredSize>, budgetBytes: number, tables?: Awaited<ReturnType<typeof levelStoredTables>>): Promise<Inventory> {
  const docs: InventoryDoc[] = []
  for (const name of [...new Set(names)].sort()) {
    const found = classifyDoc(name, registry)
    const measured = await size(name, budgetBytes)
    const reason = found.reason ?? measured.reason ?? (measured.over && (found.kind === 'served' || found.kind === 'canonical')
      ? 'over the per-document load budget: kept as an archive without loading' : undefined)
    docs.push({ name, ...found, ...measured, ...(reason ? { reason } : {}) })
  }
  return { budgetBytes, docs, tables: levelOversizedTables(tables, budgetBytes) }
}

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`
/** One line per document, grouped by repository; problems are marked with `!`. */
export function formatInventory(inventory: Inventory): string {
  const lines = [`budget: ${mb(inventory.budgetBytes)} stored per document`]
  const groups = new Map<string, InventoryDoc[]>()
  for (const doc of inventory.docs) {
    const key = doc.kind === 'unregistered' ? '(unregistered)' : doc.repo!
    groups.set(key, [...groups.get(key) ?? [], doc])
  }
  for (const [repo, docs] of [...groups].sort(([a], [b]) => a === '(unregistered)' ? 1 : b === '(unregistered)' ? -1 : a.localeCompare(b))) {
    lines.push(repo)
    for (const doc of docs) {
      const flag = doc.over || doc.kind === 'never-served' || doc.kind === 'unregistered' ? '!' : ' '
      lines.push(`  ${flag} ${doc.kind.padEnd(12)} ${(doc.over ? `>${mb(doc.bytes)}` : mb(doc.bytes)).padStart(10)} ${String(doc.updates).padStart(6)} upd  ${JSON.stringify(doc.name)}${doc.reason ? `  (${doc.reason})` : ''}`)
    }
  }
  const problems = inventory.docs.filter(doc => doc.over || doc.kind === 'never-served' || doc.kind === 'unregistered').length
  if (inventory.tables.length) {
    lines.push('tables over budget:')
    for (const table of inventory.tables) lines.push(`  ! level ${table.level} file ${table.file}: ${mb(table.bytes)}  ${JSON.stringify(table.smallest)} .. ${JSON.stringify(table.largest)}`)
  }
  lines.push(`${inventory.docs.length} document(s); ${problems} flagged`)
  if (inventory.tables.length) lines.push(`${inventory.tables.length} table(s) over budget; review before deploying`)
  return lines.join('\n')
}
