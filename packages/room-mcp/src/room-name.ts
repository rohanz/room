/** Room-name normalization with no imports, so worker configuration can use it without loading the session module. */

/** Only GitHub's fixed host/owner/repo shape makes a branch suffix unambiguous. */
export function normalizeExplicitRoomName(name: string, log?: (text: string) => void): string {
  const parts = name.split('/')
  if (parts[0] === 'github.com' && parts.length > 3 && parts[1] && parts[2] && parts.slice(3).every(Boolean)) {
    const canonical = parts.slice(0, 3).join('/').toLowerCase()
    log?.(`room ${name}: branch part ignored because Room 0.17 has one room per repository; joining ${canonical}`)
    return canonical
  }
  return name
}

/**
 * Room 0.16 named a local room after the main worktree's branch: `local/<main worktree basename>/<branch>`
 * (roomd localRoomName; `detached` off a branch). A name of that shape is a 0.16 per-branch room and maps to the
 * 0.17 repository room `local/<basename>`; anything else (`local/experiments`, another repository's prefix) is a
 * custom name. A custom name deliberately shaped like `local/<basename>/<x>` cannot be told apart, so only
 * choices written before 0.17 are tested against this (choice.ts marks 0.17 writes).
 */
export function legacyLocalBranchRoom(room: string, mainBase: string): string | undefined {
  const repo = `local/${mainBase}`
  const branch = room.startsWith(`${repo}/`) ? room.slice(repo.length + 1) : ''
  return branch && !branch.startsWith('/') && !branch.endsWith('/') && !branch.includes('//') ? repo : undefined
}
