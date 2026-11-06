/** Standalone builtins-only hook entry point. No process adapter initialization. */
import { decodeHookFields, hookTool, hookCommand, hookPathFields, hookContext, reduceHookEffort, type HookCodec } from './hook-fields.js'
export { compatibilityHookCodec } from './hook-fields.js'

export const codexHookCodec: HookCodec = {
  decode: (event, raw, _argv, incomplete) => decodeHookFields(event, raw, incomplete),
  reduceRuntime(event, evidence) {
    const next = reduceHookEffort(event, evidence)
    if (event.runtime.model) next.model = event.runtime.model
    return next
  },
  context: hookContext,
  matchesHostProcess: process => /^codex(?:[.-]|$)/i.test(process.executable ?? ''),
  tool: hookTool, command: hookCommand, pathFields: hookPathFields,
}
