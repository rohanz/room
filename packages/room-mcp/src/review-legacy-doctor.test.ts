import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('does not promise the doctor leftover listing after removing that diagnostic', () => {
  const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
  expect(readme).not.toContain('to list leftover filenames')
})
