import { afterEach, describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, type Identity } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { claudeWakeAvailable, createWakeSender, type SendWake } from '../src/wake-path.js'
import { WakeReconciler } from '../src/wake-reconciler.js'
import { Ledger } from '../src/ledger.js'
import type { Session } from '../src/session.js'

const pause = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms))
const flag = 'claude --dangerously-load-development-channels plugin:room@room'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'room-socket-wake-'))
const claude = { id: 'claude-1', host: 'claude' as const }
const TEXT = '[room] 1 thing needs you: cat asked a question. Call room_state; it shows them. (#1)'

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })

describe('wake paths (content-free; never a receipt)', () => {
  it('Codex: the queue, for the bound thread', async () => {
    const queue = vi.fn(async () => {})
    expect(await createWakeSender({ notify: vi.fn(), queue })({ id: 'thread-1', host: 'codex' }, TEXT)).toBe('queue')
    expect(queue).toHaveBeenCalledWith('thread-1', TEXT)
  })

  it('Claude: writes auth then user JSON lines to the inbox socket', async () => {
    const dir = tmp(); const socketPath = path.join(dir, 'inbox.sock'); const lines: string[][] = []
    const server = net.createServer(c => { let data = ''; c.on('data', chunk => { data += chunk }); c.on('end', () => lines.push(data.trim().split('\n'))) })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
    const notify = vi.fn(async () => {})
    try {
      const send = createWakeSender({ env: { CLAUDE_CODE_MESSAGING_SOCKET: socketPath, CLAUDE_CODE_MESSAGING_TOKEN: 'token' }, parentArgs: flag, notify })
      expect(await send(claude, TEXT)).toBe('socket')
      await vi.waitFor(() => expect(lines).toHaveLength(1))
      expect(JSON.parse(lines[0][0])).toEqual({ type: 'auth', token: 'token' })
      expect(JSON.parse(lines[0][1])).toEqual({ type: 'user', message: { role: 'user', content: TEXT } })
      expect(notify).not.toHaveBeenCalled()
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('falls back to the channel only when it is admitted; otherwise the socket failure propagates', async () => {
    const notify = vi.fn(async () => {})
    const env = { CLAUDE_CODE_MESSAGING_SOCKET: '/missing/room.sock', CLAUDE_CODE_MESSAGING_TOKEN: 't' }
    expect(await createWakeSender({ env, parentArgs: flag, notify })(claude, TEXT)).toBe('channel')
    expect(notify).toHaveBeenCalledWith({ method: 'notifications/claude/channel', params: { content: TEXT, meta: { type: 'room_wake' } } })
    await expect(createWakeSender({ env, parentArgs: 'claude', notify })(claude, TEXT)).rejects.toThrow()
    expect(notify).toHaveBeenCalledOnce()
  })

  it('falls back when a previously bound inbox refuses connections', async () => {
    const dir = tmp(); const socketPath = path.join(dir, 'gone.sock')
    const server = net.createServer()
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
    await new Promise<void>(resolve => server.close(() => resolve()))
    const notify = vi.fn(async () => {})
    try {
      expect(await createWakeSender({ env: { CLAUDE_CODE_MESSAGING_SOCKET: socketPath }, parentArgs: flag, notify })(claude, TEXT)).toBe('channel')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('a channel failure rejects instead of being swallowed', async () => {
    const notify = vi.fn(async () => { throw new Error('transport closed') })
    const post = vi.fn(async () => { throw new Error('socket refused') })
    await expect(createWakeSender({ env: { CLAUDE_CODE_MESSAGING_SOCKET: '/unused.sock' }, parentArgs: flag, notify, post })(claude, TEXT)).rejects.toThrow('transport closed')
    await expect(createWakeSender({ env: { ROOM_WAKE: 'channels' }, parentArgs: flag, notify })(claude, TEXT)).rejects.toThrow('transport closed')
  })

  it('without a socket or an admitted channel there is no path: undefined, not an error', async () => {
    const notify = vi.fn(async () => {})
    expect(await createWakeSender({ env: {}, parentArgs: 'claude', notify })(claude, TEXT)).toBeUndefined()
    expect(notify).not.toHaveBeenCalled()
  })

  it.each(['socket', 'channels', 'off'] as const)('honors ROOM_WAKE=%s', async mode => {
    const notify = vi.fn(async () => {})
    const send = createWakeSender({ env: { ROOM_WAKE: mode, CLAUDE_CODE_MESSAGING_SOCKET: '/missing/room.sock', CLAUDE_CODE_MESSAGING_TOKEN: 't' }, parentArgs: flag, notify })
    if (mode === 'socket') await expect(send(claude, TEXT)).rejects.toThrow()
    else expect(await send(claude, TEXT)).toBe(mode === 'channels' ? 'channel' : undefined)
    expect(notify).toHaveBeenCalledTimes(mode === 'channels' ? 1 : 0)
  })

  it('ROOM_WAKE=channels sends even when parent-args detection misses a wrapper', async () => {
    const notify = vi.fn(async () => {})
    expect(await createWakeSender({ env: { ROOM_WAKE: 'channels', CLAUDE_CODE_MESSAGING_SOCKET: '/unused.sock' }, parentArgs: 'wrapper', notify })(claude, TEXT)).toBe('channel')
  })

  it('uses socket or channel flag for wake availability, with off disabling both', () => {
    expect(claudeWakeAvailable({ host: 'claude', env: { CLAUDE_CODE_MESSAGING_SOCKET: '/x' }, parentArgs: 'claude' })).toBe(true)
    expect(claudeWakeAvailable({ host: 'claude', env: {}, parentArgs: flag })).toBe(true)
    expect(claudeWakeAvailable({ host: 'claude', env: {}, parentArgs: 'claude' })).toBe(false)
    expect(claudeWakeAvailable({ host: 'claude', env: { ROOM_WAKE: 'off', CLAUDE_CODE_MESSAGING_SOCKET: '/x' }, parentArgs: flag })).toBe(false)
  })
})

describe('the reconciler: one pointer per host session', () => {
  const me: Identity = { name: 'Rohan', kind: 'agent' }
  function setup(send: SendWake, windowMs = 5_000) {
    const room = new RoomDoc()
    const s = { room, awareness: new Awareness(room.doc), me, roomName: 'r', dir: os.tmpdir() } as unknown as Session
    const ledger = new Ledger({ sessionId: () => 'claude-1', route: () => ({}) })
    const wakes = new WakeReconciler({ ledger, bound: () => claude, sessionDir: () => undefined, send, windowMs, backoffMs: [5] })
    ledger.bind(s); wakes.attach(s)
    const ask = (from: string, type: 'question' | 'note' = 'question', extra: object = {}) =>
      hubAppend(room, { name: from, kind: 'agent' }, { type, to: 'Rohan', text: 'secret body must stay out of the wake', ...extra } as never)
    return { s, room, ledger, wakes, ask, close() { wakes.stop(); s.awareness.destroy() } }
  }

  it('wakes at once, then gathers what arrives in the window into one follow-up', async () => {
    vi.useFakeTimers()
    const texts: string[] = []
    const t = setup(async (_target, text) => { texts.push(text); return 'socket' })
    try {
      t.ask('cat')
      await vi.advanceTimersByTimeAsync(0)
      expect(texts).toEqual([TEXT])
      for (let i = 0; i < 4; i++) t.ask(`worker${i}`)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(texts).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(texts).toHaveLength(2)
      expect(texts[1]).toBe('[room] 4 things need you: worker0 asked a question; worker1 asked a question; worker2 asked a question; worker3 asked a question. Call room_state; it shows them. (#2)')
      expect(texts.join('\n')).not.toContain('secret body')
    } finally { t.close() }
  })

  it('names at most four senders when more than five are waiting', async () => {
    const texts: string[] = []
    const t = setup(async (_target, text) => { texts.push(text); return 'socket' })
    try {
      for (let i = 0; i < 6; i++) t.ask(`worker${i}`, i === 5 ? 'note' : 'question')
      await vi.waitFor(() => expect(texts).toHaveLength(1))
      expect(texts[0]).toBe('[room] 6 things need you: worker0 asked a question; worker1 asked a question; worker2 asked a question; worker3 asked a question; 2 more. Call room_state; it shows them. (#1)')
    } finally { t.close() }
  })

  it('leaves out what a receipt already covers, and fyi chatter', async () => {
    vi.useFakeTimers()
    const texts: string[] = []
    const t = setup(async (_target, text) => { texts.push(text); return 'socket' }, 10)
    try {
      const read = t.ask('bridge')
      t.room.markSeen('Rohan', [read.id], { s: 'claude-1', via: 'reply' })
      hubAppend(t.room, { name: 'cat', kind: 'agent' }, { type: 'note', priority: 'fyi', text: 'chatter' })
      await vi.advanceTimersByTimeAsync(20)
      expect(texts).toEqual([])
      t.ask('Ada', 'note')
      await vi.advanceTimersByTimeAsync(20)
      expect(texts).toEqual(['[room] 1 thing needs you: Ada sent a note. Call room_state; it shows them. (#1)'])
    } finally { t.close() }
  })

  it('a failed send retries with backoff and records nothing until it succeeds', async () => {
    vi.useFakeTimers()
    let calls = 0
    const t = setup(async () => { calls++; if (calls < 3) throw new Error('inbox refused'); return 'socket' }, 0)
    try {
      t.ask('cat')
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(20)
      expect(calls).toBe(3)
      await vi.advanceTimersByTimeAsync(100)
      expect(calls).toBe(3)
    } finally { t.close() }
  })

  it('with no path for this host it sends nothing more and does not retry', async () => {
    vi.useFakeTimers()
    const send = vi.fn(async () => undefined)
    const t = setup(send, 0)
    try {
      t.ask('cat')
      await vi.advanceTimersByTimeAsync(100)
      expect(send).toHaveBeenCalledOnce()
    } finally { t.close() }
  })

  it('with no bound session it waits, and wakes once one binds', async () => {
    vi.useFakeTimers()
    const room = new RoomDoc()
    const s = { room, awareness: new Awareness(room.doc), me, roomName: 'r', dir: os.tmpdir() } as unknown as Session
    const ledger = new Ledger({ sessionId: () => 'x', route: () => ({}) })
    let bound: typeof claude | undefined
    const send = vi.fn(async () => 'queue' as const)
    const wakes = new WakeReconciler({ ledger, bound: () => bound, sessionDir: () => undefined, send, pollMs: 10 })
    ledger.bind(s); wakes.attach(s)
    try {
      hubAppend(room, { name: 'cat', kind: 'agent' }, { type: 'question', to: 'Rohan', text: '?' })
      await vi.advanceTimersByTimeAsync(30)
      expect(send).not.toHaveBeenCalled()
      bound = claude
      await vi.advanceTimersByTimeAsync(15)
      expect(send).toHaveBeenCalledOnce()
    } finally { wakes.stop(); s.awareness.destroy() }
  })
})
