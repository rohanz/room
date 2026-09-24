import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RoomDoc } from '@room/shared'
import type { Session } from '../src/session.js'
import type { HandlerState } from '../src/tools/context.js'

vi.mock('../src/merge.js', () => ({
  gitMergeFile: vi.fn(async () => ({ status: 'clean', text: 'merged\n', chunks: [{ ok: ['merged', ''] }], conflicts: [], algorithm: 'fallback', fallbackReason: 'simulated git failure' })),
}))
import { buildCombinedTree } from '../src/tools/combined-tree.js'

let root: string | undefined
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined })

it('prints the actual fallback algorithm and reason in a merge preview', async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-algorithm-')))
  const git = (...args: string[]) => execFileSync('git', ['-C', root!, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(root, 'base.txt'), 'mine\n')
  const room = new RoomDoc(); room.setMeta({ base }); room.setOverlay('peer', 'base.txt', 'theirs\n')
  const caller = { me: { name: 'lead' }, dir: root, room, local: false } as Session
  const participant = { me: { name: 'peer' }, dir: root, room, local: false } as Session
  const state = { rooms: { holding: () => participant }, liveText: async (_s: Session, p: string, person: string) => person === 'peer' ? room.text(p, person) : undefined,
    baseFor: () => base, shareOf: () => 'full' } as unknown as HandlerState
  const preview = await buildCombinedTree(state, caller, [{ person: 'peer', session: participant }])
  expect(preview.out[0]).toContain('merge algorithm: fallback')
  expect(preview.out[0]).toContain('fallback reason: simulated git failure')
  room.doc.destroy()
})
