import type { NoteMsg } from '@room/shared'
import { acceptedPrBranch, fetchPrs, postPrNote, renderPrNote, type PrInfo } from '../prs.js'
import type { Session } from '../session.js'
import { RW, int, type Handler, type HandlerState, type ToolDef } from './context.js'

export const defs: ToolDef[] = [
  { name: 'room_pr_note', annotations: { ...RW, openWorldHint: true }, description: 'Use when asked to post Room activity on a GitHub PR. Updates the room ledger on this branch’s PR by default.',
    inputSchema: { type: 'object', properties: { number: int('PR number') } } }
]

export function handlers(state: HandlerState): Record<string, Handler> {
  const { S, myPr, postLedger } = state
  const handlers: Record<string, Handler> = {
    async room_pr_note(a) {
      const s = S()
      if (!s.roomName.startsWith('github.com/')) return 'error: this room is not a GitHub repo; there are no pull requests to annotate'
      if (a.number === undefined && acceptedPrBranch(s) === 'updating') return 'error: your branch is updating; retry when its git record is current, or pass number=<n>'
      let pr: PrInfo | undefined
      if (a.number !== undefined) {
        const n = Number(a.number)
        if (!Number.isInteger(n) || n <= 0) return 'error: number must be a positive PR number'
        pr = { number: n, title: `#${n}`, author: '', head: '', updatedAt: '', url: '' }
      } else {
        pr = await myPr(s)
        if (!pr) {
          const branch = acceptedPrBranch(s)
          if (branch === 'updating') return 'error: your branch is updating; retry when its git record is current, or pass number=<n>'
          if (!branch) return "check out the PR's branch, or pass number"
          return `no open PR has ${branch} as its head. Pass number=<n>`
        }
      }
      if (a.number === undefined && acceptedPrBranch(s) !== pr.head) return 'error: your branch changed while selecting its PR; retry room_pr_note or pass number=<n>'
      return postLedger(s, pr)
    }
  }
  return handlers
}


export function createPrs(deps: Pick<HandlerState, 'ctx' | 'now'>): Pick<HandlerState, 'myPr' | 'postLedger'> {
  const { ctx, now } = deps
  const fetchPrList = ctx.prs?.fetch ?? fetchPrs
  const postNote = ctx.prs?.post ?? postPrNote
  const myPr = async (s: Session): Promise<PrInfo | undefined> => {
    const head = acceptedPrBranch(s)
    if (!head || head === 'updating') return undefined
    const result = await fetchPrList(s, { branch: head })
    const prs = result.prs.filter(p => p.head === head)
    if (acceptedPrBranch(s) !== head) return undefined
    if (prs.length > 1) throw new Error(`several open PRs have ${head} as their head: ${prs.map(pr => `#${pr.number} (${pr.headOwner ?? 'unknown owner'}:${pr.head})`).join(', ')}. Use room_pr_note number=<n> to pick one`)
    if (!prs.length) throw new Error(result.heads
      ? `no open pull request was found for ${result.heads.join(' or ')}. A pull request from another account's fork needs room_pr_note number=<n>`
      : `no open pull request was found for branch ${head}. A fork's pull request needs room_pr_note number=<n> until the server is updated`)
    return prs[0]
  }

  const postLedger = async (s: Session, pr: PrInfo): Promise<string> => {
      const branch = acceptedPrBranch(s)
      if (branch === 'updating') return 'error: your branch is updating; retry when its git record is current'
      const body = renderPrNote(s.room, { roomName: s.roomName, branch, now: now() })
      const r = await postNote(s, pr.number, body)
      await s.post<NoteMsg>(s.me, { type: 'note', text: `${r.updated ? 'updated' : 'posted'} the room ledger on PR #${pr.number}${r.url ? ` (${r.url})` : ''}`, priority: 'fyi' })
      return `${r.updated ? 'updated' : 'posted'} the room ledger comment on PR #${pr.number} "${pr.title}"${r.url ? `: ${r.url}` : ''} (${body.split('\n').length} lines)`
    }
  return { myPr, postLedger }
}
