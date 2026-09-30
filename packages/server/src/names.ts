/** Room naming shared by admission, the docs map, closing and expiry: one decoded key everywhere. */
/** Mirrors the shared participant-name rule because the server image is installed standalone. */
export function validParticipantName(name: string): boolean {
  return name.length > 0 && !/[\x00-\x1f\x7f-\x9f]/u.test(name)
}

export function assertValidParticipantName(name: string): void {
  if (!validParticipantName(name)) throw new Error('participant name must be nonempty and contain no control characters')
}

/** The key a websocket request's room is stored under: its decoded name (query string dropped). */
export function docNameOf(reqUrl: string): string { return roomNameOf(reqUrl.split('?')[0]) }
/** Clients encode the room name once or twice; decode until it stops changing. */
export function roomNameOf(roomPath: string): string {
  let name = roomPath.replace(/^\//, '')
  for (let i = 0; i < 3; i++) {
    let next: string
    try { next = decodeURIComponent(name) } catch { break }
    if (next === name) break
    name = next
  }
  return name
}
export interface ParsedRoom { name: string; repo: string; github?: string }
const segment = (part: string) => !!part && part !== '.' && part !== '..' && !/[\x00-\x1f\x7f-\x9f\\?#%]/u.test(part)
/** Reject internal keys and malformed namespaces before admission or document access. */
export function parseRoomName(input: string, schema2 = false): ParsedRoom | undefined {
  const name = roomNameOf(input)
  if (!name || name.length > 512 || name.startsWith('archive:')) return undefined
  const parts = name.split('/')
  if (!parts.every(segment)) return undefined
  if (parts[0]?.toLowerCase() === 'github.com') {
    const owner = parts[1], repository = parts[2]
    if (parts.length < 3 || schema2 && parts.length !== 3 || !owner || !repository ||
      !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(owner) ||
      !/^[a-z0-9_.-]{1,100}$/i.test(repository) || repository === '.' || repository === '..') return undefined
    return { name, repo: `github.com/${owner.toLowerCase()}/${repository.toLowerCase()}`, github: `${owner.toLowerCase()}/${repository.toLowerCase()}` }
  }
  if (parts[0] === 'git' && parts.length >= 3 && /^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(parts[1]!) && !parts[1]!.startsWith('.') && !parts[1]!.endsWith('.'))
    return { name, repo: name }
  if (parts[0] === 'local' && parts.length >= 2) return { name, repo: name }
  return undefined
}
/** Historical stored keys are literal: 0.16 admission split the prefix after at most three decodes.
 *  A triple-encoded request could preserve any suffix, including empty strings and percent escapes. */
export function parseLegacyRoomName(name: string): ParsedRoom | undefined {
  if (name.startsWith('/')) return undefined
  const github = /^github\.com\/([^/]+)\/([^/]+)(?:\/([\s\S]*))?$/i.exec(name)
  if (github) {
    const root = parseRoomName(`github.com/${github[1]}/${github[2]}`, true)
    return root ? { ...root, name } : undefined
  }
  if (!name.startsWith('git/') && !name.startsWith('local/')) return undefined
  const parsed = parseRoomName(name.replaceAll('%', '_'))
  return parsed ? { name, repo: name } : undefined
}
export function archiveOwnerOf(name: string): string | undefined {
  const m = /^archive:(.+):([0-9a-f]{8}-[0-9a-f-]{27,})$/i.exec(name)
  if (!m) return undefined
  const parsed = parseRoomName(m[1], true)
  return parsed?.repo
}
/** "github.com%2Fowner%2Frepo%2Fbranch" (or decoded) -> "owner/repo". A name with no branch is still that GitHub repo:
 *  it must never fall through to the rules for non-GitHub rooms, which do not check push access. */
export function githubRepoOf(roomPath: string): string | undefined {
  return parseRoomName(roomPath)?.github
}
