import { afterEach, describe, expect, it } from 'vitest'
import {
  MessageKinds,
  RoomDoc,
  formatMsg,
  messageForMe,
  registerMessageKind,
  shouldWakeOnMsg,
  type MsgBase,
} from './index.js'

declare module './types.js' {
  interface MessageMap {
    ping: PingMsg
  }
}

interface PingMsg extends MsgBase {
  type: 'ping'
  text: string
}

describe('MessageKinds', () => {
  afterEach(() => { delete MessageKinds.ping })

  it('wakes for base moves only with uncommitted work', () => {
    const room = new RoomDoc()
    const m = room.post({ name: 'Kieran', kind: 'agent' }, { type: 'base', base: 'abc', commits: 1, summary: 'update', paths: [] })
    const me = { name: 'Rohan', kind: 'agent' } as const
    expect(shouldWakeOnMsg(me, m, [], false).wake).toBe(false)
    expect(shouldWakeOnMsg(me, m, [], true).wake).toBe(true)
    room.doc.destroy()
  })

  it('uses a registered priority when posting a waking kind', () => {
    registerMessageKind('ping', { audience: 'broadcast', wakes: 'always', priority: 'interrupt', format: m => m.text })
    const room = new RoomDoc()
    const m = room.post({ name: 'Kieran', kind: 'agent' }, { type: 'ping', text: 'look' })
    expect(m.priority).toBe('interrupt')
    expect(shouldWakeOnMsg({ name: 'Rohan', kind: 'agent' }, m).wake).toBe(true)
    room.doc.destroy()
  })

  it('routes, wakes and formats a newly registered kind without tool changes', () => {
    registerMessageKind('ping', {
      audience: 'addressed',
      wakes: 'addressed',
      priority: 'notify',
      format: m => `[${m.priority}] ping from ${m.from}: ${m.text}`,
    })
    const ping: PingMsg = {
      id: 'm_ping', type: 'ping', priority: 'notify', from: 'Kieran', fromKind: 'agent',
      to: 'Rohan', at: 1, text: 'please look',
    }

    expect(messageForMe({ name: 'Rohan' }, ping)).toBe(true)
    expect(messageForMe({ name: 'Ada' }, ping)).toBe(false)
    expect(shouldWakeOnMsg({ name: 'Rohan', kind: 'agent' }, ping).wake).toBe(true)
    expect(shouldWakeOnMsg({ name: 'Ada', kind: 'agent' }, ping).wake).toBe(false)
    expect(formatMsg(ping)).toBe('[notify] ping from Kieran: please look')
  })
})
