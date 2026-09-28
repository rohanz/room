/** One completion event per worker run, shared by room_done and the registry projector. */
export function completionMessage(
  record: { id: string; tag: string; lead: { participant: string } },
  run: { n: number },
  status: { status: string; summary?: string; note?: string },
  report?: { done?: { summary: string; changed: string[] } },
): { id: string; body: { type: 'done'; tag: string; summary: string; changed: string[]; to: string; priority: 'notify' }
  | { type: 'note'; text: string; to: string; priority: 'interrupt' } } | undefined {
  const id = `wk:${record.id}:${run.n}`
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
