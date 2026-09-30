import { neighbours, participantsView, type NoteMsg } from '@room/shared'
import { acceptedPrBranch, fetchPrs, postPrNote, prLeader, renderPrNote, syncPrs } from '../prs.js'
import { openPrs, type PrInfo } from '../prs.js'
import type { Session } from '../session.js'
import { RO, RW, int, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'

export const defs: ToolDef[] = [
  { name: 'room_pr_note', annotations: { ...RW, openWorldHint: true }, description: 'Use when asked to post Room activity on a GitHub PR. Updates the room ledger on this branch’s PR by default.',
    inputSchema: { type: 'object', properties: { number: int('PR number') } } }
]

export function handlers(state: HandlerState): Record<string, Handler> {
  const { S, refreshPrs, myPr, postLedger } = state
  const handlers: Record<string, Handler> = {
    async room_pr_note(a) {
      const s = S()
      if (!s.roomName.startsWith('github.com/')) return 'error: this room is not a GitHub repo; there are no pull requests to annotate'
      if (a.number === undefined && acceptedPrBranch(s) === 'updating') return 'error: your branch is updating; retry when its git record is current, or pass number=<n>'
      await refreshPrs(s)
      let pr: PrInfo | undefined
      if (a.number !== undefined) {
        const n = Number(a.number)
        if (!Number.isInteger(n) || n <= 0) return 'error: number must be a positive PR number'
        pr = openPrs(s.room).find(p => p.number === n) ?? { number: n, title: `#${n}`, author: '', head: '', files: [], updatedAt: '', url: '' }
      } else {
        pr = await myPr(s)
        if (!pr) {
          const branch = acceptedPrBranch(s)
          if (branch === 'updating') return 'error: your branch is updating; retry when its git record is current, or pass number=<n>'
          if (!branch) return "check out the PR's branch, or pass number"
          const open = openPrs(s.room)
          return `no open PR has ${branch} as its head${open.length ? `; open PRs targeting branches here: ${open.map(p => `#${p.number} (${p.head})`).join(', ')}` : ''}. Pass number=<n>`
        }
      }
      if (a.number === undefined && acceptedPrBranch(s) !== pr.head) return 'error: your branch changed while selecting its PR; retry room_pr_note or pass number=<n>'
      return postLedger(s, pr)
    }
  }
  return handlers
}


export function createPrs(deps: Pick<HandlerState, 'ctx' | 'presences' | 'log' | 'now'>): Pick<HandlerState, 'refreshPrs' | 'startPrSync' | 'stopPrSync' | 'prLines' | 'myPr' | 'postLedger'> {
  const { ctx, presences, log, now } = deps
  let prTimer: ReturnType<typeof setInterval> | null = null
  let prSyncedSession: Session | null = null
  const fetchPrList = ctx.prs?.fetch ?? fetchPrs
  const postNote = ctx.prs?.post ?? postPrNote
  const refreshPrs = async (s: Session): Promise<string> => {
      if (!s.roomName.startsWith('github.com/')) return ''
      const nb = neighbours(participantsView(s.room, s.awareness, now()), s.me.name)
      const present = presences(s).map(p => p.user.name).filter(name => name === s.me.name || nb.has(name))
      const leader = prLeader(present.length ? present : [s.me.name], s.room.acceptedWorkerViews().map(w => w.name))
      if (leader !== s.me.name) return ''
      const view = participantsView(s.room, s.awareness, now())
      const names = [s.me.name, ...neighbours(view, s.me.name).names()]
      const active = new Map(presences(s).map(p => [p.user.name, p.lastActive ?? 0]))
      const chooseBranches = () => [...new Set(names.sort((a, b) => (active.get(b) ?? 0) - (active.get(a) ?? 0))
        .map(name => acceptedPrBranch(s, name, now())).filter((branch): branch is string => !!branch && branch !== 'updating' && !branch.startsWith('room/')))].slice(0, 10)
      const branches = chooseBranches()
      if (!branches.length) return ''
      let prs: PrInfo[]
      try {
        const fetched = await Promise.all(branches.flatMap(branch => [fetchPrList(s, { branch }), fetchPrList(s, { branch, head: true })]))
        prs = [...new Map(fetched.flat().map(pr => [pr.number, pr])).values()].slice(0, 20)
      } catch (e) { log(`pull requests: ${e instanceof Error ? e.message : String(e)}`); return '' }
      if (prLeader(presences(s).map(p => p.user.name), s.room.acceptedWorkerViews().map(w => w.name)) !== s.me.name
        || JSON.stringify(chooseBranches()) !== JSON.stringify(branches)) return ''
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
      const refresh = () => { void refreshPrs(s).catch(e => log(`pull requests: ${e instanceof Error ? e.message : String(e)}`)) }
      refresh()
      if (every > 0) { prTimer = setInterval(refresh, every); prTimer.unref?.() }
    }
  const stopPrSync = () => { if (prTimer) clearInterval(prTimer); prTimer = null; prSyncedSession = null }
  const prLines = (s: Session): string[] => {
      const prs = openPrs(s.room)
      if (!prs.length) return []
      const out = [`open pull requests (${prs.length}):`]
      for (const pr of prs) out.push(`  - PR #${pr.number} "${pr.title}" by ${pr.author} (${pr.head}): ${pr.files.length ? pr.files.slice(0, 8).join(', ') + (pr.files.length > 8 ? `, +${pr.files.length - 8} more` : '') : 'no files'} · ${pr.url}`)
      return out
    }
  const myPr = async (s: Session): Promise<PrInfo | undefined> => {
      const head = acceptedPrBranch(s)
      if (!head || head === 'updating') return undefined
      try { const byHead = (await fetchPrList(s, { branch: head, head: true })).find(p => p.head === head); if (acceptedPrBranch(s) !== head) return undefined; if (byHead) return byHead } catch (e) { log(`pull requests by head: ${e instanceof Error ? e.message : String(e)}`) }
      if (acceptedPrBranch(s) !== head) return undefined
      return openPrs(s.room).find(p => p.head === head)
    }
  const postLedger = async (s: Session, pr: PrInfo): Promise<string> => {
      const branch = acceptedPrBranch(s)
      if (branch === 'updating') return 'error: your branch is updating; retry when its git record is current'
      const body = renderPrNote(s.room, { roomName: s.roomName, branch, now: now() })
      const r = await postNote(s, pr.number, body)
      await s.post<NoteMsg>(s.me, { type: 'note', text: `${r.updated ? 'updated' : 'posted'} the room ledger on PR #${pr.number}${r.url ? ` (${r.url})` : ''}`, priority: 'fyi' })
      return `${r.updated ? 'updated' : 'posted'} the room ledger comment on PR #${pr.number} "${pr.title}"${r.url ? `: ${r.url}` : ''} (${body.split('\n').length} lines)`
    }
  return { refreshPrs, startPrSync, stopPrSync, prLines, myPr, postLedger }
}
