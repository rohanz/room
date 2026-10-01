/**
 * A completion's deterministic id. A run can report more than once: a lead's message to a worker that has
 * reported but not yet exited reaches it in the same run, and its next room_done is report `k` of that run.
 */
export const completionId = (worker: string, run: number, k = 1): string => `wk:${worker}:${run}${k > 1 ? `:${k}` : ''}`

/** One completion event per worker report, shared by room_done and the registry projector. */
export function completionMessage(
  record: { id: string; tag: string; lead: { participant: string } },
  run: { n: number },
  status: { status: string; summary?: string; note?: string },
  report?: { done?: { summary: string; changed: string[]; k?: number } },
): { id: string; body: { type: 'done'; tag: string; summary: string; changed: string[]; to: string; priority: 'notify' }
  | { type: 'note'; text: string; to: string; priority: 'interrupt' } } | undefined {
  const id = completionId(record.id, run.n, report?.done?.k)
  if (report?.done || status.status === 'done') return { id, body: {
    type: 'done', tag: record.tag, summary: report?.done?.summary ?? status.summary ?? '',
    changed: report?.done?.changed ?? [], to: record.lead.participant, priority: 'notify',
  } }
  if (status.status === 'failed') return { id, body: {
    type: 'note', text: `worker ${record.tag} failed: ${status.note ?? 'exited before reporting done'}`,
    to: record.lead.participant, priority: 'interrupt',
  } }
  return undefined
}
