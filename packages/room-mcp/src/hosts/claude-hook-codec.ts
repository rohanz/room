/** Standalone builtins-only hook entry point. No process adapter or transcript I/O. */
import { decodeHookFields, hookTool, hookCommand, hookPathFields, hookContext, reduceHookEffort, type HookCodec } from './hook-fields.js'

/** Newest real model in the already bounded JSONL tail; a partial leading line is never evidence. */
function newestModelInTranscriptTail(tail: string, startsMidLine = false): string | undefined {
  const lines = tail.split('\n')
  if (startsMidLine) lines.shift()
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry
    try { entry = JSON.parse(lines[i]) } catch { continue }
    const model = typeof entry?.message?.model === 'string' ? entry.message.model.trim() : ''
    if (model && !model.startsWith('<')) return model
  }
}

export const claudeHookCodec: HookCodec = {
  decode(event, raw, _argv, incomplete) {
    const decoded = decodeHookFields(event, raw, incomplete)
    const transcript = (raw as Record<string, unknown>)?.transcript_path
    // Startup excludes an empty path; before-tool has always attempted even an empty string.
    if (typeof transcript === 'string' && (event === 'before-tool' || transcript)) decoded.transcriptPath = transcript
    return decoded
  },
  reduceRuntime(event, evidence) {
    const next = reduceHookEffort(event, evidence)
    const transcript = evidence.transcript
    if (transcript) {
      const model = newestModelInTranscriptTail(transcript.tail, transcript.startsMidFile)
      const session = evidence.sessionRecord as { model?: unknown } | null
      const previous = evidence.previousRuntime as { transcript?: unknown } | null
      // SessionStart wins over the first possibly lagging transcript read.
      if (model && !(typeof session?.model === 'string' && session.model && !previous?.transcript)) next.model = model
      next.transcript = { path: transcript.path, mtimeMs: transcript.mtimeMs, size: transcript.size }
    }
    return next
  },
  context: hookContext,
  matchesHostProcess: process => /^claude(?:[.-]|$)/i.test(process.executable ?? ''),
  tool: hookTool, command: hookCommand, pathFields: hookPathFields,
}
