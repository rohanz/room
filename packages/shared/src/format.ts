export { formatMsg, formatPlans } from './messages.js'

export function withLineNumbers(text: string): string {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const w = String(lines.length).length
  return lines.map((l, i) => `${String(i + 1).padStart(w)}| ${l}`).join('\n')
}
