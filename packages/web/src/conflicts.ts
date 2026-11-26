import { openConflicts, type RoomDoc, type OpenConflict, type ConflictSlot } from '@room/shared'

/** One card per directed fact, in the query's stable identity order. No check timestamp controls layout. */
export function currentConflicts(room: RoomDoc): OpenConflict[] {
  return openConflicts(room).filter(c => c.owner === c.slots[0]?.owner)
}

/** Snapshot coordinates are explanatory text only, always qualified by their source. */
export function conflictLocationText(slot: ConflictSlot): string[] {
  const out: string[] = []
  if (slot.lines?.length && (slot.kind === 'merge' || slot.kind === 'edit-in-claim')) out.push(slot.kind === 'merge'
    ? 'Evaluated merge-result lines in ' + slot.path + ': ' + slot.lines.join(', ')
    : 'Evaluated lines in ' + slot.owner + "'s " + slot.path + ': ' + slot.lines.join(', '))
  const ranges = (values: { from: number; to: number }[]) => values.map(r => r.from === r.to ? String(r.from) : r.from + '-' + r.to).join(', ')
  if (slot.kind === 'claims' && slot.evaluatedRanges?.length)
    out.push('Evaluated ranges in ' + slot.owner + "'s " + slot.path + ': ' + ranges(slot.evaluatedRanges))
  if (slot.kind === 'edit-in-claim' && slot.claimRanges?.length)
    out.push('Evaluated claim lines in ' + slot.other + "'s " + slot.path + ': ' + ranges(slot.claimRanges))
  return out
}
