import { describe, expect, it } from 'vitest'
import { canonicalRepo, repoRoomOf, roomKey, roomNameParts } from './rooms.js'

describe('repository room keys', () => {
  it('canonicalizes an origin-derived GitHub name without stripping a branch', () => {
    expect(canonicalRepo('github.com/OpenAI/Room')).toBe('github.com/openai/room')
    expect(canonicalRepo('git/GitLab.example.com/grp/app')).toBe('git/GitLab.example.com/grp/app')
    expect(canonicalRepo('local/x/special')).toBe('local/x/special')
  })

  it('maps a legacy name to the longest open repository prefix', () => {
    const open = new Set(['git/h/repo', 'git/h/repo/main', 'git/h/grp/repo'])
    const isOpen = (name: string) => open.has(name)
    expect(repoRoomOf('git/h/repo/main/topic', isOpen)).toBe('git/h/repo/main')
    expect(repoRoomOf('git/h/grp/repo/main', isOpen)).toBe('git/h/grp/repo')
    expect(repoRoomOf('git/h/other/repo/main', isOpen)).toBeUndefined()
  })

  it('parses branchless canonical names and preserves explicit local names', () => {
    expect(roomNameParts('github.com/openai/room')).toEqual({ host: 'github.com', owner: 'openai', repo: 'room', local: false })
    expect(roomNameParts('git/gitlab.example.com/team/app')).toEqual({ host: 'gitlab.example.com', owner: 'team', repo: 'app', local: false })
    expect(roomNameParts('local/x')).toEqual({ repo: 'x', local: true })
    expect(roomNameParts('local/x/special')).toEqual({ repo: 'x/special', local: true })
  })

  it('keys local rooms directly and team rooms by websocket origin', () => {
    expect(roomKey('local', 'local/x')).toBe('local/x')
    expect(roomKey('wss://room.example/ws/', 'github.com/o/r')).toBe('wss://room.example/github.com/o/r')
  })
})
