/**
 * This process's Room lifecycle: held by each tools instance (a production MCP process has exactly one). When the
 * last holder ends, the lifecycle stays ended, so no registry opens and no storage registration or admission starts
 * afterwards, whatever context the late work runs in (timers, Y.js or provider callbacks, Git continuations). Holding
 * again begins a new lifecycle. This module imports nothing, so the test setup can import its reset.
 */
let holders = 0
let ended = false

/** Hold the lifecycle; the returned release reports whether it was the last holder (the lifecycle has then ended). */
export function holdProcessLifecycle(): () => boolean {
  holders++
  ended = false
  let released = false
  return () => {
    if (released) return false
    released = true
    holders--
    if (holders > 0) return false
    ended = true
    return true
  }
}

export function processLifecycleEnded(): boolean { return ended }

/** Each test models a fresh process (vitest.setup.ts): no holder, not ended. */
export function resetProcessLifecycle(): void { holders = 0; ended = false }
