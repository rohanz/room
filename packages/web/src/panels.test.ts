import { describe, expect, it } from 'vitest'
import type { Conn } from './conn.ts'
import { agentPresence, people } from './panels.ts'

describe('agent presence selection', () => {
  it('matches both the person name and agent kind', () => {
    const states = new Map<number, unknown>([
      [1, { user: { name: 'Rohan', kind: 'human', color: '#111' }, status: 'editing' }],
      [2, { user: { name: 'Rohan', kind: 'agent', color: '#222' }, status: 'thinking' }],
    ])
    const conn = { provider: { awareness: { getStates: () => states } }, me: { name: 'Rohan' } } as unknown as Conn
    expect(agentPresence(conn, 'Rohan')?.status).toBe('thinking')
    expect(people(conn)[0]).toMatchObject({ human: { status: 'editing' }, agent: { status: 'thinking' } })
  })
})
