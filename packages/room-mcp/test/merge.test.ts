import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { gitMergeFile } from '../src/merge.js'

let dir: string

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-git-merge-test-')) })
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

async function rawGit(base: string, ours: string, theirs: string): Promise<{ code: number; text: string }> {
  const id = Math.random().toString(36).slice(2)
  const basePath = path.join(dir, `${id}-base`), oursPath = path.join(dir, `${id}-ours`), theirsPath = path.join(dir, `${id}-theirs`)
  fs.writeFileSync(basePath, base); fs.writeFileSync(oursPath, ours); fs.writeFileSync(theirsPath, theirs)
  return new Promise(resolve => {
    execFile('git', ['merge-file', '-p', '--diff3', '-L', 'ours', '-L', 'base', '-L', 'theirs', oursPath, basePath, theirsPath], (error, stdout) => {
      const raw = error && (error as { code?: unknown }).code
      resolve({ code: typeof raw === 'number' ? raw : error ? -1 : 0, text: stdout })
    })
  })
}

describe('gitMergeFile', () => {
  it('reports the adjacent EOF append/edit conflict exactly as git merge-file does', async () => {
    const base = 'def old():\n    return 1\n'
    const ours = 'def old():\n    return 1\n\ndef added():\n    return 2\n'
    const theirs = 'def old():\n    return 10\n'
    const raw = await rawGit(base, ours, theirs)
    const result = await gitMergeFile(base, ours, theirs, { ours: 'ours', base: 'base', theirs: 'theirs' })
    expect(raw.code).toBe(1)
    expect(result.status).toBe('conflict')
    expect(result.conflicts).toHaveLength(raw.code)
    expect(result.text).toBe(raw.text)
    expect(result.conflicts[0]).toMatchObject({ from: 2, a: ['    return 1', '', 'def added():', '    return 2'], o: ['    return 1'], b: ['    return 10'] })
  })

  it('keeps disjoint edits clean with byte-for-byte git merge-file output', async () => {
    const base = 'def first():\n    return 1\n\ndef second():\n    return 2\n'
    const ours = base.replace('return 1', 'return 10')
    const theirs = base.replace('return 2', 'return 20')
    const raw = await rawGit(base, ours, theirs)
    const result = await gitMergeFile(base, ours, theirs, { ours: 'ours', base: 'base', theirs: 'theirs' })
    expect(raw.code).toBe(0)
    expect(result.status).toBe('clean')
    expect(result.conflicts).toEqual([])
    expect(result.text).toBe(raw.text)
    expect(result.text).toContain('return 10')
    expect(result.text).toContain('return 20')
  })
})

describe('new files and merge engine errors', () => {
  const labels = { ours: 'ours', base: 'base', theirs: 'theirs' }
  it('takes additions on either side against an absent base', async () => {
    expect((await gitMergeFile('', '', 'new\n', labels)).text).toBe('new\n')
    expect((await gitMergeFile('', 'new\n', '', labels)).text).toBe('new\n')
    expect((await gitMergeFile('', 'same\n', 'same\n', labels)).status).toBe('clean')
  })
  it('merges differing additions against the empty base', async () => {
    const result = await gitMergeFile('', 'ours\n', 'theirs\n', labels)
    expect(result.status).toBe('conflict')
    expect(result.conflicts[0]).toMatchObject({ a: ['ours'], o: [], b: ['theirs'] })
  })
  it('returns a conflict for binary text rather than a raw git failure', async () => {
    const result = await gitMergeFile('base\0\n', 'ours\0\n', 'theirs\0\n', labels)
    expect(result.status).toBe('conflict')
  })
})

it('recovers from git merge-file exiting 128 without markers', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'room-bad-git-'))
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexit 128\n', { mode: 0o755 })
  vi.stubEnv('PATH', bin)
  try {
    const result = await gitMergeFile('', 'ours\n', 'theirs\n', { ours: 'ours', base: 'base', theirs: 'theirs' })
    expect(result.status).toBe('conflict')
    expect(result.algorithm).toBe('fallback')
    expect(result.fallbackReason).toMatch(/git|exit/i)
    expect(result.conflicts[0]).toMatchObject({ a: ['ours'], b: ['theirs'] })
  } finally { vi.unstubAllEnvs(); fs.rmSync(bin, { recursive: true, force: true }) }
})
