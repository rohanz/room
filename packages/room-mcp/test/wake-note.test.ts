import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionWakeNote } from '../src/prompt.js'
import { wakeText } from '../src/hosts/prompt.js'
import type { Session } from '../src/session.js'

const plainClaude = 'claude'
const admittedClaude = 'claude --dangerously-load-development-channels plugin:room@room'
const session = () => ({ dir: '/tmp/repo' }) as Session

afterEach(() => vi.unstubAllEnvs())
beforeEach(() => { vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', undefined); vi.stubEnv('ROOM_WAKE', undefined) })

describe('Claude wake guidance', () => {
  it('is silent while alone in a local room, then appears once at the first spawn', () => {
    const s = session()
    const opts = { host: 'claude', parentArgs: plainClaude, shell: '/bin/zsh' }
    expect(sessionWakeNote(s, 'alone', opts)).toBe('')
    const first = sessionWakeNote(s, 'spawn', opts)
    expect(first.split('\n')[0]).toContain('Continue independent work while workers run.')
    expect(first.split('\n').slice(1).join('\n')).toBe(wakeText('/bin/zsh'))
    expect(first).toContain('Pending messages can arrive on Room tool replies')
    expect(first).toContain('room_wait(questionId/claimId)')
    expect(first).toContain('Keep headless leads alive until supervision is complete')
    expect(first).toContain('A timeout is not an answer or approval')
    expect(first).not.toContain('Block on room_wait in a loop')
    expect(sessionWakeNote(s, 'spawn', opts)).toBe('')
  })

  it('speaks once when a teammate appears, then gives only the worker wait instruction at spawn', () => {
    const s = session()
    const opts = { host: 'claude', parentArgs: plainClaude, shell: '/bin/zsh' }
    const first = sessionWakeNote(s, 'company', opts)
    expect(first).toContain('For your human:')
    expect(first).not.toContain('Continue independent work while workers run.')
    expect(sessionWakeNote(s, 'company', opts)).toBe('')
    const spawn = sessionWakeNote(s, 'spawn', opts)
    expect(spawn).toContain('Continue independent work while workers run.')
    expect(sessionWakeNote(s, 'spawn', opts)).toBe('')
  })

  it('is silent for channels and Codex, but warns when both wake paths are disabled', () => {
    expect(sessionWakeNote(session(), 'spawn', { host: 'claude', parentArgs: admittedClaude })).toBe('')
    vi.stubEnv('ROOM_CLAUDE_CHANNEL', '')
    expect(sessionWakeNote(session(), 'spawn', { host: 'claude', parentArgs: plainClaude })).toContain('For your human:')
    vi.stubEnv('ROOM_CLAUDE_CHANNEL', undefined)
    expect(sessionWakeNote(session(), 'spawn', { host: 'codex', parentArgs: plainClaude })).toBe('')
  })

  it('omits guidance when the socket is exported, and warns under ROOM_WAKE=off', () => {
    vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', '/tmp/claude.sock')
    expect(sessionWakeNote(session(), 'company', { host: 'claude', parentArgs: plainClaude })).toBe('')
    vi.stubEnv('ROOM_WAKE', 'off')
    const off = sessionWakeNote(session(), 'company', { host: 'claude', parentArgs: admittedClaude })
    expect(off).toContain('ROOM_WAKE=off')
    expect(off).not.toContain('update Claude Code')
  })

  it('prints a copyable alias for the current shell, defaulting to zsh', () => {
    for (const [shell, rc] of [['/bin/zsh', '~/.zshrc'], ['/bin/bash', '~/.bashrc'], [undefined, '~/.zshrc']] as const) {
      const note = wakeText(shell)
      expect(note.split('\n')[0]).toContain('no wake path is available for this Claude Code session')
      expect(note.split('\n')[1]).toContain('2.1.224 or later')
      expect(note.split('\n')[2]).toBe(`If a socket is unavailable, start Claude Code with \`claude-room\`. If that command is not found, add it: \`echo "alias claude-room='claude --dangerously-load-development-channels plugin:room@room'" >> ${rc}\``)
      expect(note).toContain(`echo "alias claude-room='claude --dangerously-load-development-channels plugin:room@room'" >> ${rc}`)
      expect(note).toContain('claude.ai Team or Enterprise')
      expect(note).not.toContain('room_wait')
      expect(note.split('\n').length).toBe(4)
    }
  })
})
