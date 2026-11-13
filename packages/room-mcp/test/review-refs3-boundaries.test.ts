import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import * as baseline from '@room/roomd/baseline'
import { realRepo, setupLead } from './workers-fixture.js'
import { registryForDir } from '../src/worker-registry.js'
import { previewCachePath, runInMergedTree, waitForPreviewSweepForTests } from '../src/tools/files.js'
import type { Session } from '../src/session.js'

const boundary = vi.hoisted(() => ({ beforeForcedAdd: undefined as (() => void) | undefined }))
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const raw = Array.isArray(args[1]) ? args[1] : []
    const command = args[0] === 'git' ? raw : args[0] === 'sh' && raw[3] === 'git' ? raw.slice(4) : []
    if (command[0] === 'worktree' && command[1] === 'add' && command.filter(arg => arg === '--force').length === 2) {
      const inject = boundary.beforeForcedAdd
      boundary.beforeForcedAdd = undefined
      inject?.()
    }
    return actual.spawn(...args)
  } }
})

it.each(['collect', 'discard'] as const)('review refs3: %s reports a pin even when worktree removal fails', async action => {
  const actual = await vi.importActual<typeof import('../src/worker-git.js')>('../src/worker-git.js')
  const loaded = await import('../src/worker-git.js')
  if (vi.isMockFunction(loaded.cleanupWorker)) loaded.cleanupWorker.mockImplementation(actual.cleanupWorker)
  if (vi.isMockFunction(loaded.saveDiscardPatch)) loaded.saveDiscardPatch.mockImplementation(actual.saveDiscardPatch)
  const { repo, head, git } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
  expect(await t.leadTools.call('room_spawn', { tag: 'refs3', task: 'review', carry: false })).toContain('spawned refs3')
  const record = (await registry.reserved('refs3'))!
  t.exits[0](0)
  await vi.waitFor(async () => expect((await registry.status(record.id))?.status).toBe('done'))
  const run = baseline.boundedGitSync
  const spy = vi.spyOn(baseline, 'boundedGitSync').mockImplementation((...args) => {
    if (args[1].includes('worktree') && args[1].includes('remove') && args[1].includes(record.dir)) throw new Error('injected removal failure')
    return run(...args)
  })
  let reply
  try { reply = await t.leadTools.call('room_collect', { tag: record.tag, ...(action === 'discard' ? { discard: true } : {}) }) }
  finally { spy.mockRestore() }
  expect(reply).toContain('injected removal failure')
  const pin = git('for-each-ref', '--format=%(refname)', 'refs/room/recovery/')
  expect(pin).toBe(`refs/room/recovery/${record.tag}/${head}`)
  expect(reply.split(pin), reply).toHaveLength(2)
})
