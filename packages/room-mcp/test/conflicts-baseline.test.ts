import { expect, it, vi } from 'vitest'
import { RoomDoc } from '@room/shared'
import type { Baseline } from '@room/roomd/baseline'
import { ConflictWatcher } from '../src/conflicts.js'

it('reports degraded carried-contract coverage when the baseline cannot be read', async () => {
  const room = new RoomDoc(), log = vi.fn()
  const watcher = new ConflictWatcher({ room, me: { name: 'worker', kind: 'agent' },
    liveText: async () => undefined, baseText: async () => { throw new Error('missing object') },
    baseFor: () => 'a'.repeat(40), mergeBase: async () => 'a'.repeat(40), log })
  const baseline: Baseline = { worker: 'worker', sha: 'a'.repeat(40), dir: '.', carriedCommit: false, untracked: new Map() }
  const changes = await (watcher as unknown as { carriedChanges(b: Baseline, lives: Map<string, string>): Promise<unknown[]> })
    .carriedChanges(baseline, new Map([['src/a.py', 'def f(): pass\n']]))
  expect(changes).toEqual([])
  expect(room.messages().some(message => message.type === 'note' && message.text.includes('contract coverage degraded'))).toBe(true)
  expect(log).toHaveBeenCalledWith(expect.stringContaining('missing object'))
  room.doc.destroy()
})
