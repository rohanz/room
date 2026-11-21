import { base, git, lead, put, setup, worker } from './collect-fixture.js'
import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { prepareWorkerBuildDir } from '../src/worker-build-dir.js'
import { ignoredWorkerArtifacts, prepareWorktree } from '../src/worker-git.js'
import { autoRetire } from '../src/retire.js'

it('never carries build output to another worker', async () => {
  const build = await prepareWorkerBuildDir(worker, 'test')
  fs.writeFileSync(path.join(build, 'baseline.txt'), 'scratch')
  const child = await prepareWorktree(worker, 'child', 'lead+test')
  expect(child.carried?.paths ?? []).not.toContain('.room/scratch/test/baseline.txt')
  expect(fs.existsSync(path.join(child.dir, '.room/scratch/test/baseline.txt'))).toBe(false)
})

it('collects deliverables and removes arbitrary build output without preserving or counting it', async () => {
  const t = setup()
  t.set('test', { ...t.w, exitCode: 0 })
  const build = await prepareWorkerBuildDir(worker, 'test')
  fs.writeFileSync(path.join(build, 'unexpected-source.txt'), 'private baseline')
  fs.writeFileSync(path.join(build, 'large.bin'), Buffer.alloc(6 * 1024 * 1024))
  put(worker, 'file.txt', 'deliverable\n')
  put(worker, 'debug.log', 'existing scratch policy\n')
  expect(await ignoredWorkerArtifacts(t.w as never, lead)).toEqual([])
  const result = await t.call({ tag: 'test' })
  expect(result).toContain('cleaned up test')
  expect(result).not.toContain('unexpected-source')
  expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('deliverable\n')
  expect(fs.readFileSync(path.join(lead, '.room/scratch/test/debug.log'), 'utf8')).toBe('existing scratch policy\n')
  expect(fs.existsSync(path.join(lead, '.room/scratch/test/unexpected-source.txt'))).toBe(false)
  expect(fs.existsSync(build)).toBe(false)
})

it.each(['.room/scratch/test/baseline.txt', '.room/scratch', '.room', '.ROOM/SCRATCH/test/baseline.txt'])('refuses explicit copy of build state through %s', async rel => {
  const t = setup()
  const build = await prepareWorkerBuildDir(worker, 'test')
  fs.writeFileSync(path.join(build, 'baseline.txt'), 'private baseline')
  expect(await t.call({ tag: 'test', mode: 'copy', paths: [rel] })).toContain('never collected')
  expect(fs.existsSync(build)).toBe(true)
  expect(fs.existsSync(path.join(lead, '.room/scratch'))).toBe(false)
})

it('discard excludes forced-added build files from recovery and removes the directory', async () => {
  const t = setup()
  const build = await prepareWorkerBuildDir(worker, 'test')
  fs.writeFileSync(path.join(build, 'baseline.txt'), 'private baseline')
  git(worker, 'add', '-f', '.room/scratch/test/baseline.txt')
  put(worker, 'file.txt', 'recover this\n')
  const result = await t.call({ tag: 'test', discard: true })
  expect(result).toContain('discarded test')
  expect(result).not.toContain('deleted without a copy')
  const ref = result.match(/recovery ref: ([^ ;\n]+)/)![1]
  expect(git(lead, 'show', `${ref}:file.txt`)).toBe('recover this')
  expect(git(lead, 'ls-tree', '-r', '--name-only', ref)).not.toContain('.room')
  expect(fs.existsSync(build)).toBe(false)
})

it('the automatic cleanup sweep removes a collected worktree with only build output', async () => {
  const t = setup()
  t.set('test', { ...t.w, exitCode: 0 })
  const build = await prepareWorkerBuildDir(worker, 'test')
  fs.writeFileSync(path.join(build, 'baseline.txt'), 'private baseline')
  await t.sync()
  git(lead, 'update-ref', 'refs/room/collect-head/test/w_test', base)
  await autoRetire(t.s, { ...t.state.rooms, probe: () => undefined } as never)
  expect(fs.existsSync(build)).toBe(false)
})
