// A session the server refused before its join returned (4409 captured at startup) is replaced once that join
// settles, as index.ts wires the auto-join (review round 1).
import { expect, it } from 'vitest'
import { AutoJoin } from '../src/auto-join.js'
import { StaleReplacement, rejoinWhenStale } from '../src/compacted.js'
import type { Session } from '../src/session.js'
import { testPolicyStore } from './policy-fixture.js'

const session = (name: string, stale?: boolean) => ({ policyStore: testPolicyStore(), roomName: 'github.com/o/r', dir: '/x', roomUrl: 'ws://h/github.com%2Fo%2Fr', me: { name }, room: { openClaims: () => [] }, lease: { sessionId: 'host-1' },
  ...(stale ? { stale: { reason: 'compacted' } } : {}) }) as unknown as Session

it('a session already stale at adoption is replaced after its own join settles', async () => {
  let current: Session | null = null
  const dropped: Session[] = []
  const first = session('ada', true), fresh = session('ada')
  const joined: Session[] = []
  let autoJoin!: AutoJoin
  const replacement = new StaleReplacement({ joinedSessions: () => current ? [current] : [], drop: async s => { dropped.push(s); if (current === s) current = null },
    attachWorkersRoom: () => {}, log: () => {}, join: async () => fresh })
  autoJoin = new AutoJoin({ local: false, log: () => {}, report: () => {}, discard: async () => {}, delaysMs: [10],
    joined: () => !!current && !current.stale,
    attempt: async () => { if (await replacement.begin(current)) return replacement.join(); return first },
    adopt: async s => {
      const adopt = async (x: Session) => { current = x; joined.push(x); rejoinWhenStale(x, () => current, autoJoin) }
      if (replacement.active) await replacement.finish(s, adopt); else await adopt(s)
    } })
  await autoJoin.ensure()
  for (let i = 0; i < 100 && current !== fresh; i++) await new Promise(r => setTimeout(r, 5))
  expect(current).toBe(fresh)
  expect(dropped).toEqual([first])
  expect(joined).toEqual([first, fresh])
})

it('a late stale callback cannot resume an automatic join cancelled by shutdown or leaving', async () => {
  const stale = session('ada', true)
  let attempts = 0
  const autoJoin = new AutoJoin({ local: false, log: () => {}, report: () => {}, discard: async () => {},
    joined: () => false, attempt: async () => { attempts++; return session('unexpected') }, adopt: async () => {} })
  autoJoin.cancel()
  rejoinWhenStale(stale, () => stale, autoJoin)
  await new Promise(resolve => setTimeout(resolve, 20))
  await autoJoin.settle()
  expect(attempts).toBe(0)
})
