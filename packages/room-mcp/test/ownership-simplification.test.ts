import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import * as baseline from '@room/roomd/baseline'
import { createTools, realRepo, scratchRepos, setupLead } from './workers-fixture.js'
import { fixtureProbe } from './fixtures/process-liveness.js'
import type { Session } from '../src/session.js'
import { mutateWorkerFixture } from './fixtures/worker-record.js'
import { prepareWorkerLinks, prepareWorktree } from '../src/worker-git.js'
import { preserveWorkerBranch, writeWorkerRef } from '../src/worker-refs.js'
import { closeRegistryForDir, registryForDir } from '../src/worker-registry.js'
import { retainedWorkerLines } from '../src/worker-retained.js'

function inputs(repo: string) {
  fs.mkdirSync(path.join(repo, 'inputs'))
  for (const name of ['one', 'two']) fs.writeFileSync(path.join(repo, 'inputs', name), name)
}

it('retains partial input links, reports them and rethrows the original failure', async () => {
  const { repo } = realRepo(), prepared = await prepareWorktree(repo, 'links', 'lead', { carry: false })
  inputs(repo)
  const first = path.join(fs.realpathSync(prepared.dir), 'inputs/one'), failure = new Error('second input failed'), link = fs.symlinkSync
  const spy = vi.spyOn(fs, 'symlinkSync').mockImplementation((...args: Parameters<typeof fs.symlinkSync>) => {
    if (String(args[1]).endsWith(path.join('inputs', 'two'))) throw failure
    return link(...args)
  })
  try {
    let thrown: unknown
    try { prepareWorkerLinks(repo, prepared.dir, ['inputs/one', 'inputs/two']) } catch (error) { thrown = error }
    expect(thrown).toBe(failure)
    expect(fs.lstatSync(first).isSymbolicLink()).toBe(true)
    expect(retainedWorkerLines(path.join(repo, '.git')).join('\n')).toContain(first)
    spy.mockRestore()
    fs.unlinkSync(first) // The fixture's user explicitly removes partial output before retrying.
    expect(prepareWorkerLinks(repo, prepared.dir, ['inputs/one', 'inputs/two'])).toEqual(['inputs/one', 'inputs/two'])
    expect(retainedWorkerLines(path.join(repo, '.git'))).toEqual([])
  } finally { spy.mockRestore() }
})

it.each(['owned', 'supplied'] as const)('a second input failure never unlinks leaves in a %s checkout', async kind => {
  const { repo, head, git } = realRepo(), t = setupLead(repo, head)
  inputs(repo)
  const dir = kind === 'owned' ? path.join(repo, '.room/workers/links') : fs.mkdtempSync(path.join(os.tmpdir(), 'room-input-supplied-'))
  if (kind === 'supplied') { scratchRepos.push(dir); git('worktree', 'add', '-q', '--detach', dir, head) }
  const first = path.join(kind === 'owned' ? path.join(fs.realpathSync(repo), '.room/workers/links') : fs.realpathSync(dir), 'inputs/one')
  let session: Session | null = t.session
  const launch = vi.fn(() => { throw new Error('input failure must prevent launch') })
  const tools = createTools({ getSession: () => session, setSession: next => { session = next }, cwd: repo, probe: fixtureProbe, spawner: launch })
  const link = fs.symlinkSync
  const spy = vi.spyOn(fs, 'symlinkSync').mockImplementation((...args: Parameters<typeof fs.symlinkSync>) => {
    if (String(args[1]).endsWith(path.join('inputs', 'two'))) throw new Error('second input failed')
    return link(...args)
  })
  const unlink = vi.spyOn(fs, 'unlinkSync')
  try {
    const reply = await tools.call('room_spawn', { tag: 'links', task: 'x', carry: false, link: ['inputs/one', 'inputs/two'], ...(kind === 'supplied' ? { dir, allowOutside: true } : {}) })
    expect(reply).toContain('could not link inputs: second input failed')
    expect(launch).not.toHaveBeenCalled()
    expect(unlink.mock.calls.some(([file]) => String(file) === first)).toBe(false)
    if (kind === 'owned') {
      expect(fs.existsSync(dir)).toBe(false)
      expect(git('branch', '--list', 'room/links')).toBe('')
    } else {
      expect(fs.lstatSync(first).isSymbolicLink()).toBe(true)
      expect(reply).toContain(first)
      expect(await tools.call('room_state')).toContain(first)
      expect(await tools.call('room_state', { check: true })).toContain(first)
    }
  } finally { spy.mockRestore(); unlink.mockRestore() }
})

it('stores recovery creation time in its tag, keeping only ordinary ref-write receipts', () => {
  const { repo, git, head } = realRepo(), common = path.join(repo, '.git'), worker = { id: 'w_pin', tag: 'pin', branch: 'main' }
  writeWorkerRef(common, 'refs/room/carry/pin', head, worker.id)
  const receipt = preserveWorkerBranch(common, worker)
  expect(git('rev-parse', `${receipt.recoveryRef!}^{commit}`)).toBe(head)
  const refs = fs.readdirSync(path.join(common, 'room/registry/ref-writes')).map(name => JSON.parse(fs.readFileSync(path.join(common, 'room/registry/ref-writes', name), 'utf8')).ref)
  expect(refs).toEqual(['refs/room/carry/pin'])
  expect(git('cat-file', '-t', receipt.recoveryRef!)).toBe('tag')
  expect(git('cat-file', '-p', receipt.recoveryRef!)).toMatch(/tagger Room <room@localhost> \d+ \+0000\n\nRoom recovery pin/)

})

it('names the recovery pin when its write fails before Git supplies a diagnostic', () => {
  const { repo, head } = realRepo(), common = path.join(repo, '.git'), run = baseline.boundedGitSync
  vi.spyOn(baseline, 'boundedGitSync').mockImplementation((...args) => {
    if (args[1].includes('update-ref')) throw new Error('injected write failure')
    return run(...args)
  })
  const receipt = preserveWorkerBranch(common, { id: 'w_pin', tag: 'pin', branch: 'main' })
  expect(receipt.reason).toContain('injected write failure')
  expect(retainedWorkerLines(common).join('\n')).toContain(`refs/room/recovery/pin/${head}`)
})

it.each(['branch', 'untracked'])('loads old preparation JSON with unread fields and step %s', async step => {
  const { repo, head } = realRepo(), t = setupLead(repo, head), registry = await registryForDir(repo)
  expect(await t.leadTools.call('room_spawn', { tag: 'old-fields', task: 'x', carry: false })).toContain('spawned old-fields')
  const record = (await registry.reserved('old-fields'))!
  const legacy = { step, worktreeExisted: false, untrackedTree: head }
  await mutateWorkerFixture(registry, record.id, old => ({ ...old, seq: old.seq + 1, prep: { ...old.prep, ...JSON.parse(JSON.stringify(legacy)) } }))
  await closeRegistryForDir(repo)
  const reopened = await registryForDir(repo)
  expect((await reopened.read(record.id))?.prep).toMatchObject(legacy)
  expect((await reopened.read(record.id))?.prep.witness).toEqual(record.prep.witness)
})
