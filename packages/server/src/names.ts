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
  let name = roomPath.replace(/^\/+/, '')
  for (let i = 0; i < 3; i++) {
    let next: string
    try { next = decodeURIComponent(name) } catch { break }
    if (next === name) break
    name = next
  }
  return name
}
/** "github.com%2Fowner%2Frepo%2Fbranch" (or decoded) -> "owner/repo". A name with no branch is still that GitHub repo:
 *  it must never fall through to the rules for non-GitHub rooms, which do not check push access. */
export function githubRepoOf(roomPath: string): string | undefined {
  const name = roomNameOf(roomPath)
  const m = name.match(/^github\.com\/([^/]+)\/([^/]+)(?:\/|$)/)
  return m ? `${m[1]}/${m[2]}` : undefined
}


/** "github.com/owner/repo/feature/x" -> "github.com/owner/repo"; "git/host/owner/repo/main" -> 4 segments; "local/dir/main" -> "local/dir". */
export function repoOf(roomName: string): string {
  const parts = roomName.split('/')
  return parts.slice(0, roomName.startsWith('github.com/') ? 3 : roomName.startsWith('git/') ? 4 : 2).join('/')
}
