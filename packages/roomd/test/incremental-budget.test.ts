import { expect, it } from 'vitest'
import { plan, policyFromLevel, type DiskFact, type PublicationInputs } from '../src/policy.js'

const inputs: PublicationInputs = {
  head: 'synthetic', policy: policyFromLevel('full'),
  rules: { roomIgnore: { patterns: 0, ignores: () => false }, sizeCap: 100, budget: 6, id: 'synthetic' },
}
const changed = (path: string, baseSize: number): DiskFact => ({ path, kind: 'file', hash: 'new', baseHash: 'old', size: 2, text: 'é', baseSize })

it('admits the exact independent base byte limit and excludes a whole path one byte above', () => {
  const exact = plan(inputs, [changed('b.js', 3), changed('a.js', 3)], 'a'.repeat(64))
  expect([...exact.entries.keys()]).toEqual(['a.js', 'b.js'])
  expect(exact.excludedReasons.size).toBe(0)
  const above = plan(inputs, [changed('b.js', 4), changed('a.js', 3)], 'a'.repeat(64))
  expect([...above.entries.keys()]).toEqual(['a.js'])
  expect(above.excludedReasons.get('b.js')).toBe('budget')
})

it('charges deletions to base bytes while scope-held paths consume neither text budget', () => {
  const declared = { ...inputs, policy: policyFromLevel('declared', ['src/']) }
  const facts: DiskFact[] = [changed('private/a.js', 100), {path:'src/a.js',kind:'absent',baseHash:'old',baseSize:6}, changed('src/b.js',1)]
  const result = plan(declared, facts, 'b'.repeat(64))
  expect(result.entries.get('private/a.js')).toMatchObject({state:'held',held:'scope'})
  expect(result.entries.get('src/a.js')).toMatchObject({change:'D',state:'shared'})
  expect(result.excludedReasons.get('src/b.js')).toBe('budget')
})

it('does not charge an unchanged path or binary-held text against admitted base texts', () => {
  const result = plan(inputs, [{...changed('a.js',100),hash:'old'}, {...changed('b.js',100),binary:true}, changed('c.js',6)], 'c'.repeat(64))
  expect(result.entries.has('a.js')).toBe(false)
  expect(result.entries.get('b.js')).toMatchObject({state:'held',held:'binary'})
  expect(result.entries.get('c.js')).toMatchObject({state:'shared'})
  expect(result.excludedReasons.size).toBe(0)
})
