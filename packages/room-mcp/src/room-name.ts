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
