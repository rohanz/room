import { afterEach, describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as channel from '../src/channel.js'
import { SocketWakeRouter, claudeWakeAvailable } from '../src/wake-path.js'
import { shouldWake } from '../src/wake.js'
import type { Identity, Msg } from '@room/shared'

const me: Identity = { name: 'Rohan', kind: 'agent' }
const makeMsg = (id: string, from: string, type: Msg['type'] = 'question', priority = 'notify') =>
  ({ id, at: 1, from, fromKind: 'agent', to: 'Rohan', type, priority, text: 'secret body must stay out of socket text' }) as Msg
const wake = (m: Msg) => shouldWake(me, { kind: 'msg', msg: m })
const pause = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms))
const flag = 'claude --dangerously-load-development-channels plugin:room@room'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'room-socket-wake-'))

afterEach(() => vi.unstubAllEnvs())

describe('Claude socket wake', () => {
  it('posts the first event immediately, one follow-up for five events, then resets after quiet', async () => {
    vi.useFakeTimers()
    const post = vi.fn(async () => {})
    const router = new SocketWakeRouter({ env: { CLAUDE_CODE_MESSAGING_SOCKET: '/unused.sock' }, notify: vi.fn(async () => {}), post, host: 'claude' })
    try {
      router.push(wake(makeMsg('first', 'cat')))
      await Promise.resolve()
      expect(post).toHaveBeenCalledTimes(1)
      for (let i = 0; i < 4; i++) router.push(wake(makeMsg(String(i), 'cat')))
      expect(post).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(post).toHaveBeenCalledTimes(2)
      expect(post.mock.calls[0][2]).toContain('(#1)')
      expect(post.mock.calls[1][2]).toContain('(#2)')
      router.push(wake(makeMsg('after', 'cat')))
      await Promise.resolve()
      expect(post).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(post).toHaveBeenCalledTimes(3)
      expect(post.mock.calls[2][2]).toContain('(#3)')
    } finally { router.close(); vi.useRealTimers() }
  })

  it('summarizes only events still unread at send time and skips an empty follow-up', async () => {
    vi.useFakeTimers()
    const seen = new Set<string>()
    const post = vi.fn(async () => {})
    const router = new SocketWakeRouter({ env: { CLAUDE_CODE_MESSAGING_SOCKET: '/unused.sock' }, notify: vi.fn(async () => {}), post, host: 'claude', isUnread: w => !seen.has(w.meta.msg_id), windowMs: 10 })
    try {
      router.push(wake(makeMsg('first', 'cat')))
      await Promise.resolve()
      router.push(wake(makeMsg('answered', 'bridge')))
      router.push(wake(makeMsg('unread', 'Ada', 'note')))
      seen.add('answered')
      await vi.advanceTimersByTimeAsync(10)
      expect(post).toHaveBeenCalledTimes(2)
      expect(post.mock.calls[1][2]).toContain('Ada sent a note')
      expect(post.mock.calls[1][2]).not.toContain('bridge')
      router.push(wake(makeMsg('read-too', 'bridge')))
      seen.add('read-too')
      await vi.advanceTimersByTimeAsync(10)
      expect(post).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(10)
      router.push(wake(makeMsg('later', 'Ada')))
      await Promise.resolve()
      expect(post).toHaveBeenCalledTimes(3)
    } finally { router.close(); vi.useRealTimers() }
  })

  it('sends nothing when an event has already been read before the first post', async () => {
    const post = vi.fn(async () => {})
    const router = new SocketWakeRouter({ env: { CLAUDE_CODE_MESSAGING_SOCKET: '/unused.sock' }, notify: vi.fn(async () => {}), post, host: 'claude', isUnread: () => false, windowMs: 1 })
    router.push(wake(makeMsg('read', 'bridge')))
    await pause(10)
    expect(post).not.toHaveBeenCalled()
    router.close()
  })

  it('writes auth then user JSON lines on the immediate and follow-up wakes', async () => {
    const dir = tmp(); const socketPath = path.join(dir, 'inbox.sock'); const lines: string[][] = []
    const server = net.createServer(c => { let data = ''; c.on('data', chunk => { data += chunk }); c.on('end', () => lines.push(data.trim().split('\n'))) })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
    const notify = vi.fn(async () => {})
    const router = new SocketWakeRouter({ env: { CLAUDE_CODE_MESSAGING_SOCKET: socketPath, CLAUDE_CODE_MESSAGING_TOKEN: 'token' }, parentArgs: flag, notify, host: 'claude', windowMs: 20 })
    try {
      router.push(wake(makeMsg('a', 'rohanz')))
      router.push(wake(makeMsg('b', 'cat', 'note')))
      await pause()
      expect(lines).toHaveLength(2)
      expect(lines[0]).toHaveLength(2)
      expect(JSON.parse(lines[0][0])).toEqual({ type: 'auth', token: 'token' })
      const user = JSON.parse(lines[0][1])
      expect(user.type).toBe('user')
      expect(user.message.role).toBe('user')
      expect(user.message.content).toBe('[room] 1 thing needs you: rohanz asked a question. Use the room_state tool to read them. (#1)')
      expect(user.message.content).not.toContain('secret body')
      expect(notify).not.toHaveBeenCalled()
      router.push(wake(makeMsg('c', 'rohanz')))
      await pause()
      expect(JSON.parse(lines[1][1]).message.content).toBe('[room] 1 thing needs you: cat sent a note. Use the room_state tool to read them. (#2)')
      expect(lines).toHaveLength(3)
      expect(JSON.parse(lines[2][1]).message.content).toBe('[room] 1 thing needs you: rohanz asked a question. Use the room_state tool to read them. (#3)')
    } finally { router.close(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('mentions room_collect only for finished workers and limits the summary to five phrases', async () => {
    const post = vi.fn(async () => {})
    const router = new SocketWakeRouter({ env: { CLAUDE_CODE_MESSAGING_SOCKET: '/unused.sock' }, notify: vi.fn(async () => {}), post, host: 'claude', windowMs: 10 })
    try {
      for (let i = 0; i < 6; i++) router.push({ content: 'secret body must stay out of socket text', meta: { from: `worker${i}`, type: i === 5 ? 'done' : 'question' } })
      await pause()
      expect(post).toHaveBeenCalledTimes(2)
      expect(post.mock.calls[0][2]).toBe('[room] 1 thing needs you: worker0 asked a question. Use the room_state tool to read them. (#1)')
      expect(post.mock.calls[1][2]).toBe('[room] 5 things need you: worker1 asked a question; worker2 asked a question; worker3 asked a question; worker4 asked a question; worker5 finished. Use the room_state tool to read them (room_collect brings in finished workers). (#2)')
      expect(post.mock.calls[1][2]).not.toContain('secret body')
    } finally { router.close() }
  })

  it('falls back only with the channel flag when the socket is missing', async () => {
    const notify = vi.fn(async () => {})
    const router = new SocketWakeRouter({ env: { CLAUDE_CODE_MESSAGING_SOCKET: '/missing/room.sock', CLAUDE_CODE_MESSAGING_TOKEN: 't' }, parentArgs: flag, notify, host: 'claude', windowMs: 10 })
    router.push(wake(makeMsg('a', 'cat')))
    await pause()
    expect(notify).toHaveBeenCalledOnce()
    router.close()
    const noFlag = new SocketWakeRouter({ env: { CLAUDE_CODE_MESSAGING_SOCKET: '/missing/room.sock', CLAUDE_CODE_MESSAGING_TOKEN: 't' }, parentArgs: 'claude', notify, host: 'claude', windowMs: 10 })
    noFlag.push(wake(makeMsg('b', 'cat')))
    await pause()
    expect(notify).toHaveBeenCalledOnce()
    noFlag.close()
  })

  it('falls back when a previously bound inbox refuses connections', async () => {
    const dir = tmp(); const socketPath = path.join(dir, 'gone.sock')
    const server = net.createServer()
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
    await new Promise<void>(resolve => server.close(() => resolve()))
    const notify = vi.fn(async () => {})
    const router = new SocketWakeRouter({ env: { CLAUDE_CODE_MESSAGING_SOCKET: socketPath, CLAUDE_CODE_MESSAGING_TOKEN: 'token' }, parentArgs: flag, notify, host: 'claude', windowMs: 10 })
    try {
      router.push(wake(makeMsg('a', 'cat')))
      await pause()
      expect(notify).toHaveBeenCalledOnce()
    } finally { router.close(); fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('uses exactly one path after a socket post fails', async () => {
    const notify = vi.fn(async () => {})
    const post = vi.fn(async () => { throw new Error('refused') })
    const log = vi.fn()
    const router = new SocketWakeRouter({ env: { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/refused.sock', CLAUDE_CODE_MESSAGING_TOKEN: 't' }, parentArgs: flag, notify, post, log, host: 'claude', windowMs: 10 })
    router.push(wake(makeMsg('a', 'cat')))
    router.push(wake(makeMsg('b', 'dog')))
    await pause()
    expect(post).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[0][0].params.content).toBe('[room] 1 thing needs you: cat asked a question. Use the room_state tool to read them. (#1)')
    expect(notify.mock.calls[1][0].params.content).toBe('[room] 1 thing needs you: dog asked a question. Use the room_state tool to read them. (#2)')
    router.push(wake(makeMsg('c', 'cat')))
    await pause()
    expect(log).toHaveBeenCalledOnce()
    router.close()
  })

  it('handles a rejected channel fallback on immediate and timed socket wakes', async () => {
    vi.useFakeTimers()
    const notify = vi.fn(async () => {})
    const fallback = vi.spyOn(channel, 'sendChannelNotification').mockRejectedValue(new Error('channel refused'))
    const post = vi.fn(async () => { throw new Error('socket refused') })
    const log = vi.fn()
    const router = new SocketWakeRouter({ env: { CLAUDE_CODE_MESSAGING_SOCKET: '/unused.sock' }, parentArgs: flag, notify, post, log, host: 'claude', windowMs: 10 })
    try {
      router.push(wake(makeMsg('a', 'cat')))
      router.push(wake(makeMsg('b', 'dog')))
      await vi.advanceTimersByTimeAsync(10)
      expect(post).toHaveBeenCalledTimes(2)
      expect(fallback).toHaveBeenCalledTimes(2)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('channel refused'))
    } finally { router.close(); fallback.mockRestore(); vi.useRealTimers() }
  })

  it.each(['socket', 'channels', 'off'] as const)('honors ROOM_WAKE=%s', async mode => {
    const notify = vi.fn(async () => {})
    const router = new SocketWakeRouter({ env: { ROOM_WAKE: mode, CLAUDE_CODE_MESSAGING_SOCKET: '/missing/room.sock', CLAUDE_CODE_MESSAGING_TOKEN: 't' }, parentArgs: flag, notify, host: 'claude', windowMs: 10 })
    router.push(wake(makeMsg('a', 'cat')))
    await pause()
    expect(notify).toHaveBeenCalledTimes(mode === 'channels' ? 1 : 0)
    router.close()
  })

  it('ROOM_WAKE=channels sends even when parent-args detection misses a wrapper', async () => {
    const notify = vi.fn(async () => {})
    const router = new SocketWakeRouter({ env: { ROOM_WAKE: 'channels', CLAUDE_CODE_MESSAGING_SOCKET: '/unused.sock' }, parentArgs: 'wrapper', notify, host: 'claude' })
    router.push(wake(makeMsg('a', 'cat')))
    await pause(1)
    expect(notify).toHaveBeenCalledOnce()
    router.close()
  })

  it('does not wake for fyi chatter rejected by shouldWake', async () => {
    const notify = vi.fn(async () => {})
    const router = new SocketWakeRouter({ env: { ROOM_WAKE: 'channels' }, parentArgs: flag, notify, host: 'claude', windowMs: 10 })
    router.push(shouldWake(me, { kind: 'msg', msg: { ...makeMsg('fyi', 'cat', 'note', 'fyi'), to: undefined } }))
    await pause()
    expect(notify).not.toHaveBeenCalled()
    router.close()
  })

  it('uses socket or channel flag for wake availability, with off disabling both', () => {
    expect(claudeWakeAvailable({ host: 'claude', env: { CLAUDE_CODE_MESSAGING_SOCKET: '/x' }, parentArgs: 'claude' })).toBe(true)
    expect(claudeWakeAvailable({ host: 'claude', env: {}, parentArgs: flag })).toBe(true)
    expect(claudeWakeAvailable({ host: 'claude', env: {}, parentArgs: 'claude' })).toBe(false)
    expect(claudeWakeAvailable({ host: 'claude', env: { ROOM_WAKE: 'off', CLAUDE_CODE_MESSAGING_SOCKET: '/x' }, parentArgs: flag })).toBe(false)
  })
})
