import { describe, expect, it, vi } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, holderFence, participantRecord, validParticipantName } from '@room/shared'
import { GitHubProxy } from '../../server/src/github.js'
import { createPrs, handlers } from '../src/tools/prs.js'
import type { HandlerState } from '../src/tools/context.js'
import type { Session } from '../src/session.js'
import { visiblePeer } from './fixtures/visible.js'

describe('PR lookup and stored scopes', () => {
  it.each([['same repo', ['upstream']], ['fork', ['alice']], ['none', []], ['both', ['upstream', 'alice']], ['unrelated fork', ['carol']]] as const)('selects an explicit PR head: %s', async (_kind, owners) => {
    const room = new RoomDoc(), awareness = new Awareness(room.doc)
    const now = Date.now()
    const people = [{ name: 'alice', branch: 'feature' }, { name: 'bob', branch: 'main' }]
    for (const { name, branch } of people) {
      const sessionId = visiblePeer(room, name)
      room.participants.set(`${name}\0git`, { branch, head: 'base', base: 'base', anchored: true, rev: 1,
        fence: holderFence(participantRecord(room, name)?.holder)! })
      awareness.getStates().set(name === 'alice' ? awareness.clientID : awareness.clientID + 1,
        { user: { name, kind: 'agent' }, sessionId, lastActive: now })
    }
    const fork = { number: 7, title: 'Fork feature', user: { login: 'alice' }, head: { ref: 'feature', label: 'alice:feature' },
      updated_at: '2026-11-14T00:00:00Z', html_url: 'https://github.com/upstream/repo/pull/7' }
    // Respect GitHub's owner-qualified head filter; an unfiltered list includes all fork heads.
    const githubFetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname === '/user') return new Response(JSON.stringify({ login: 'alice' }))
      expect(url.pathname).toBe('/repos/upstream/repo/pulls')
      const body = owners.map((owner, i) => ({ ...fork, number: 7 + i, head: { ref: 'feature', label: `${owner}:feature`, user: { login: owner } } })).filter(pr => (!url.searchParams.has('base') || url.searchParams.get('base') === 'main') && (!url.searchParams.has('head') || url.searchParams.get('head') === pr.head.label))
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    })
    const proxy = new GitHubProxy({ fetch: githubFetch as typeof fetch })
    const post = vi.fn(async () => ({ url: fork.html_url, updated: false }))
    const s = { room, awareness, me: { name: 'alice', kind: 'agent' }, roomName: 'github.com/upstream/repo',
      post: vi.fn(async () => ({})) } as unknown as Session
    const deps = { ctx: { prs: { fetch: (_s: Session, opts?: { branch?: string }) =>
      proxy.openPrs('token', 'upstream/repo', opts?.branch ?? 'feature', {}), post } },
      now: () => now }
    const prs = createPrs(deps)
    const tools = handlers({ ...prs, S: () => s } as unknown as HandlerState)
    try {
      if (owners.length > 1) {
        await expect(tools.room_pr_note({})).rejects.toThrow(/#7 \(upstream:feature\).*#8 \(alice:feature\).*number=<n>/)
        expect(post).not.toHaveBeenCalled()
      } else {
        if (owners.length && owners[0] !== 'carol') {
          const reply = await tools.room_pr_note({})
          expect(reply).toContain('posted the room ledger comment on PR #7')
          expect(post).toHaveBeenCalledExactlyOnceWith(s, 7, expect.any(String))
        } else {
          await expect(tools.room_pr_note({})).rejects.toThrow(/no open pull request.*upstream:feature or alice:feature.*another account.*number=<n>/)
          expect(post).not.toHaveBeenCalled()
        }
      }
      expect(githubFetch).toHaveBeenCalledTimes(3)
      const queries = githubFetch.mock.calls.slice(1).map(call => new URL(String(call[0])).searchParams)
      expect(queries.map(query => query.get('head'))).toEqual(['upstream:feature', 'alice:feature'])
      expect(queries.every(query => !query.has('page') && !query.has('base'))).toBe(true)
    } finally { awareness.destroy(); room.doc.destroy() }
  })

  it('preserves a real numbered bot participant scope with a current holder', () => {
    const room = new RoomDoc()
    try {
      const name = 'pr#7'
      expect(validParticipantName(name)).toBe(true)
      visiblePeer(room, name, 'bot')
      room.setScope({ by: name, byKind: 'bot', area: 'api', summary: 'real bot maintenance', paths: ['src/api.ts'] })
      expect(participantRecord(room, name)?.holder).toBeDefined()
      expect(room.scope(name)?.summary).toBe('real bot maintenance')
      expect(room.allScopes().map(scope => scope.by)).toContain(name)
    } finally { room.doc.destroy() }
  })
})
