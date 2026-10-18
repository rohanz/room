import { cases, gitOracle, names, sharedFixture } from './combined-kept-preview-fixture.js'
import { describe, expect, it } from 'vitest'

describe('round-2 permutations', () => {
  const get = sharedFixture(false)
  it.each(cases)('attempt3 kept round-2 preview from $caller with $people preserves all changes', async ({ caller, people }) => {
    const { t, before } = await get()
    const result = await t.preview(caller, people)
    expect(result.complete, result.out.join('\n')).toBe(true)
    expect(result.conflictingPaths.size, result.out.join('\n')).toBe(0)
    expect(result.merged).toEqual(t.expected)
    expect(t.snapshot()).toEqual(before)
  })
})

describe('genuine conflict callers', () => {
  const get = sharedFixture(true)
  it.each(names)('attempt3 genuine lead/worker edit conflict stays visible from %s', async caller => {
    const { t, before } = await get()
    const result = await t.preview(caller, names.filter(name => name !== caller))
    expect(result.conflictingPaths.has('src/api.ts'), result.out.join('\n')).toBe(true)
    expect(t.snapshot()).toEqual(before)
  })
})

describe('disjoint and revert permutations', () => {
  const get = sharedFixture({ shared: 'disjoint' })
  it.each(cases)('same-file disjoint kept hunks and deliberate revert from $caller with $people', async ({ caller, people }) => {
    const { t, before } = await get()
    const result = await t.preview(caller, people)
    expect(result.complete, result.out.join('\n')).toBe(true)
    expect(result.conflictingPaths.size, result.out.join('\n')).toBe(0)
    expect(result.merged).toEqual(t.expected)
    expect(t.snapshot()).toEqual(before)
  })
})

describe('lead revision callers', () => {
  const get = sharedFixture({ shared: 'disjoint', leadEdit: 'revision' })
  it.each(names)('keeps a committed lead revision while the worker edits elsewhere from %s', async caller => {
    const { t, before } = await get()
    const result = await t.preview(caller, names.filter(name => name !== caller))
    expect(result.complete, result.out.join('\n')).toBe(true)
    expect(result.conflictingPaths.size, result.out.join('\n')).toBe(0)
    expect(result.merged).toEqual(t.expected)
    expect(t.snapshot()).toEqual(before)
  })
})

describe('lead removal callers', () => {
  const get = sharedFixture({ shared: 'disjoint', leadEdit: 'removal' })
  it.each(names)('keeps a committed lead removal when every worker left that content alone from %s', async caller => {
    const { t, before } = await get()
    const result = await t.preview(caller, names.filter(name => name !== caller))
    expect(result.complete, result.out.join('\n')).toBe(true)
    expect(result.conflictingPaths.size, result.out.join('\n')).toBe(0)
    expect(result.merged).toEqual(t.expected)
    expect(t.snapshot()).toEqual(before)
  })
})

describe('delivered conflict callers', () => {
  const get = sharedFixture({ shared: 'disjoint', leadEdit: 'conflict' })
  it.each(names)('keeps a genuine conflict on different delivered same-file versions from %s', async caller => {
    const { t, before } = await get()
    const result = await t.preview(caller, names.filter(name => name !== caller))
    expect(result.conflictingPaths.has('shared.txt'), result.out.join('\n')).toBe(true)
    expect(t.snapshot()).toEqual(before)
  })
})

describe('worker deletion callers', () => {
  const get = sharedFixture({ removeTest: true })
  it.each(names)('applies a worker deletion of a previously delivered new test exactly once from %s', async caller => {
    const { t, before } = await get()
    const result = await t.preview(caller, names.filter(name => name !== caller).reverse())
    expect(result.complete, result.out.join('\n')).toBe(true)
    expect(result.conflictingPaths.size, result.out.join('\n')).toBe(0)
    expect(result.merged).toEqual(t.expected)
    expect(t.snapshot()).toEqual(before)
  })
})

describe('multiple keep callers', () => {
  const get = sharedFixture({ keeps: 2 })
  it.each(names)('uses the newest own snapshot after multiple keep rounds from %s', async caller => {
    const { t, before } = await get()
    const result = await t.preview(caller, names.filter(name => name !== caller).reverse())
    expect(result.complete, result.out.join('\n')).toBe(true)
    expect(result.conflictingPaths.size, result.out.join('\n')).toBe(0)
    expect(result.merged).toEqual(t.expected)
    expect(t.snapshot()).toEqual(before)
  })
})

describe('repeated-line permutations', () => {
  const get = sharedFixture({ shared: 'repeated' }, gitOracle)
  it.each(cases)('repeated-line Git alignment uses collection policy from $caller with $people', async ({ caller, people }) => {
    const { t, before } = await get()
    const result = await t.preview(caller, people)
    // Git's alignment is deterministic under the existing collection key. This
    // deliberately does not assert commutativity or preservation of semantic intent.
    expect(result.complete, result.out.join('\n')).toBe(true)
    expect(result.conflictingPaths.size, result.out.join('\n')).toBe(0)
    expect(result.merged).toEqual(t.expected)
    expect(t.snapshot()).toEqual(before)
  })
})
