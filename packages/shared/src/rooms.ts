/** Client-side room name from an already normalized Git origin; explicit names bypass this. */
export function canonicalRepo(originDerived: string): string {
  if (!originDerived.startsWith('github.com/')) return originDerived
  return originDerived.toLowerCase()
}

/** Server-side legacy lookup: an open repo is the longest whole-segment prefix. */
export function repoRoomOf(name: string, isOpen: (repo: string) => boolean): string | undefined {
  let end = name.length
  while (end > 0) {
    const prefix = name.slice(0, end)
    if (isOpen(prefix)) return prefix
    end = name.lastIndexOf('/', end - 1)
  }
  return undefined
}

/** Parse a canonical room name; clients never use this to strip a legacy branch. */
export function roomNameParts(name: string): { repo: string; host?: string; owner?: string; local: boolean } {
  if (name.startsWith('local/')) return { repo: name.slice('local/'.length), local: true }
  const parts = name.split('/')
  const offset = parts[0] === 'git' ? 1 : 0
  if ((parts[0] === 'github.com' || offset === 1) && parts.length >= offset + 3) {
    return { host: parts[offset], owner: parts[offset + 1], repo: parts.slice(offset + 2).join('/'), local: false }
  }
  return { repo: name, local: false }
}

/** Durable local lease identity for one room on one server. */
export function roomKey(server: string | 'local', room: string): string {
  return server === 'local' ? room : `${new URL(server).origin}/${room}`
}
