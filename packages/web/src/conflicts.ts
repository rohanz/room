import type { Claim, ConflictSpan, ConflictResolution, Msg } from '@room/shared'

/** Reconstruct conflict history from existing bus facts; never manufacture a timestamp.
 * Missing claims alone are not proof of release (the rolling bus may be incomplete).
 */
export function deriveConflictSpans(messages: readonly Msg[], claims: readonly Claim[], base?: string): ConflictSpan[] {
  const bus = [...messages].sort((a, b) => a.at - b.at)
  const known = new Map<string, Claim>()
  for (const m of bus) if (m.type === 'claim' && !known.has(m.claimId)) known.set(m.claimId, { id: m.claimId, path: m.path, from: m.from_line, to: m.to_line, by: m.from, byKind: m.fromKind, intent: m.intent, plans: m.plans, at: m.at })
  const current = new Map(claims.map(c => [c.id, c]))
  for (const c of claims) if (!known.has(c.id)) known.set(c.id, c)
  const spans: ConflictSpan[] = []
  const pairKey = (path: string, people: string[]) => JSON.stringify([path, [...people].sort()])
  for (const m of bus) {
    let path: string, people: string[], ids: string[] = [], from: number | undefined, to: number | undefined
    if (m.type === 'conflict') {
      path = m.path
      ids = [m.claimId, m.otherClaimId].filter(Boolean).sort()
      people = ids.flatMap(id => known.get(id)?.by ?? [])
      if (people.length < 2) {
        const editor = m.text.match(/^(.+?)'s agent edited /)?.[1] ?? (m.text.startsWith('you edited ') ? m.to : undefined)
        if (editor) people.push(editor)
      }
      const range = m.text.slice(m.text.indexOf(`${path}:`) + path.length + 1).match(/^(\d+)-(\d+)/)
      if (range) { from = Number(range[1]); to = Number(range[2]) }
    } else if (m.type === 'note') {
      const match = m.text.match(/^your (.+) and (.+)'s now conflict around lines? ([\d, ]+);/)
      if (!match || !m.to) continue
      path = match[1]; people = [m.to, match[2]]
      const lines = match[3].split(',').map(Number)
      from = Math.min(...lines); to = Math.max(...lines)
    } else continue
    people = [...new Set(people)].sort()
    const cs = ids.flatMap(id => known.get(id) ?? [])
    if (cs.length === 2) { from = Math.max(...cs.map(c => c.from)); to = Math.min(...cs.map(c => c.to)) }
    const id = ids.length ? JSON.stringify([path, ids]) : pairKey(path, people)
    let span = spans.find(s => s.id === id || (people.length === 2 && pairKey(s.path, s.people) === pairKey(path, people) && ids.length === 0 && s.claimIds.length === 0))
    if (!span) { span = { id, path, people, claimIds: ids, from, to, at: m.at, events: [], claims: cs, hidden: false }; spans.push(span) }
    if (ids.length === 2 && span.claimIds.length < 2) { span.claimIds = ids; span.claims = cs }
    span.events.push(m)
  }
  // Claims can overlap before a conflict notification is delivered.
  for (let i = 0; i < claims.length; i++) for (const b of claims.slice(i + 1)) {
    const a = claims[i]
    if (a.by === b.by || a.path !== b.path || a.from > b.to || b.from > a.to) continue
    const ids = [a.id, b.id].sort(), id = JSON.stringify([a.path, ids])
    const existing = spans.find(s => s.claimIds.join() === ids.join() || (s.claimIds.length === 0 && s.at >= Math.max(a.at, b.at) && pairKey(s.path, s.people) === pairKey(a.path, [a.by, b.by])))
    if (existing && existing.claimIds.length < 2) { existing.claimIds = ids; existing.claims = [a, b] }
    if (!existing) spans.push({ id, path: a.path, people: [a.by, b.by].sort(), claimIds: ids, from: Math.max(a.from, b.from), to: Math.min(a.to, b.to), at: Math.max(a.at, b.at), events: [], claims: [a, b], hidden: false })
  }
  for (const s of spans) {
    const lastConflict = s.events.at(-1)?.at ?? s.at
    for (const m of bus) {
      if (m.at < lastConflict) continue
      let resolution: ConflictResolution | undefined
      if (m.type === 'release' && s.claimIds.includes(m.claimId)) resolution = { how: 'released', who: m.from, at: m.at }
      if (m.type === 'note' && s.claimIds.length === 0 && s.people.some(person => m.to === person && m.text === `your ${s.path} and ${s.people.find(p => p !== person)}'s merge cleanly again`)) resolution = { how: 'merged clean', who: m.to, at: m.at }
      if (m.type === 'base' && base && (m.base === base || bus.some(next => next.type === 'base' && next.at > m.at && next.base === base))) {
        s.hidden = true
        resolution = { how: 'base moved', who: m.from, at: m.at }
      }
      if (resolution) { s.resolvedBy ??= resolution; s.events.push(m) }
    }
    const live = s.claimIds.flatMap(id => current.get(id) ?? [])
    if (!s.resolvedBy && live.length === 2 && (live[0].path !== live[1].path || live[0].from > live[1].to || live[1].from > live[0].to)) {
      const changed = [...live].sort((a, b) => b.at - a.at)[0]
      s.resolvedBy = { how: 'narrowed', who: changed.by, at: Math.max(lastConflict, changed.at) }
    }
    s.claims = s.claimIds.flatMap(id => current.get(id) ?? known.get(id) ?? [])
  }
  return spans
}
