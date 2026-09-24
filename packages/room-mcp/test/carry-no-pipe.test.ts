import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A synchronous child process fed multi-megabyte stdin can leave git waiting for EOF forever
// (Node 22 on macOS, reproduced 2026-09-24: 1 call in ~150); nothing on the carry path may do that.
const calls: { args: string[]; input: boolean }[] = []
vi.mock('node:child_process', async original => {
  const real = await original<typeof import('node:child_process')>()
  return {
    ...real,
    execFileSync: (file: string, args: readonly string[] = [], options?: { input?: unknown }) => {
      if (file === 'git') calls.push({ args: [...args], input: options?.input !== undefined })
      return real.execFileSync(file, args as string[], options as never)
    },
  }
})

const { execFileSync } = await import('node:child_process')
const { prepareWorktree } = await import('../src/workers.js')
const { carriedContentHash } = await import('@room/roomd/baseline')

const repos: string[] = []
afterEach(() => { for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true }); calls.length = 0 })
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'room-nopipe-')); repos.push(dir)
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 't'); git('config', 'user.email', 't@t')
  writeFileSync(join(dir, 'big.txt'), 'x\n'.repeat(10)); git('add', '.'); git('commit', '-qm', 'base')
  return dir
}

describe('carry never pipes file-sized input into a synchronous git call', () => {
  it('carries a large untracked file and large tracked changes without stdin input', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'untracked.bin'), Buffer.alloc(4 * 1024 * 1024, 3))
    writeFileSync(join(dir, 'big.txt'), 'y\n'.repeat(2 * 1024 * 1024))
    const prepared = await prepareWorktree(dir, 'nopipe')
    expect(prepared.carriedUntracked?.map(c => c.path)).toContain('untracked.bin')
    expect(calls.filter(c => c.input).map(c => c.args.slice(0, 4).join(' '))).toEqual([])
  })

  it('hashes a regular file by path and a symlink by its target text, as git does', () => {
    const dir = repo()
    writeFileSync(join(dir, 'data.bin'), Buffer.alloc(3 * 1024 * 1024, 9))
    symlinkSync('data.bin', join(dir, 'link'))
    const expectedFile = execFileSync('git', ['hash-object', '--', 'data.bin'], { cwd: dir, encoding: 'utf8' }).trim()
    const expectedLink = execFileSync('git', ['hash-object', '--stdin'], { cwd: dir, input: 'data.bin', encoding: 'utf8' }).trim()
    calls.length = 0
    expect(carriedContentHash(dir, 'data.bin')).toBe(expectedFile)
    expect(carriedContentHash(dir, 'link')).toBe(expectedLink)
    expect(calls.find(c => c.args.includes('--path=data.bin'))?.input).toBe(false)
  })
})
