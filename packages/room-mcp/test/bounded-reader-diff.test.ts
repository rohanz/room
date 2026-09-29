import { expect, it, vi } from 'vitest'
import { applyPatch } from 'diff'
import { boundedTwoFilesPatch } from '../src/tools/files.js'

const probes = vi.hoisted(() => [] as Array<{ tokens: number; edits: number }>)
vi.mock('diff', async importOriginal => {
  const actual = await importOriginal<typeof import('diff')>()
  return { ...actual, diffLines: (before: string, after: string, options?: { maxEditLength?: number }) => {
    probes.push({ tokens: before.split('\n').length + after.split('\n').length, edits: options?.maxEditLength ?? Infinity })
    return actual.diffLines(before, after, options)
  } }
})

it('produces exact bounded patches for a 60 KB JSON rewrite and unrelated 800-line source', () => {
  const json = (seed: number) => '[' + Array.from({ length: 1_200 }, (_, i) => `{"id":${i},"v":"${seed}-${String(i).padStart(30, 'x')}"}`).join(',') + ']'
  const source = (seed: number) => Array.from({ length: 800 }, (_, i) => `const item${i} = ${seed} * ${i};`).join('\n') + '\n'
  for (const [name, before, after] of [
    ['data.json', json(1), json(2)],
    ['source.ts', source(1), source(2)],
    ['without-newline.ts', source(5).trimEnd(), source(6).trimEnd()],
    ['added.ts', '', source(3)],
    ['deleted.ts', source(4), ''],
  ]) {
    const patch = boundedTwoFilesPatch(name, before, after, 'Ben')
    expect(applyPatch(before, patch), name).toBe(after)
    expect(patch).toContain(`--- a/${name}`)
    expect(patch).toContain(`+++ b/${name}`)
  }
  expect(probes).toHaveLength(5)
  for (const { tokens, edits } of probes) {
    expect(edits).toBeLessThanOrEqual(128)
    expect(tokens * edits).toBeLessThanOrEqual(2_000_000)
  }
})
