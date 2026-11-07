/** Compatibility entry points; host transports live in adapters. */
export type { WakeTarget, WakeVia, WakeAttempt, WakePathStatus, SendWake, WakeAvailability, WakeSenderOptions, SendMidTurn } from './hosts/wake-types.js'
export { createWakeSender, wakePathStatus } from './hosts/wake.js'
export { claudeWakeAvailable } from './hosts/claude-wake.js'
export { createMidTurnSender } from './hosts/codex-wake.js'
