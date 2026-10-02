import { participantRecord } from '@room/shared'
import { git } from '@room/roomd/git'
import type { Session } from './session.js'
import { checkoutPublisher } from './tools/share.js'

// Publication helps other participants' views; the lead reads its workers' worktrees directly.
/** Best-effort refresh before completion; publication must never prevent a report or claim release. */
export async function settleWorkerPublication(s: Session): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    if (s.rejected) throw new Error(`session rejected: ${s.rejected.reason}`)
    if (!s.daemon) throw new Error('no daemon')
    if (s.policyStore.policy.level === 'intent') throw new Error('intent sharing has no disk publication')
    if (!s.daemon.fence) throw new Error('no daemon fence')
    await Promise.race([
      (async () => {
        await s.daemon.reconcileGitChanges()
        await s.daemon.settle()
        // Reconciliation schedules retries on failure rather than throwing. Verify its result,
        // including the fence and complete overlay, for other participants' views.
        const head = (await git(s.dir, ['rev-parse', 'HEAD'])).trim()
        const publisher = checkoutPublisher(s) ?? s.me.name
        const published = participantRecord(s.room, publisher)?.git
        const manifest = s.room.manifestHead.get(publisher)
        if (!s.daemon.fence || published?.head !== head || publisher === s.me.name && published.fence !== s.daemon.fence
          || !manifest?.complete || manifest.fence !== published.fence || manifest.base !== published.base) {
          throw new Error('current HEAD and overlay are not published yet')
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('publication did not settle within 5 s')), 5_000)
      }),
    ])
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`room_done: publication unverified for ${s.me.name}; ${reason}`.replace(/[\r\n]+/g, ' '))
  } finally { if (timer) clearTimeout(timer) }
}
