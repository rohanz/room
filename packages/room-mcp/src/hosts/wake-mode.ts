import type { WakeEnv, Mode } from './wake-types.js'

export function mode(env: WakeEnv): Mode {
  const value = env.ROOM_WAKE
  return value === 'socket' || value === 'channels' || value === 'off' ? value : 'auto'
}
