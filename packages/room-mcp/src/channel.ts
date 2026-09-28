export type ChannelNotification = { method: 'notifications/claude/channel'; params: { content: string; meta: Record<string, string> } }

/**
 * A content-free wake over the Room channel. It rejects when the transport write fails; Claude Code drops
 * the event silently when the session has not admitted the channel, so success is only a hint.
 */
export async function sendChannelNotification(content: string, notify: (notification: ChannelNotification) => Promise<unknown>): Promise<void> {
  await notify({ method: 'notifications/claude/channel', params: { content, meta: { type: 'room_wake' } } })
}
