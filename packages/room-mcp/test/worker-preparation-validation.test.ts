import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import * as gitCalls from '@room/roomd/git'
import * as workerRefs from '../src/worker-refs.js'
import { prepareWorktree } from '../src/worker-git.js'
import { realRepo } from './workers-fixture.js'

it.each(['', ' \n', 'not-an-oid'])('rejects invalid HEAD output %j before creating or attaching a worker root', async output => {
  const { repo } = realRepo(), run = gitCalls.git
  const spy = vi.spyOn(gitCalls, 'git').mockImplementation((dir, args, timeout) => {
    if (args[0] === 'rev-parse' && args.some(arg => arg === 'HEAD' || arg === 'HEAD^{commit}')) return Promise.resolve(output)
    return run(dir, args, timeout)
  })
  await expect(prepareWorktree(repo, 'bad-head')).rejects.toThrow(/HEAD.*invalid commit OID/)
  expect(spy.mock.calls.some(([, args]) => args.includes('worktree') && args.includes('add'))).toBe(false)
  expect(fs.existsSync(path.join(repo, '.room/workers/bad-head'))).toBe(false)
})

it('rejects a real non-commit HEAD before creating a worker root', async () => {
  const { repo, git } = realRepo(), blob = git('hash-object', '-w', 'modified.txt')
  fs.writeFileSync(path.join(repo, '.git/HEAD'), blob + '\n')
  await expect(prepareWorktree(repo, 'blob-head')).rejects.toThrow(/HEAD.*commit/)
  expect(fs.existsSync(path.join(repo, '.room/workers/blob-head'))).toBe(false)
})

it.each(['empty', 'blob'] as const)('reports an invalid %s carry commit at its read boundary', async kind => {
  const { repo, git } = realRepo(), run = gitCalls.git
  fs.writeFileSync(path.join(repo, 'modified.txt'), 'carried change\n')
  const output = kind === 'empty' ? '' : git('hash-object', '-w', 'modified.txt')
  vi.spyOn(gitCalls, 'git').mockImplementation((dir, args, timeout) => args.includes('commit-tree')
    ? Promise.resolve(output) : run(dir, args, timeout))
  const writes = vi.spyOn(workerRefs, 'writeWorkerRef')
  const result = await prepareWorktree(repo, 'bad-carry')
  expect(result.carryFailed).toBe(true)
  expect(result.carryError).toMatch(/carry commit.*(invalid commit OID|not a commit)/)
  expect(writes.mock.calls.some(([, ref, oid]) => ref.startsWith('refs/heads/') && oid === output)).toBe(false)
})
