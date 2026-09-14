/**
 * Pull requests as intent. Open PRs targeting the room's branch are mirrored into the doc as
 * synthetic bot participants (`pr#<n>`, owned by the PR author) with a scope built from the
 * files the PR touches, so room_impact, area ledgers and claim notes see them like any other
 * declared work. Exactly one client maintains them (the lexicographically lowest present
 * participant). The reverse direction renders the branch's room story as markdown for a
 * comment on the PR (room_pr_note / room_done pr_note).
 */
import type { RoomDoc, Msg, Identity, Claim, ClaimMsg, ReleaseMsg, AnswerMsg } from '@room/shared'
import { displayName, formatPlans } from '@room/shared'
import { authFor, type Session } from './session.js'

export interface PrInfo {
  number: number
  title: string
  author: string
  head: string
  files: string[]
  updatedAt: string
  url: string
}

export const PR_PREFIX = 'pr#'
export const isPrName = (name: string): boolean => name.startsWith(PR_PREFIX)
export const prName = (number: number): string => `${PR_PREFIX}${number}`
export function prIdentity(pr: PrInfo): Identity {
  return { name: prName(pr.number), kind: 'bot', owner: pr.author, label: `PR #${pr.number}` }
}

/** The area a PR belongs to: the most common top-level directory of its files ("root" for bare files). */
export function prArea(files: string[]): string {
  const counts = new Map<string, number>()
  for (const f of files) {
    const seg = f.includes('/') ? f.slice(0, f.indexOf('/')) : 'root'
    counts.set(seg, (counts.get(seg) ?? 0) + 1)
  }
  let best = 'root', n = 0
  for (const [seg, c] of counts) if (c > n || (c === n && seg < best)) { best = seg; n = c }
  return best.toLowerCase()
}

const prMap = (room: RoomDoc) => room.doc.getMap<PrInfo>('prs')

/** Open PRs currently mirrored in the doc, by number. */
export function openPrs(room: RoomDoc): PrInfo[] {
  return Array.from(prMap(room).values()).sort((a, b) => a.number - b.number)
}
export function prInfo(room: RoomDoc, name: string): PrInfo | undefined { return prMap(room).get(name) }

/** Mirror `prs` into the doc: one scope + one metadata entry per PR; entries for closed PRs go. */
export function syncPrs(room: RoomDoc, prs: PrInfo[], origin?: unknown): { added: number[]; updated: number[]; removed: number[] } {
  const map = prMap(room)
  const keep = new Set(prs.map(p => prName(p.number)))
  const added: number[] = [], updated: number[] = [], removed: number[] = []
  room.doc.transact(() => {
    for (const pr of prs) {
      const name = prName(pr.number)
      const prev = map.get(name)
      if (prev && prev.updatedAt === pr.updatedAt && prev.title === pr.title && sameList(prev.files, pr.files)) continue
      map.set(name, pr)
      room.scopes.set(name, { by: name, byKind: 'bot', area: prArea(pr.files), summary: `PR #${pr.number}: ${pr.title}`, paths: pr.files, at: Date.parse(pr.updatedAt) || Date.now() })
      ;(prev ? updated : added).push(pr.number)
    }
    for (const name of Array.from(map.keys())) {
      if (keep.has(name)) continue
      map.delete(name)
      room.scopes.delete(name)
      removed.push(Number(name.slice(PR_PREFIX.length)))
    }
    for (const name of Array.from(room.scopes.keys())) if (isPrName(name) && !keep.has(name)) room.scopes.delete(name)
  }, origin)
  return { added, updated, removed }
}
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** Who maintains the PR mirror: the lowest present participant name (so four clients do not fight). */
export function prLeader(present: string[]): string | undefined {
  return present.filter(n => !isPrName(n)).sort()[0]
}

const httpOf = (server: string) => server.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
const query = (o: Record<string, string | undefined>) => Object.entries(o).filter((e): e is [string, string] => !!e[1]).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')

/** GET /github/prs on the session's server: open PRs targeting this room's branch. */
export async function fetchPrs(s: Session): Promise<PrInfo[]> {
  const a = await authFor(s)
  const res = await fetch(`${httpOf(a.server)}/github/prs?${query({ room: s.roomName, session: a.session, gh: a.gh, token: a.token })}`, { signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`${a.server} would not list pull requests: ${(await res.text()).trim() || `HTTP ${res.status}`}`)
  return await res.json() as PrInfo[]
}

/** POST /github/pr-note: the server posts or updates the one room comment on the PR as the logged-in user. */
export async function postPrNote(s: Session, number: number, body: string): Promise<{ url: string; updated: boolean }> {
  const a = await authFor(s)
  const res = await fetch(`${httpOf(a.server)}/github/pr-note`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: s.roomName, session: a.session, gh: a.gh, token: a.token, number, body }), signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`${a.server} would not post the PR note: ${(await res.text()).trim() || `HTTP ${res.status}`}`)
  const b = await res.json().catch(() => ({})) as { url?: string; updated?: boolean }
  return { url: b.url ?? '', updated: !!b.updated }
}

/** The branch part of a room name ("github.com/o/r/feature/x" -> "feature/x"). */
export function branchOf(roomName: string): string {
  const parts = roomName.split('/')
  return parts.slice(roomName.startsWith('github.com/') ? 3 : 2).join('/') || roomName
}

/**
 * The branch's room story as markdown, in bus order: who declared what, claims with their
 * plans and whether they were fulfilled, questions with answers, changes, merge previews that
 * passed, done notes. Copies routed to individuals and messages from PR mirrors are skipped.
 */
export function renderPrNote(room: RoomDoc, opts: { roomName: string; now?: number }): string {
  const now = opts.now ?? Date.now()
  const msgs = room.messages().filter(m => !m.copyOf && !isPrName(m.from))
  const releases = new Map<string, ReleaseMsg>()
  const answers = new Map<string, AnswerMsg[]>()
  for (const m of msgs) {
    if (m.type === 'release') releases.set(m.claimId, m)
    if (m.type === 'answer') { const arr = answers.get(m.inReplyTo) ?? []; arr.push(m); answers.set(m.inReplyTo, arr) }
  }
  const open = new Map(room.openClaims().map(c => [c.id, c] as [string, Claim]))
  const who = (m: Msg) => `**${displayName({ name: m.from, kind: m.fromKind })}**`
  const t = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ')
  const lines: string[] = []
  for (const m of msgs) {
    switch (m.type) {
      case 'scope':
        lines.push(`- ${t(m.at)} ${who(m)} is on \`${m.area}\`: ${m.summary} (${m.paths.map(p => `\`${p}\``).join(', ')})`)
        break
      case 'claim': {
        const c = m as ClaimMsg
        const r = releases.get(c.claimId)
        const status = r
          ? r.unfulfilled?.length ? `cancelled: ${formatPlans(r.unfulfilled)}${r.summary ? ` (${r.summary})` : ''}` : `done${r.summary ? `: ${r.summary}` : ''}`
          : open.has(c.claimId) ? 'still open' : 'released'
        lines.push(`- ${t(c.at)} ${who(c)} claimed \`${c.path}:${c.from_line}-${c.to_line}\` — ${c.intent}${c.plans?.length ? `; plans: ${formatPlans(c.plans)}` : ''} → ${status}`)
        break
      }
      case 'changed':
        lines.push(`- ${t(m.at)} ${who(m)} changed ${m.paths.map(p => `\`${p}\``).join(', ')} — ${m.summary}${m.symbols?.length ? ` (${m.symbols.join(', ')})` : ''}`)
        break
      case 'question': {
        lines.push(`- ${t(m.at)} ${who(m)} asked ${m.to ? `${m.to}'s agent` : 'the room'}: ${m.text}`)
        for (const a of answers.get(m.id) ?? []) lines.push(`  - ${t(a.at)} ${who(a)} answered: ${a.text}`)
        if (!(answers.get(m.id) ?? []).length) lines.push('  - (unanswered)')
        break
      }
      case 'conflict':
        lines.push(`- ${t(m.at)} conflict on \`${m.path}\`: ${m.text}`)
        break
      case 'base':
        lines.push(`- ${t(m.at)} ${who(m)} moved the base to \`${m.base.slice(0, 10)}\` (+${m.commits} commit${m.commits === 1 ? '' : 's'}: ${m.summary})`)
        break
      case 'note':
        if (/^merge preview with /.test(m.text)) lines.push(`- ${t(m.at)} ${who(m)}: ${m.text}`)
        else if (/^done/.test(m.text)) lines.push(`- ${t(m.at)} ${who(m)} ${m.text}`)
        break
      default: break
    }
  }
  const stillOpen = Array.from(open.values()).filter(c => !isPrName(c.by))
  const out = [
    `### Room ledger for \`${branchOf(opts.roomName)}\``,
    `_Generated by the room at ${t(now)} UTC from ${opts.roomName}. One comment per PR, updated in place._`,
    '',
    ...(lines.length ? lines : ['- (nothing recorded on the bus yet)']),
  ]
  if (stillOpen.length) {
    out.push('', '**Still claimed:**')
    for (const c of stillOpen) out.push(`- ${displayName({ name: c.by, kind: c.byKind })}: \`${c.path}:${c.from}-${c.to}\` — ${c.intent}`)
  }
  return out.join('\n') + '\n'
}
