import { expect, it, vi } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import { holderFence, participantRecord, RoomDoc } from '@room/shared'
import { GitHubProxy } from '../../server/src/github.js'
import { createPrs, handlers } from '../src/tools/prs.js'
import type { HandlerState } from '../src/tools/context.js'
import type { Session } from '../src/session.js'
import { visiblePeer } from './fixtures/visible.js'

it('does not post to a competing fork when an updated matching PR moves across the page boundary', async () => {
  const room = new RoomDoc(), awareness = new Awareness(room.doc)
  const name = 'alice', sessionId = visiblePeer(room, name)
  room.participants.set(`${name}\0git`, { branch: 'topic', head: 'base', base: 'base', anchored: true, rev: 1,
    fence: holderFence(participantRecord(room, name)?.holder)! })
  awareness.setLocalState({ user: { name, kind: 'agent' }, sessionId, lastActive: Date.now() })
  const raw = (number: number, owner: string, ref: string) => ({ number, title: `PR ${number}`,
    head: { ref, label: `${owner}:${ref}`, user: { login: owner } } })
  const competing = raw(1, 'someone-else', 'topic'), own = raw(101, 'upstream', 'topic')
  let ordered = [competing, ...Array.from({ length: 99 }, (_, i) => raw(i + 2, 'upstream', `other/${i}`)), own]
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input))
    if (url.pathname === '/user') return new Response('{"login":"alice"}')
    expect(url.pathname).toBe('/repos/upstream/repo/pulls')
    const head = url.searchParams.get('head')
    const list = head ? ordered.filter(pr => pr.head.label === head) : ordered
    const page = Number(url.searchParams.get('page') ?? 1)
    const body = list.slice((page - 1) * 100, page * 100)
    if (!head && page === 1 && url.searchParams.get('sort') === 'updated') {
      // One ordinary PR edit between requests moves the formerly 101st item to the front.
      ordered = [own, ...ordered.filter(pr => pr !== own)]
    }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  })
  const proxy = new GitHubProxy({ fetch: fetch as typeof globalThis.fetch })
  const post = vi.fn(async (_s: Session, _number: number, _body: string) => ({ url: '', updated: false }))
  const s = { room, awareness, me: { name, kind: 'agent' }, roomName: 'github.com/upstream/repo',
    post: vi.fn(async () => ({})) } as unknown as Session
  const deps = { ctx: { prs: { fetch: (_s: Session, opts?: { branch?: string }) =>
    proxy.openPrs('token', 'upstream/repo', opts?.branch ?? 'topic', {}), post } },
    now: Date.now }
  const tools = handlers({ ...createPrs(deps), S: () => s } as unknown as HandlerState)
  try {
    const reply = await tools.room_pr_note({})
    expect(reply).toContain('posted the room ledger comment on PR #101')
    expect(post.mock.calls.map(call => call[1])).toEqual([own.number])
    const heads = fetch.mock.calls.map(call => new URL(String(call[0]))).filter(url => url.pathname.endsWith('/pulls'))
    expect(heads.map(url => url.searchParams.get('head'))).toEqual(['upstream:topic', 'alice:topic'])
    expect(heads.every(url => !url.searchParams.has('page'))).toBe(true)
  } finally { awareness.destroy(); room.doc.destroy() }
})
