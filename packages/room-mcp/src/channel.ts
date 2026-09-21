import { resolveSessionHost } from './config.js'
import type { Session } from './session.js'

type Wake = { content: string; meta: Record<string, string> }
type Notification = { method: 'notifications/claude/channel'; params: Wake }

/** A successful send is only a wake-up hint, never proof the model received the message. */
export async function pushChannelNotification(
  s: Session,
  wake: Wake | null,
  notify: (notification: Notification) => Promise<unknown>,
  channel: string | undefined,
  host?: string,
): Promise<void> {
  if (!wake || (host ?? resolveSessionHost(s.dir)) !== 'claude' || channel === '') return
  try {
    await notify({ method: 'notifications/claude/channel', params: { content: wake.content, meta: wake.meta } })
  } catch { /* no channel attached */ }
}
