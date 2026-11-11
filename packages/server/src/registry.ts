import type { OpenRepo } from './store.js'
import { archiveOwnerOf, parseRoomName, parseLegacyRoomName } from './names.js'
import { servedBy016 } from './inventory.js'

/** Existing archives retained by a completed schema-2 repository; never another registered room. */
export function archiveDocumentNames(repo: string, entry: OpenRepo, docs: string[], registered: ReadonlySet<string> = new Set()): string[] {
  const parsed = parseRoomName(repo, true)
  if (!parsed || parsed.repo !== repo) return []
  const recorded = new Set([...entry.branches, ...(entry.legacy ?? []), ...(entry.plan?.sources ?? [])])
  return [...new Set([...recorded, ...docs])].filter(name => {
    if (name === repo || registered.has(name) && parseRoomName(name)?.repo !== repo) return false
    if (name.startsWith('archive:')) return recorded.has(name) && archiveOwnerOf(name) === repo
    const source = parseLegacyRoomName(name)
    if (!source || !servedBy016(name)) return false
    if (!parsed.github && [...registered].some(key => key.startsWith(`${repo}/`) && (name === key || name.startsWith(`${key}/`)))) return false
    return parsed.github ? source.repo === repo : recorded.has(name) && name.startsWith(`${repo}/`)
  })
}

export function closeDocumentNames(repo: string, entry: OpenRepo, registered: ReadonlySet<string> = new Set()): string[] {
  return [repo, ...archiveDocumentNames(repo, entry, [], registered)]
}

/** Accept only completed schema-2 registries before any stored document can be loaded or rewritten. */
export function safeRoomRegistry(all: Record<string, OpenRepo>): Record<string, OpenRepo> {
  for (const [key, entry] of Object.entries(all)) {
    const parsed = parseRoomName(key, true)
    if (!parsed || parsed.repo !== key || entry.mode !== 'repo' || !entry.migratedAt)
      throw new Error(`Room 0.16 state or unfinished migration at ${JSON.stringify(key)} is refused; use v0.17.47, the last release that can migrate, before upgrading`)
  }
  const valid = new Set(Object.keys(all))
  return Object.fromEntries(Object.entries(all).map(([key, value]) => {
    const keep = new Set(archiveDocumentNames(key, value, [], valid))
    return [key, { ...value, branches: (value.branches ?? []).filter(s => keep.has(s)),
      legacy: (value.legacy ?? []).filter(s => keep.has(s)),
      ...(value.plan ? { plan: { ...value.plan, sources: value.plan.sources.filter(s => keep.has(s)),
        ...(value.plan.moved && archiveOwnerOf(value.plan.moved) !== key ? { moved: undefined } : {}) } } : {}) }]
  }))
}
