import { type NoteMsg } from '@room/shared'
import { fetchPrs, postPrNote, prLeader, renderPrNote, syncPrs } from '../prs.js'
import { openPrs, branchOf, type PrInfo } from '../prs.js'
import type { Session } from '../session.js'
import { RO, RW, int, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'

export const defs: ToolDef[] = [
  { name: 'room_pr_note', annotations: { ...RW, openWorldHint: true }, description: 'Post or update the room ledger on a GitHub PR; defaults to this branch’s open PR.',
    inputSchema: { type: 'object', properties: { number: int('PR number') } } }
]

export function handlers(state: HandlerState): Record<string, Handler> {
  const { S, refreshPrs, myPr, postLedger } = state
  const handlers: Record<string, Handler> = {
    async room_pr_note(a) {
      const s = S()
      if (!s.roomName.startsWith('github.com/')) return 'error: this room is not a GitHub repo; there are no pull requests to annotate'
      await refreshPrs(s)
      let pr: PrInfo | undefined
      if (a.number !== undefined) {
        const n = Number(a.number)
        if (!Number.isInteger(n) || n <= 0) return 'error: number must be a positive PR number'
        pr = openPrs(s.room).find(p => p.number === n) ?? { number: n, title: `#${n}`, author: '', head: '', files: [], updatedAt: '', url: '' }
      } else {
        pr = await myPr(s)
        if (!pr) { const open = openPrs(s.room); return `no open PR has ${branchOf(s.roomName)} as its head${open.length ? `; open PRs targeting this branch: ${open.map(p => `#${p.number} (${p.head})`).join(', ')}. Pass number=<n>` : ''}` }
      }
      return postLedger(s, pr)
    }
  }
  return handlers
}


export function install(state: HandlerState): void {
  const { ctx, presences, log, now } = state
  let prTimer: ReturnType<typeof setInterval> | null = null
  let prSyncedSession: Session | null = null
  const fetchPrList = ctx.prs?.fetch ?? fetchPrs
  const postNote = ctx.prs?.post ?? postPrNote
  const refreshPrs = async (s: Session): Promise<string> => {
      if (!s.roomName.startsWith('github.com/')) return ''
      const present = presences(s).map(p => p.user.name)
      const leader = prLeader(present.length ? present : [s.me.name], Array.from(s.room.workers.values()).map(w => w.name))
      if (leader !== s.me.name) return ''
      let prs: PrInfo[]
      try { prs = await fetchPrList(s) } catch (e) { log(`pull requests: ${e instanceof Error ? e.message : String(e)}`); return '' }
      const r = syncPrs(s.room, prs, s.me)
      const parts = [r.added.length ? `mirrored ${r.added.map(n => `#${n}`).join(', ')}` : '', r.removed.length ? `removed ${r.removed.map(n => `#${n}`).join(', ')}` : ''].filter(Boolean)
      if (parts.length) log(`pull requests: ${parts.join('; ')}`)
      return parts.join('; ')
    }
  const startPrSync = (s: Session) => {
      if (prSyncedSession === s) return
      stopPrSync()
      prSyncedSession = s
      const every = ctx.prs?.intervalMs ?? 2 * 60_000
      void refreshPrs(s)
      if (every > 0) { prTimer = setInterval(() => { void refreshPrs(s) }, every); prTimer.unref?.() }
    }
  const stopPrSync = () => { if (prTimer) clearInterval(prTimer); prTimer = null; prSyncedSession = null }
  const prLines = (s: Session): string[] => {
      const prs = openPrs(s.room)
      if (!prs.length) return []
      const out = [`open pull requests (${prs.length}):`]
      for (const pr of prs) out.push(`  - PR #${pr.number} "${pr.title}" by ${pr.author} (${pr.head} → ${branchOf(s.roomName)}): ${pr.files.length ? pr.files.slice(0, 8).join(', ') + (pr.files.length > 8 ? `, +${pr.files.length - 8} more` : '') : 'no files'} · ${pr.url}`)
      return out
    }
  const myPr = async (s: Session): Promise<PrInfo | undefined> => {
      const head = branchOf(s.roomName)
      try { const byHead = (await fetchPrList(s, { head: true })).find(p => p.head === head); if (byHead) return byHead } catch (e) { log(`pull requests by head: ${e instanceof Error ? e.message : String(e)}`) }
      return openPrs(s.room).find(p => p.head === head)
    }
  const postLedger = async (s: Session, pr: PrInfo): Promise<string> => {
      const body = renderPrNote(s.room, { roomName: s.roomName, now: now() })
      const r = await postNote(s, pr.number, body)
      s.room.post<NoteMsg>(s.me, { type: 'note', text: `${r.updated ? 'updated' : 'posted'} the room ledger on PR #${pr.number}${r.url ? ` (${r.url})` : ''}`, priority: 'fyi' })
      return `${r.updated ? 'updated' : 'posted'} the room ledger comment on PR #${pr.number} "${pr.title}"${r.url ? `: ${r.url}` : ''} (${body.split('\n').length} lines)`
    }
  Object.assign(state, { refreshPrs, startPrSync, stopPrSync, prLines, myPr, postLedger })
}
