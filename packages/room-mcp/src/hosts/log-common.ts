/** Common error wording classification used only by host evidence decoders. */
import type { NormalizedHostFailure } from './types.js'
const CAPACITY = /at capacity|overloaded|\b529\b|high load/i
const RATE_LIMIT = /rate.?limit|\b429\b|too many requests|temporarily limiting/i
const LIMIT_REACHED = /spend limit|usage limit|credit balance|hit your .*limit|insufficient.?quota/i

export function normalizedFailure(message: string | undefined, status?: unknown, category?: unknown): NormalizedHostFailure | undefined {
  const text = message?.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  let transient: NormalizedHostFailure['transient']
  if (!LIMIT_REACHED.test(text)) {
    if (category === 'overloaded' || status === 529 || CAPACITY.test(text)) transient = 'model capacity'
    else if (category === 'rate_limit' || status === 429 || RATE_LIMIT.test(text)) transient = 'rate limit'
  }
  return transient ? { text, transient } : { text }
}
