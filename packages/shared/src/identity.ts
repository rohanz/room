import type { Identity, Kind } from './types.js'

/** Join-order slots. Ordered so the first few participants are far apart in hue (blue, orange,
 *  purple, green, red, magenta, teal, brown); every colour reads on both the light and dark grounds. */
export const PALETTE = ['#2e86de', '#c9761a', '#6d4fc2', '#27ae60', '#c0392b', '#b5179e', '#0f8b8d', '#8d6e63'] as const
export interface ColorAssignments { colors: { get(name: string): number | undefined } }

/** Use the room's join-order slot when available, with the stable hash for older/offline callers. */
export function colorFor(name: string, room?: ColorAssignments | number): string {
  const assigned = typeof room === 'object' ? room.colors.get(name) : undefined
  if (assigned !== undefined && Number.isInteger(assigned)) return PALETTE[((assigned % PALETTE.length) + PALETTE.length) % PALETTE.length]
  // FNV-1a; a weak hash collides on short names ("Rohan"/"Kieran" did).
  let h = 0x811c9dc5
  for (const ch of name) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0 }
  // final avalanche so short names spread across the palette
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15
  return PALETTE[(h >>> 0) % PALETTE.length]
}

/** Anything that is not a human acts like an agent: claims, wakes, "not me" in inbox rules. */
export function isAgentic(kind: Kind | undefined): boolean {
  return kind !== undefined && kind !== 'human'
}

export function displayName(id: Identity | { name: string; kind: Kind }): string {
  const owner = 'owner' in id ? id.owner : undefined
  const label = 'label' in id ? id.label : undefined
  switch (id.kind) {
    case 'agent': return id.name.includes('+') ? id.name : `${owner ?? id.name}'s agent`
    case 'bot': return `${label ?? id.name} [bot]`
    case 'ci': return `${label ?? id.name} [ci]`
    default: return id.name
  }
}

/** One line for participant lists: "rohanz+codex · agent of rohanz · codex". */
export function describeIdentity(id: Identity): string {
  const parts = [displayName(id)]
  if (id.kind !== 'human' && !(id.kind === 'agent' && !id.name.includes('+'))) parts.push(id.owner && id.owner !== id.name ? `${id.kind} of ${id.owner}` : id.kind)
  if (id.label) parts.push(id.label)
  return parts.join(' · ')
}

export function newId(prefix = ''): string {
  const r = Math.random().toString(36).slice(2, 8)
  return `${prefix}${Date.now().toString(36)}${r}`
}
