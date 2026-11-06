/** Codex exec JSON evidence, independent of scanner and lifecycle policy. */
import type { HostLogDecoder, LogContext, NormalizedLogFact } from './types.js'
import { ACTIVITY_MAX, bounded, commandLabel, eventTime, shownPath, str, toolLabel } from './log-activity.js'
import { normalizedFailure } from './log-common.js'

interface CodexEvent {
  type?: string; thread_id?: unknown; message?: unknown; error?: { message?: unknown } | null
  item?: { type?: string; text?: unknown }; timestamp?: unknown
}
function codexItem(item: Record<string, unknown>, dir: string): string | undefined {
  switch (item.type) {
    case 'file_change': {
      if (!Array.isArray(item.changes)) return undefined
      const paths = item.changes.map(c => str((c as { path?: unknown } | null)?.path)).filter((p): p is string => !!p)
      if (!paths.length) return undefined
      const more = paths.length > 1 ? ` (+${paths.length - 1} more)` : ''
      return bounded('editing', shownPath(paths[0], dir), ACTIVITY_MAX - more.length) + more
    }
    case 'command_execution': { const command = str(item.command); return command ? commandLabel(command) : undefined }
    case 'mcp_tool_call': { const tool = str(item.tool); return tool ? toolLabel(tool) : undefined }
    case 'web_search': return 'searching the web'
    default: return undefined
  }
}

export function createCodexLogDecoder(context: LogContext): HostLogDecoder {
  let thread: unknown, failed: string | undefined, error: string | undefined
  return {
    backgroundTasks: 'unknown',
    acceptsLine: line => context.scope !== 'activity-window' || line.includes('"item.'),
    push(raw) {
      if (!raw || typeof raw !== 'object') return []
      const event = raw as CodexEvent, facts: NormalizedLogFact[] = []
      if (context.scope === 'activity-window') {
        if (typeof event.type !== 'string' || !event.type.startsWith('item.') || !event.item || typeof event.item !== 'object') return facts
        const label = codexItem(event.item as Record<string, unknown>, context.dir)
        if (label) facts.push({ kind: 'activity', text: label, eventTimeMs: eventTime(event.timestamp) })
        return facts
      }
      if (event.type === 'thread.started') {
        thread = event.thread_id
        if (typeof thread === 'string') facts.push({ kind: 'session', id: thread })
      }
      if (event.type === 'turn.started') {
        const id = event.thread_id ?? thread
        if (typeof id === 'string') facts.push({ kind: 'resume-accepted', id })
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        facts.push({ kind: 'final', slot: 'preferred', text: event.item.text.trim() })
      }
      if (context.scope !== 'diagnostic-suffix') return facts
      const message = event.error && typeof event.error === 'object' && typeof event.error.message === 'string' ? event.error.message : undefined
      if (event.type === 'turn.failed' && message) failed = message
      else if (event.type === 'error' && typeof event.message === 'string') error = event.message
      else if (event.type === 'turn.completed') failed = error = undefined
      else return facts
      facts.push({ kind: 'failure', failure: normalizedFailure(failed ?? error) })
      return facts
    },
  }
}
