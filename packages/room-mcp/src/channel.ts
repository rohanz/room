import type { WakeEvent } from './wake.js'

type Notification = { method: 'notifications/claude/channel'; params: { content: string; meta: Record<string, string> } }

/** A successful send is only a wake-up hint, never proof the model received the message. */
export async function sendChannelNotification(wake: WakeEvent, notify: (notification: Notification) => Promise<unknown>): Promise<void> {
  try {
    await notify({ method: 'notifications/claude/channel', params: { content: wake.content, meta: wake.meta } })
  } catch { /* no channel attached */ }
}
