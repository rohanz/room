import { expect, it, vi } from 'vitest'
import { digestPath, manifestKey } from '@room/shared'
import * as gitModule from '@room/roomd/git'
import { base, carry, lead, put, setup, worker } from './collect-fixture.js'
import { publishFixture } from './fixtures/manifest.js'
import { stampLocalPublisher } from './fixtures/local-publisher.js'
import { buildCombinedTree } from '../src/tools/combined-tree.js'
import type { Session } from '../src/session.js'
import type { HandlerState } from '../src/tools/context.js'

async function fixture() {
  const t = setup()
  carry(t, worker, 'test', { 'file.txt': 'inherited\n' })
  t.set('test', { ...t.get('test'), exitCode: 0 })
  put(lead, 'file.txt', 'inherited\n')
  await t.sync()
  t.s.daemon.fence = '1'
  t.s.daemon.reconcileGitChanges = async () => {
    publishFixture(t.s.room, 'lead', 'file.txt', 'inherited\n', { base })
    t.s.room.participants.set('lead\0git', { ...t.s.room.participants.get('lead\0git')!, head: base })
  }
  t.s.daemon.settle = async () => {}
  await t.s.daemon.reconcileGitChanges()
  stampLocalPublisher(t.s)
  put(worker, 'file.txt', 'worker edit\n')
  const caller = { ...t.s, dir: worker, me: { name: 'lead+test', kind: 'agent' } } as Session
  const state = { ...t.state, S: () => caller, baseFor: () => base, shareOf: () => 'full' } as HandlerState
  const exclude = () => {
    const head = t.s.room.manifestHead.get('lead')!, key = manifestKey('lead', head.fence)
    t.s.room.manifest.get(key)!.delete('file.txt')
    t.s.room.clearOverlay(key, 'file.txt')
    t.s.room.manifestHead.set('lead', { ...head, rev: head.rev + 1, semRev: head.semRev + 1,
      excluded: [digestPath(t.s.room.ensureRoomSalt(), 'file.txt')] })
  }
  return { exclude, build: () => buildCombinedTree(state, caller, [{ person: 'lead', session: caller }]) }
}

it('rebuilds with a gap if a contributor path becomes excluded during assembly', async () => {
  const t = await fixture(), run = gitModule.git
  let changed = false
  const spy = vi.spyOn(gitModule, 'git').mockImplementation(async (...args) => {
    const result = await run(...args)
    // Publications are captured before AssemblyInputs resolves checkout heads.
    if (!changed && args[1].includes('--absolute-git-dir')) { changed = true; t.exclude() }
    return result
  })
  try {
    const result = await t.build()
    expect(changed).toBe(true)
    expect(result.complete, JSON.stringify(result.gaps)).toBe(false)
    expect(result.gaps.some(gap => gap.path === 'file.txt')).toBe(true)
    expect(result.merged.has('file.txt')).toBe(false)
  } finally { spy.mockRestore() }
})

it('invalidates a complete snapshot if its contributor path becomes excluded later', async () => {
  const t = await fixture(), result = await t.build()
  expect(result.complete, JSON.stringify(result.gaps)).toBe(true)
  expect(result.merged.get('file.txt')).toBe('worker edit\n')
  expect(await result.isCurrent()).toBe(true)
  t.exclude()
  expect(await result.isCurrent()).toBe(false)
})
