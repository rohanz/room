/** Read-only admin inventory of canonical rooms, retained archives and unknown stored documents. */
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
  return !!parsed
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
      ? 'over the per-document load budget: never loaded' : undefined)
    docs.push({ name, ...found, ...measured, ...(reason ? { reason } : {}) })
  }
  return { budgetBytes, docs, tables: levelOversizedTables(tables, budgetBytes) }
}
