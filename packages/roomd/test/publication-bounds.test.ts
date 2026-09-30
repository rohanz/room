import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readDisk } from '../src/disk-scan.js'
import { gitShowManyCapped } from '../src/git.js'
import { plan, policyFromLevel, rulesFromText } from '../src/policy.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-publication-bounds-'))
  roots.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  fs.writeFileSync(path.join(dir, 'x'), 'base')
  git('add', '-A'); git('commit', '-qm', 'base')
  return { dir, git, head: git('rev-parse', 'HEAD') }
}

it('reads at most the cap plus one byte when a file grows after its first stat', async () => {
  const { dir, head } = repo()
  const cap = 64
  fs.writeFileSync(path.join(dir, 'x'), 'small edit')
  const originalOpen = fs.openSync
  const originalRead = fs.readSync
  let opened = false
  let requested = 0
  vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags: number, mode?: fs.Mode) => {
    if (String(p) === path.join(dir, 'x')) {
      opened = true
      fs.writeFileSync(path.join(dir, 'x'), 'z'.repeat(2_000_000))
    }
    return originalOpen(p, flags, mode)
  }) as typeof fs.openSync)
  vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
    requested += length
    return originalRead(fd, buffer, offset, length, position)
  }) as typeof fs.readSync)
  const inputs = { policy: policyFromLevel('full'), rules: rulesFromText('', cap, cap), head }
  const facts = await readDisk(dir, inputs, [], () => true)
  expect(opened).toBe(true)
  expect(requested).toBeLessThanOrEqual(cap + 1)
  expect(facts.find(f => f.path === 'x')?.kind).toBe('error')
})

it('retains at most the publication budget while scanning 512 eligible changed files', async () => {
  const { dir, head } = repo()
  const size = 64 * 1024, budget = 8 * 1024 * 1024
  for (let i = 0; i < 512; i++) fs.writeFileSync(path.join(dir, `changed-${String(i).padStart(3, '0')}.txt`), 'x'.repeat(size))
  const inputs = { policy: policyFromLevel('full'), rules: rulesFromText('', 512 * 1024, budget), head }
  const facts = await readDisk(dir, inputs, [], () => true)
  expect(facts.reduce((total, fact) => total + Buffer.byteLength(fact.text ?? ''), 0)).toBeLessThanOrEqual(budget)
  const desired = plan(inputs, facts, 'aa'.repeat(32))
  expect(desired.textPaths).toHaveLength(128)
  expect(desired.excludedReasons.size).toBe(384)
  expect([...desired.excludedReasons.values()].every(reason => reason === 'budget')).toBe(true)
})

it('checks old blob sizes and reads only blobs within the publication cap', async () => {
  const { dir, git, head } = repo()
  fs.writeFileSync(path.join(dir, 'large'), 'a'.repeat(2_000_000))
  fs.writeFileSync(path.join(dir, 'small'), 'old')
  git('add', '-A'); git('commit', '-qm', 'blobs')
  const base = git('rev-parse', 'HEAD')
  const result = await gitShowManyCapped(dir, base, ['large', 'small', 'missing'], 64)
  expect(result).toEqual(new Map([['large', undefined], ['small', 'old'], ['missing', undefined]]))
  expect(head).not.toBe(base)
})
