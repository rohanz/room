import { participantRecord } from '@room/shared'
import { git } from '@room/roomd/git'
import type { Session } from './session.js'
import { checkoutPublisher } from './tools/share.js'

/** Refresh through the daemon's existing queue before a worker records its completion. */
export async function settleWorkerPublication(s: Session): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      (async () => {
        await s.daemon.reconcileGitChanges()
        await s.daemon.settle()
        // Reconciliation schedules retries on failure rather than throwing. Verify its result,
        // including the fence and complete overlay, before allowing claims or a report to go out.
        const head = (await git(s.dir, ['rev-parse', 'HEAD'])).trim()
        const publisher = checkoutPublisher(s) ?? s.me.name
        const published = participantRecord(s.room, publisher)?.git
        const manifest = s.room.manifestHead.get(publisher)
        if (!s.daemon.fence || published?.head !== head || publisher === s.me.name && published.fence !== s.daemon.fence
          || !manifest?.complete || manifest.fence !== published.fence || manifest.base !== published.base) {
          throw new Error('current HEAD and overlay are not published yet; call room_done again in a few seconds')
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('publication did not settle within 15 s; call room_done again in a few seconds')), 15_000)
      }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}
