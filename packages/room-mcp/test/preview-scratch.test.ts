import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handlers as collectHandlers } from '../src/tools/collect.js'
import { isScratchName, scratchCollectNote } from '../src/tools/combined-tree.js'
import { saveWorkerScratch } from '../src/worker-git.js'
import { handlers as fileHandlers } from '../src/tools/files.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { editLine, juceRepo, juceSession, put, type JuceRepo } from './fixtures/juce-repo.js'

vi.mock('../src/tools/claims.js', () => ({ releaseClaimsOnDone: vi.fn() }))
const repos: JuceRepo[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const repo of repos.splice(0)) { await closeRegistryForDir(repo.lead); fs.rmSync(repo.root, { recursive: true, force: true }) }
})
const small = async (options: Parameters<typeof juceRepo>[0] = {}) => {
  const repo = await juceRepo({ tracked: 4, ignored: 0, built: 0, ...options })
  repos.push(repo)
  return repo
}
const BOTH_LOGS = 'worker scratch, not previewed (untracked logs or temp files, never committed): build_before.log (lead+w1 and lead+w2 each wrote one); collect does not bring it in'

it('reports two workers\' untracked build logs on one low-key line, not as a code conflict', async () => {
  const repo = await small()
  const [w1, w2] = repo.workers
  put(w1.dir, 'build_before.log', 'w1 configure output\n')
  put(w2.dir, 'build_before.log', 'w2 configure output\n')
  editLine(w1.dir, 'Source/part0/Unit0.cpp', 2, '// w1 edit')
  const { state } = await juceSession(repo)
  const result = await fileHandlers(state).room_preview_merge({ people: ['lead+w1', 'lead+w2'], run: 'test ! -e build_before.log' })
  expect(result).not.toContain('CONFLICTS')
  expect(result).not.toContain('build_before.log (lead+w1 only)')
  expect(result).toContain(BOTH_LOGS)
  expect(result).toContain('Source/part0/Unit0.cpp (lead+w1 only)')
  expect(result).toContain('tests: exit 0')
})

it('names a single worker\'s scratch and keeps it out of the combined tree', async () => {
  const repo = await small()
  put(repo.workers[0].dir, 'cmake-build/notes.tmp', 'scratch\n')
  put(repo.workers[0].dir, 'Source/New.cpp', 'new\n')
  const { state } = await juceSession(repo)
  const result = await fileHandlers(state).room_preview_merge({ people: ['lead+w1', 'lead+w2'] })
  expect(result).toContain('worker scratch, not previewed (untracked logs or temp files, never committed): cmake-build/notes.tmp (lead+w1); collect does not bring it in')
  expect(result).toContain('Source/New.cpp (lead+w1 only)')
  expect(result).toMatch(/final combined tree: 1 path\(s\) applied/)
})

it('still reports a tracked log both workers changed as a conflict', async () => {
  const repo = await small({ committed: { 'build_before.log': 'committed\n' } })
  const [w1, w2] = repo.workers
  put(w1.dir, 'build_before.log', 'w1\n')
  put(w2.dir, 'build_before.log', 'w2\n')
  const { state } = await juceSession(repo)
  const result = await fileHandlers(state).room_preview_merge({ people: ['lead+w1', 'lead+w2'] })
  expect(result).toContain('CONFLICTS:\nbuild_before.log\n  around line 1: conflict between lead+w1 and lead+w2')
  expect(result).not.toContain('worker scratch')
})

it('still reports a carried log both workers changed as a conflict', async () => {
  const repo = await small({ leadFiles: { 'build_before.log': 'lead\n' } })
  const [w1, w2] = repo.workers
  put(w1.dir, 'build_before.log', 'w1\n')
  put(w2.dir, 'build_before.log', 'w2\n')
  const { state } = await juceSession(repo)
  const result = await fileHandlers(state).room_preview_merge({ people: ['lead+w1', 'lead+w2'] })
  expect(result).toContain('CONFLICTS:\nbuild_before.log')
  expect(result).not.toContain('worker scratch')
})

it('words two different new files at one path as new files, not a line conflict', async () => {
  const repo = await small()
  const [w1, w2] = repo.workers
  put(w1.dir, 'Source/Helper.cpp', 'int helper() { return 1; }\n')
  put(w2.dir, 'Source/Helper.cpp', 'int helper() { return 2; }\n')
  const { state, session } = await juceSession(repo)
  const result = await fileHandlers(state).room_preview_merge({ people: ['lead+w1', 'lead+w2'] })
  expect(result).toContain('CONFLICTS:\nSource/Helper.cpp: lead+w1 and lead+w2 each created this new file (not in the base) with different contents — needs a human or a rewrite')
  expect(result).not.toContain('around line')
  expect(result).toContain('excludes 1 unresolved conflict(s)')
  expect(session.lastPreview?.clean).toBe(false)
})

it('collects both workers past their scratch logs and saves each copy under .room/scratch', async () => {
  const repo = await small()
  const [w1, w2] = repo.workers
  put(w1.dir, 'build_before.log', 'w1 configure output\n')
  put(w2.dir, 'build_before.log', 'w2 configure output\n')
  put(w1.dir, 'Source/New1.cpp', 'one\n')
  put(w2.dir, 'Source/New2.cpp', 'two\n')
  const { state } = await juceSession(repo)
  const result = await collectHandlers(state).room_collect({})
  expect(result).not.toContain('Nothing written')
  expect(result).toContain('not collected: worker scratch (untracked logs or temp files, never committed): build_before.log (w1, w2); saved under .room/scratch/w1/ and .room/scratch/w2/')
  expect(fs.readFileSync(path.join(repo.lead, '.room/scratch/w1/build_before.log'), 'utf8')).toBe('w1 configure output\n')
  expect(fs.readFileSync(path.join(repo.lead, '.room/scratch/w2/build_before.log'), 'utf8')).toBe('w2 configure output\n')
  expect(fs.readFileSync(path.join(repo.lead, 'Source/New1.cpp'), 'utf8')).toBe('one\n')
  expect(fs.readFileSync(path.join(repo.lead, 'Source/New2.cpp'), 'utf8')).toBe('two\n')
  expect(fs.existsSync(path.join(repo.lead, 'build_before.log'))).toBe(false)
}, 60_000)

describe('saveWorkerScratch', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
  const roots = () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-scratch-')))
    dirs.push(root)
    const lead = path.join(root, 'lead'), worker = path.join(root, 'worker')
    fs.mkdirSync(lead); fs.mkdirSync(worker)
    return { root, lead, worker }
  }

  it('replaces a tag\'s folder on a re-collect and names files it did not save', () => {
    const { root, lead, worker } = roots()
    put(lead, '.room/scratch/w1/old.log', 'stale\n')
    put(worker, 'build.log', 'fresh\n')
    fs.writeFileSync(path.join(worker, 'huge.log'), Buffer.alloc(5 * 1024 * 1024 + 1))
    fs.writeFileSync(path.join(root, 'secret'), 'outside\n')
    fs.symlinkSync(path.join(root, 'secret'), path.join(worker, 'linked.log'))
    const outcome = saveWorkerScratch(lead, [{ tag: 'w1', root: worker, paths: ['build.log', 'huge.log', 'linked.log'] }])
    expect(outcome.saved.get('w1')).toEqual(['build.log'])
    expect(outcome.skipped).toEqual([{ tag: 'w1', path: 'huge.log', reason: 'over 5 MB' }, { tag: 'w1', path: 'linked.log', reason: 'link' }])
    expect(fs.readFileSync(path.join(lead, '.room/scratch/w1/build.log'), 'utf8')).toBe('fresh\n')
    expect(fs.existsSync(path.join(lead, '.room/scratch/w1/old.log'))).toBe(false)
    expect(fs.existsSync(path.join(lead, '.room/scratch/w1/linked.log'))).toBe(false)
    expect(scratchCollectNote(new Map([['lead+w1', new Set(['build.log', 'huge.log', 'linked.log'])]]), () => 'w1', outcome))
      .toBe('not collected: worker scratch (untracked logs or temp files, never committed): build.log (w1), huge.log (w1), linked.log (w1); saved under .room/scratch/w1/; NOT saved (lost when the worktree is removed; copy with mode=copy first): huge.log (w1: over 5 MB), linked.log (w1: link)')
  })

  it('refuses to write through a linked .room or .room/scratch', () => {
    for (const linked of ['.room', '.room/scratch']) {
      const { root, lead, worker } = roots()
      const elsewhere = path.join(root, 'elsewhere')
      fs.mkdirSync(elsewhere)
      if (linked === '.room/scratch') fs.mkdirSync(path.join(lead, '.room'))
      fs.symlinkSync(elsewhere, path.join(lead, linked))
      put(worker, 'build.log', 'log\n')
      const outcome = saveWorkerScratch(lead, [{ tag: 'w1', root: worker, paths: ['build.log'] }])
      expect(outcome.saved.size).toBe(0)
      expect(outcome.skipped).toEqual([{ tag: 'w1', path: 'build.log', reason: '.room or .room/scratch is not a plain folder' }])
      expect(fs.readdirSync(elsewhere)).toEqual([])
    }
  })
})

it('treats logs and temp, swap and OS files as scratch names, and data files and build folders as real output', () => {
  for (const p of ['build_before.log', 'logs/CMake.LOG', 'notes.tmp', '.main.cpp.swp', 'Source/main.cpp~', '.DS_Store', '.tmp-123', '.#lock']) expect(isScratchName(p), p).toBe(true)
  for (const p of ['fixture.bin', 'data.sqlite', 'dist/app.js', 'vendor/lib.cpp', 'build/out.o', 'logs/readme.md', 'catalog.cpp']) expect(isScratchName(p), p).toBe(false)
})
