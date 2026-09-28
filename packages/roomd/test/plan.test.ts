import { expect, it } from 'vitest'
import { plan, policyFromLevel, type DiskFact, type PublicationInputs } from '../src/policy.js'

const policy = policyFromLevel('declared', ['src/'])
const inputs: PublicationInputs = { policy, rules: { roomIgnore: { patterns: 0, ignores: () => false }, sizeCap: 100, budget: 4, id: 'one' }, head: 'base' }
const changed: DiskFact = { path: 'src/x', kind: 'file', hash: 'new', baseHash: 'old', size: 4, text: '1234' }

it.each([
  ['authorized text', inputs, changed, { change: 'M', state: 'shared', hash: 'new', size: 4, baseHash: 'old' }],
  ['out of area', inputs, { ...changed, path: 'private/x', size: 5, text: '12345' }, { change: 'M', state: 'held', held: 'scope' }],
  ['deleted out of area', inputs, { path: 'private/y', kind: 'absent', baseHash: 'old' }, { change: 'D', state: 'shared' }],
  ['binary', inputs, { ...changed, text: undefined, binary: true }, { change: 'M', state: 'held', held: 'binary', hash: 'new' }],
  ['intent', { ...inputs, policy: policyFromLevel('intent') }, changed, undefined],
  ['non publisher', { ...inputs, policy: { ...policy, publisher: false } }, changed, undefined],
] as const)('%s', (_name, input, fact, entry) => {
  const desired = plan(input as PublicationInputs, [fact as DiskFact], 'salt')
  expect(desired.entries.get(fact.path)).toMatchObject(entry ?? {})
  if (!entry) expect(desired.entries.size).toBe(0)
  if (entry && !('hash' in entry)) expect(desired.entries.get(fact.path)).not.toHaveProperty('hash')
})

it('excludes changed paths before a deletion can disclose its name and orders budget after scope', () => {
  const desired = plan(inputs, [changed, { ...changed, path: 'private/z', size: 5, text: '12345' }, { path: 'secret', kind: 'absent', baseHash: 'old', excluded: true }], 'salt')
  expect(desired.entries.get('private/z')).toMatchObject({ held: 'scope' })
  expect(desired.entries.has('secret')).toBe(false)
  expect(desired.excluded).toHaveLength(1)
})
