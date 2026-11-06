/** Claude stream-json evidence, independent of scanner and lifecycle policy. */
import type { HostLogDecoder, LogContext, NormalizedLogFact } from './types.js'
import { bounded, commandLabel, eventTime, shownPath, str, toolLabel } from './log-activity.js'
import { normalizedFailure } from './log-common.js'

interface ClaudeEvent {
  type?: string; subtype?: string; session_id?: unknown; result?: unknown
  message?: { content?: unknown }; error?: unknown; is_error?: boolean
  is_api_error_message?: boolean; api_error_status?: unknown; errors?: unknown; num_turns?: number
  task_id?: unknown; task_type?: unknown; is_backgrounded?: unknown; patch?: { status?: unknown }
  tool_use_result?: { backgroundTaskId?: unknown }; timestamp?: unknown
}
function assistantText(event: ClaudeEvent): string {
  const content = typeof event.message === 'object' ? event.message?.content : undefined
  if (!Array.isArray(content)) return ''
  return content.filter((part): part is { type: string; text: string } => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('\n').trim()
}

function claudeTool(name: string, input: Record<string, unknown>, dir: string): string | undefined {
  const file = str(input.file_path) ?? str(input.notebook_path)
  switch (name) {
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return file ? bounded('editing', shownPath(file, dir)) : undefined
    case 'Read': return file ? bounded('reading', shownPath(file, dir)) : undefined
    case 'Bash': { const command = str(input.command); return command ? commandLabel(command) : undefined }
    case 'Glob': case 'Grep': return 'searching'
    case 'WebFetch': case 'WebSearch': return 'searching the web'
    case 'Task': case 'Agent': return 'running a subagent'
    default: return toolLabel(name)
  }
}

const UNFINISHED_TASK_STATUSES = new Set(['running', 'pending'])

export function createClaudeLogDecoder(context: LogContext): HostLogDecoder {
  let failed: string | undefined, error: string | undefined, status: unknown, category: unknown
  return {
    backgroundTasks: 'observed',
    acceptsLine: line => context.scope !== 'activity-window' || line.includes('"tool_use"'),
    push(raw) {
      if (!raw || typeof raw !== 'object') return []
      const event = raw as ClaudeEvent, facts: NormalizedLogFact[] = []
      if (context.scope === 'activity-window') {
        if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) return facts
        let label: string | undefined
        for (const part of event.message.content as { type?: unknown; name?: unknown; input?: unknown }[]) {
          if (part?.type !== 'tool_use' || typeof part.name !== 'string') continue
          const input = part.input && typeof part.input === 'object' ? part.input as Record<string, unknown> : {}
          label = claudeTool(part.name, input, context.dir) ?? label
        }
        if (label) facts.push({ kind: 'activity', text: label, eventTimeMs: eventTime(event.timestamp) })
        return facts
      }
      if (event.type === 'assistant') {
        if (typeof event.session_id === 'string') facts.push({ kind: 'resume-accepted', id: event.session_id })
        const text = assistantText(event)
        if (text) facts.push({ kind: 'final', slot: 'fallback', text })
      }
      if (event.type === 'result') {
        if (typeof event.result === 'string') facts.push({ kind: 'final', slot: 'preferred', text: event.result.trim() })
        if (event.subtype === 'error_during_execution' && event.is_error === true && event.num_turns === 0 && typeof event.session_id === 'string') {
          facts.push({ kind: 'session-missing', id: event.session_id })
        }
      }
      if (context.scope !== 'diagnostic-suffix') return facts
      if (event.type === 'assistant' && (event.is_api_error_message === true || typeof event.error === 'string')) {
        error = assistantText(event) || (typeof event.error === 'string' ? event.error : undefined)
        category = event.error
        facts.push({ kind: 'failure', failure: normalizedFailure(failed ?? error, status, category) })
      } else if (event.type === 'result') {
        if (event.is_error !== true) failed = error = undefined
        else {
          const errors = Array.isArray(event.errors) ? event.errors.filter((e): e is string => typeof e === 'string' && !!e.trim()) : []
          failed = (typeof event.result === 'string' && event.result.trim()) || errors.join('; ') || event.subtype || 'error result'
          status = event.api_error_status
        }
        facts.push({ kind: 'failure', failure: normalizedFailure(failed ?? error, status, category) })
      }
      const id = typeof event.task_id === 'string' ? event.task_id : undefined
      if (event.type === 'result') facts.push({ kind: 'background', state: 'result-boundary' })
      else if (event.type === 'user' && typeof event.tool_use_result?.backgroundTaskId === 'string') {
        facts.push({ kind: 'background', state: 'backgrounded', id: event.tool_use_result.backgroundTaskId })
      } else if (event.type === 'system' && id) {
        if (event.subtype === 'task_started') {
          facts.push({ kind: 'background', state: 'open', id, shell: event.task_type === 'local_bash' })
          if (event.is_backgrounded === true) facts.push({ kind: 'background', state: 'backgrounded', id })
        } else if (event.subtype === 'task_notification'
          || event.subtype === 'task_updated' && typeof event.patch?.status === 'string' && !UNFINISHED_TASK_STATUSES.has(event.patch.status)) {
          facts.push({ kind: 'background', state: 'closed', id })
        }
      }
      return facts
    },
  }
}
