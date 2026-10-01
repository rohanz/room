import fs from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { setGitObserver } from '@room/roomd/git'
import { handlers as fileHandlers } from '../src/tools/files.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { editLine, juceRepo, juceSession, put, type JuceRepo } from './fixtures/juce-repo.js'

vi.mock('../src/tools/claims.js', () => ({ releaseClaimsOnDone: vi.fn() }))
const repos: JuceRepo[] = []
afterEach(async () => {
  setGitObserver(undefined)
  vi.restoreAllMocks()
  for (const repo of repos.splice(0)) { await closeRegistryForDir(repo.lead); fs.rmSync(repo.root, { recursive: true, force: true }) }
})

/** One preview of the same handful of edits over a JUCE-shaped clone; counts Git processes and file opens. */
async function preview(shape: { ignored: number; untracked: number }, args: Record<string, unknown> = {}) {
  const repo = await juceRepo({ tracked: 40, built: 50, ...shape })
  repos.push(repo)
  const { lead, workers: [w1, w2] } = repo
  editLine(lead, 'Source/part0/Unit0.cpp', 2, '// lead edit')
  editLine(w1.dir, 'Source/part0/Unit0.cpp', 60, '// w1 edit')
  editLine(w1.dir, 'Source/part1/Unit20.cpp', 2, '// w1 edit')
  put(w1.dir, 'Source/New1.cpp', 'new\n')
  editLine(w2.dir, 'Source/part1/Unit21.cpp', 2, '// w2 edit')
  if (shape.untracked) editLine(w2.dir, 'JuceLibraryCode/gen0/BinaryData0.cpp', 1, '// w2 edits a carried file')
  const { state } = await juceSession(repo)
  let gitCalls = 0
  setGitObserver(() => { gitCalls++ })
  const opens = vi.spyOn(fs.promises, 'open')
  const result = await fileHandlers(state).room_preview_merge({ people: ['lead+w1', 'lead+w2'], ...args })
  const counts = { gitCalls, opens: opens.mock.calls.length }
  setGitObserver(undefined)
  opens.mockRestore()
  return { result, ...counts }
}

it('spawns the same number of Git processes and opens the same files however large the ignored tree is', async () => {
  const small = await preview({ ignored: 100, untracked: 0 })
  const large = await preview({ ignored: 2000, untracked: 0 })
  expect(large.result).toContain('both changed, merge cleanly: Source/part0/Unit0.cpp')
  expect(large.gitCalls).toBe(small.gitCalls)
  expect(large.opens).toBe(small.opens)
}, 120_000)

it('does not read or spawn Git per carried untracked file a worker left as spawn carried it', async () => {
  const few = await preview({ ignored: 100, untracked: 10 })
  const many = await preview({ ignored: 100, untracked: 120 })
  for (const { result } of [few, many]) {
    expect(result).toContain('JuceLibraryCode/gen0/BinaryData0.cpp (lead+w2 only)')
    expect(result).toContain('both changed, merge cleanly: Source/part0/Unit0.cpp')
    expect(result).toContain('no conflicts')
  }
  // Same edits: the carried files nobody changed cost nothing per file.
  expect(many.gitCalls).toBe(few.gitCalls)
  expect(many.opens).toBe(few.opens)
  expect(many.result).not.toMatch(/BinaryData(1|5|100)\.cpp/)
}, 300_000)

it('keeps per-file work bounded when the combined tree is built for a test run', async () => {
  const few = await preview({ ignored: 100, untracked: 10 }, { run: 'true' })
  const many = await preview({ ignored: 100, untracked: 120 }, { run: 'true' })
  for (const { result } of [few, many]) expect(result).toContain('tests: exit 0')
  // A test run materializes every lead file, but a carried file a worker left alone needs no Git read of its base.
  expect(many.gitCalls).toBe(few.gitCalls)
}, 300_000)
