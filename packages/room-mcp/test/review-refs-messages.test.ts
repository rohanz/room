import fs from 'node:fs'
import { expect, it, vi } from 'vitest'
import { realRepo, setupLead } from './workers-fixture.js'
import { registryForDir } from '../src/worker-registry.js'

it.each(['collect-no-commits', 'collect-commits', 'discard', 'discard-behind-base', 'keep'] as const)('lifecycle %s pins every removed branch and reports it once', async action => {
  const actual = await vi.importActual<typeof import('../src/worker-git.js')>('../src/worker-git.js')
  const loaded = await import('../src/worker-git.js')
  if (vi.isMockFunction(loaded.cleanupWorker)) loaded.cleanupWorker.mockImplementation(actual.cleanupWorker)
  if (vi.isMockFunction(loaded.saveDiscardPatch)) loaded.saveDiscardPatch.mockImplementation(actual.saveDiscardPatch)
  const { repo, head, git } = realRepo()
  if (action === 'discard-behind-base') git('commit', '--allow-empty', '-qm', 'valuable base commit')
  const base = git('rev-parse', 'HEAD'), t = setupLead(repo, base), registry = await registryForDir(repo)
  expect(await t.leadTools.call('room_spawn', { tag: 'lifetime', task: 'x', carry: false })).toContain('spawned lifetime')
  const record = (await registry.reserved('lifetime'))!
  if (action !== 'collect-no-commits' && action !== 'discard-behind-base') git('-C', record.dir, 'commit', '--allow-empty', '-qm', 'worker commit')
  const tip = git('-C', record.dir, 'rev-parse', 'HEAD')
  if (action === 'discard-behind-base') git('reset', '--hard', head)
  t.exits[0](0)
  await vi.waitFor(async () => expect((await registry.status(record.id))?.status).toBe('done'))
  const reply = await t.leadTools.call('room_collect', { tag: record.tag, ...(action === 'keep' ? { keep: true } : action.startsWith('discard') ? { discard: true } : {}) })
  expect(reply).not.toContain('error:')
  const pins = git('for-each-ref', '--format=%(refname)', 'refs/room/recovery/')
  if (action !== 'keep') {
    const branchRef = `refs/room/recovery/lifetime/${tip}`
    const patchBaseRef = action.startsWith('discard') ? (await registry.read(record.id))!.discard!.baseRef! : branchRef
    expect(pins.split('\n').sort()).toEqual([...new Set([branchRef, patchBaseRef])].sort())
    expect(git('rev-parse', `${branchRef}^{commit}`)).toBe(tip)
    expect(reply.split('branch recovery ref: ' + branchRef + ' (kept for seven days)')).toHaveLength(2)
    if (patchBaseRef !== branchRef) {
      expect(git('rev-parse', `${patchBaseRef}^{commit}`)).toBe(base)
      expect(reply.split('recovery patch base ref: ' + patchBaseRef + ' (kept for seven days)')).toHaveLength(2)
    }
  } else expect(pins).toBe('')
  expect(fs.existsSync(record.dir)).toBe(action === 'keep')
})
