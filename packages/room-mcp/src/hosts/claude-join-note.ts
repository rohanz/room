import { sessionHost } from './selection.js'

/** Claude's inbox requires a bound host identity; worker completion uses its separate lifecycle. */
export function joinReplyNote(bound: boolean, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!bound && !env.ROOM_WORKER_ID && sessionHost(env) === 'claude')
    return 'This session cannot be woken because Claude has not supplied its session identity in this repository; start Claude inside the repository to enable wakes.'
}
