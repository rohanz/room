/** Local recovery advice, delivered through the same receipts as other owed notices. */
import { git } from '@room/roomd/git'
import type { Ledger } from './ledger.js'
import type { Session } from './session.js'
import { openWorkerReader } from './worker-registry.js'
import { requireWorkerEvidence, snapshotStatus, workerEvidence } from './worker-store.js'
import type { WorkerStopCause } from './worker-status.js'
import { INBOX_BUDGET } from './inbox-budget.js'

export function workerStopDescription(cause?: WorkerStopCause): string {
  switch (cause) {
    case 'stdin closed': return "the host closed the lead MCP's stdin (reconnect or host exit; Room cannot distinguish them)"
    case 'stdin/transport closed': return "the lead MCP's transport closed (the host's reason is unknown)"
    case 'explicit leave': return 'the lead left the room (explicit leave)'
    case 'SIGTERM': case 'SIGINT': return `the lead MCP received ${cause}`
    default: return "Room recorded lead-session-ended (specific cause was not recorded)"
  }
}

export function createWorkerRestartNotices(ledger: Ledger, log: (line: string) => void) {
  const prepared = new WeakMap<Session, Promise<void>>()
  return (s: Session): Promise<void> => {
    const pending = prepared.get(s)
    if (pending) return pending
    const prepare = async () => {
      const snapshot = requireWorkerEvidence(workerEvidence(await (await openWorkerReader(s.dir)).snapshot()))
      const stopped = snapshot.workers.map(facts => facts.record).filter(record =>
        record.lead.participant === s.me.name && record.lead.room === s.roomName
        && record.capabilities.resume && record.hostSessionId
        && record.stop?.reason === 'lead-session-ended' && record.stop.run === record.runs.at(-1)?.n
        && snapshotStatus(snapshot, record.id)?.status === 'stopped').sort((a, b) => a.id.localeCompare(b.id))
      if (!stopped.length) return
      const lines: { text: string; identity: string }[] = []
      const deadline = Date.now() + 5_000
      // Bound each read and avoid concurrent Git scans of many retained worktrees. Never call
      // an unreadable worktree clean, nor expose its paths or file contents in the notice.
      for (const record of stopped) {
        let work = 'unknown (worktree missing, unreadable, or Git status failed)'
        try {
          const remaining = deadline - Date.now()
          if (remaining <= 0) work = 'unknown (startup status check budget exhausted)'
          else work = (await git(record.dir, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal'], Math.min(2_000, remaining))).trim()
            ? 'yes (tracked or non-ignored untracked changes)' : 'no tracked or non-ignored untracked changes'
        } catch { /* unknown is evidence, not a clean checkout */ }
        const stop = record.stop!
        const date = new Date(stop.at)
        const when = Number.isFinite(date.getTime()) ? date.toISOString() : 'an unknown time'
        lines.push({ text: `- ${record.name}: stopped; stop recorded at ${when} because ${workerStopDescription(stop.cause)}; uncommitted work: ${work}. Request resume: room_send(to=${JSON.stringify(record.name)}, type="note", text="Continue your task and report remaining work.").`, identity: `${record.id}:${stop.run}:${stop.at}` })
      }
      // Each stop has its own receipt, regardless of changes to worktrees, the remaining
      // stopped workers, or the resulting presentation chunks after an MCP restart.
      const header = '[room] Stopped workers with retained sessions; Room has not resumed them automatically.'
      ledger.noticeEvents('worker-restart', header, lines, INBOX_BUDGET)
    }
    const promise = prepare().catch(error => {
      prepared.delete(s) // An unavailable inventory is not an empty inventory; retry on the next reply.
      log(`worker restart notice unavailable: ${error instanceof Error ? error.message : String(error)}`)
    })
    prepared.set(s, promise)
    return promise
  }
}
