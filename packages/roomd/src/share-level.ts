/** How much of a person's work reaches the room: plans only, declared files, or every changed file. */
export type ShareLevel = 'intent' | 'declared' | 'full'
export const SHARE_LEVELS: readonly ShareLevel[] = ['intent', 'declared', 'full']
const SHARE_RANK: Record<ShareLevel, number> = { intent: 0, declared: 1, full: 2 }
/** A level from user input; undefined when it is not one. */
export function parseShare(v: unknown): ShareLevel | undefined {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return (SHARE_LEVELS as readonly string[]).includes(s) ? s as ShareLevel : undefined
}
/** The level actually allowed: never above the server ceiling. */
export function clampShare(level: ShareLevel, max: ShareLevel): ShareLevel {
  return SHARE_RANK[level] > SHARE_RANK[max] ? max : level
}
