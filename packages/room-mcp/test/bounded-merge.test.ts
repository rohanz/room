import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const mergeCalls = vi.hoisted(() => ({ work: [] as number[] }))
vi.mock('node-diff3', async importOriginal => {
  const actual = await importOriginal<typeof import('node-diff3')>()
  return { ...actual, diff3Merge: (...args: Parameters<typeof actual.diff3Merge>) => {
    const [a, o, b] = args
    const work = (a.length + b.length) * o.length
    mergeCalls.work.push(work)
    if (work > 2_000_000) throw new Error('unbounded diff3 call')
    return actual.diff3Merge(...args)
  } }
})

import { gitMergeFile } from '../src/merge.js'
import { classifyThreeWay } from '../../web/src/merged.js'

afterEach(() => { vi.unstubAllEnvs(); mergeCalls.work.length = 0 })

it('keeps exact alternatives without invoking diff3 on repeated-line small edits in MCP fallback', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'room-bounded-merge-'))
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexit 128\n', { mode: 0o755 })
  vi.stubEnv('PATH', bin)
  try {
    const base = 'same\n'.repeat(4000), ours = base + 'a\n', theirs = 'b\n' + base
    const result = await gitMergeFile(base, ours, theirs, { ours: 'ours', base: 'base', theirs: 'theirs' })
    expect(result.algorithm).toBe('fallback')
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]).toMatchObject({ a: ours.split('\n'), o: base.split('\n'), b: theirs.split('\n') })
    expect(mergeCalls.work.every(work => work <= 2_000_000)).toBe(true)
  } finally { fs.rmSync(bin, { recursive: true, force: true }) }
})

it('keeps both exact alternatives without invoking diff3 on repeated-line small edits in web', () => {
  const base = 'same\n'.repeat(4000), a = base + 'a\n', b = 'b\n' + base
  const out = classifyThreeWay(base, a, b)
  expect(out.filter(line => line.conflict && line.side === 'a').map(line => line.text)).toEqual(a.trimEnd().split('\n'))
  expect(out.filter(line => line.conflict && line.side === 'b').map(line => line.text)).toEqual(b.trimEnd().split('\n'))
  expect(mergeCalls.work.every(work => work <= 2_000_000)).toBe(true)
})

it('returns exact MCP alternatives for 50,000 repetitive lines under the publication cap', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'room-bounded-merge-'))
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexit 128\n', { mode: 0o755 })
  vi.stubEnv('PATH', bin)
  try {
    const base = 'x\n'.repeat(50_000), ours = base + 'a\n', theirs = 'b\n' + base
    const result = await gitMergeFile(base, ours, theirs, { ours: 'ours', base: 'base', theirs: 'theirs' })
    expect(result.algorithm).toBe('fallback')
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].a.join('\n')).toBe(ours)
    expect(result.conflicts[0].o.join('\n')).toBe(base)
    expect(result.conflicts[0].b.join('\n')).toBe(theirs)
    expect(result.text).toContain('<<<<<<< ours\n')
    expect(result.text).toContain('||||||| base\n')
    expect(result.text).toContain('=======\n')
  } finally { fs.rmSync(bin, { recursive: true, force: true }) }
})

it('returns both web alternatives for 150,000 repetitive lines under the publication cap', () => {
  const base = 'x\n'.repeat(150_000), a = base + 'a\n', b = 'b\n' + base
  const out = classifyThreeWay(base, a, b)
  expect(out.filter(line => line.conflict && line.side === 'a').map(line => line.text).join('\n') + '\n').toBe(a)
  expect(out.filter(line => line.conflict && line.side === 'b').map(line => line.text).join('\n') + '\n').toBe(b)
})
