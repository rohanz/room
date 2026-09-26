import { expect, it } from 'vitest'
import { eligibility, type EligibilityFacts } from '../src/publisher.js'

const eligible: EligibilityFacts = {
  ignored: false, safe: true, level: 'full', inScope: false, retained: false,
  withinSize: true, withinBudget: true,
}

it.each([
  ['eligible full path', {}, { share: true }],
  ['ignored path', { ignored: true }, { share: false, reason: 'ignore' }],
  ['unsafe path', { safe: false }, { share: false, reason: 'unsafe' }],
  ['intent level', { level: 'intent' }, { share: false, reason: 'level' }],
  ['declared out of scope', { level: 'declared' }, { share: false, reason: 'scope' }],
  ['declared in scope', { level: 'declared', inScope: true }, { share: true }],
  ['retained declared path', { level: 'declared', retained: true }, { share: true }],
  ['over size cap', { withinSize: false }, { share: false, reason: 'size' }],
  ['over total budget', { withinBudget: false }, { share: false, reason: 'budget' }],
] as const)('%s', (_name, overrides, result) => {
  expect(eligibility('src/a.py', { ...eligible, ...overrides })).toEqual(result)
})
