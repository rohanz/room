export function missingPreEditGuidance(host: string): string {
  if (host === 'claude') return "Room has not seen its before-edit hook run in this session although its tools are in use: the plugin's hooks may not be running; reinstall or re-enable the plugin."
  if (host === 'codex') return 'Pre-edit coordination is not confirmed yet; if the Room hooks were never approved, approve them once in an interactive Codex session.'
  return 'Pre-edit coordination is not confirmed yet; enable the Room hooks for this agent host.'
}

export const hookWarningPolicy = (host: string) => ({ upFront: host === 'codex', requiresEdit: host === 'claude' })
