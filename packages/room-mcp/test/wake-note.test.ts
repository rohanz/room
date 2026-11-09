import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionWakeNote } from '../src/prompt.js'
import { wakeText } from '../src/hosts/prompt.js'
import type { Session } from '../src/session.js'

const session = () => ({ dir: '/tmp/repo' }) as Session

afterEach(() => vi.unstubAllEnvs())
beforeEach(() => { vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', undefined); vi.stubEnv('ROOM_WAKE', undefined) })

describe('Claude wake guidance', () => {
  it('is silent while alone in a local room, then appears once at the first spawn', () => {
    const s = session()
    const opts = { host: 'claude' }
    expect(sessionWakeNote(s, 'alone', opts)).toBe('')
    const first = sessionWakeNote(s, 'spawn', opts)
    expect(first.split('\n')[0]).toContain('Continue independent work while workers run.')
    expect(first.split('\n').slice(1).join('\n')).toBe(wakeText())
    expect(first).toContain('Pending messages can arrive on Room tool replies')
    expect(first).toContain('room_wait(questionId/claimId)')
    expect(first).toContain('Keep headless leads alive until supervision is complete')
    expect(first).toContain('A timeout is not an answer or approval')
    expect(first).not.toContain('Block on room_wait in a loop')
    expect(sessionWakeNote(s, 'spawn', opts)).toBe('')
  })

  it('speaks once when a teammate appears, then gives only the worker wait instruction at spawn', () => {
    const s = session()
    const opts = { host: 'claude' }
    const first = sessionWakeNote(s, 'company', opts)
    expect(first).toContain('For your human:')
    expect(first).not.toContain('Continue independent work while workers run.')
    expect(sessionWakeNote(s, 'company', opts)).toBe('')
    const spawn = sessionWakeNote(s, 'spawn', opts)
    expect(spawn).toContain('Continue independent work while workers run.')
    expect(sessionWakeNote(s, 'spawn', opts)).toBe('')
  })

  it('warns for unavailable Claude wake and stays silent for Codex', () => {
    expect(sessionWakeNote(session(), 'spawn', { host: 'claude' })).toContain('For your human:')
    expect(sessionWakeNote(session(), 'spawn', { host: 'codex' })).toBe('')
  })

  it('omits guidance when the socket is exported, and warns under ROOM_WAKE=off', () => {
    vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', '/tmp/claude.sock')
    expect(sessionWakeNote(session(), 'company', { host: 'claude' })).toBe('')
    vi.stubEnv('ROOM_WAKE', 'off')
    const off = sessionWakeNote(session(), 'company', { host: 'claude' })
    expect(off).toContain('ROOM_WAKE=off')
    expect(off).not.toContain('update Claude Code')
  })

  it('explains socket diagnosis and tool/hook delivery without shell setup', () => {
    const note = wakeText()
    expect(note).toContain('no wake path is available')
    expect(note).toContain('2.1.224 or later (2.1.234 or later on native Windows)')
    expect(note).toContain('Peer address')
    expect(note).toContain('Messages remain owed')
    expect(note).toContain('eligible hooks')
  })
})
