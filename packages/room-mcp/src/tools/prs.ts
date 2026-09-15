import { openPrs, branchOf, type PrInfo } from '../prs.js'
import { RO, RW, int, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'

export const defs: ToolDef[] = [
  { name: 'room_pr_note', annotations: { ...RW, openWorldHint: true }, description: 'Post (or update) ONE comment on a GitHub pull request with the branch\'s room story: who declared what, claims with plans and whether they were fulfilled, questions and answers, merge previews that passed, in bus order. Default PR: the open one whose head is this branch. The comment is authored by the logged-in user via the server; the GitHub token never leaves the server.',
    inputSchema: { type: 'object', properties: { number: int('PR number (default: the open PR whose head is this branch)') } } }
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
