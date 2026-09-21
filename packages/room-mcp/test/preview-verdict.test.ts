import { expect, it } from 'vitest'
import { testVerdict } from '../src/tools/files.js'

it('retains ANSI-free vitest summaries even before long trailing logs', () => {
  const output = '\u001b[32m Test Files  2 passed (2)\u001b[0m\n Tests  8 passed (8)\n' + 'log\n'.repeat(40)
  expect(testVerdict(output, 0)).toBe('Test Files  2 passed (2)\nTests  8 passed (8)\ntests: PASSED (exit 0)')
})

it('recognises pytest and jest summaries and uses the exit code for failure', () => {
  expect(testVerdict('=== test session starts ===\n=== 1 failed, 2 passed in 0.1s ===', 1))
    .toBe('=== 1 failed, 2 passed in 0.1s ===\ntests: FAILED (exit 1)')
  expect(testVerdict('Tests: 3 passed, 3 total', 2)).toBe('Tests: 3 passed, 3 total\ntests: FAILED (exit 2)')
  expect(testVerdict('no recognised summary', 127)).toBe('tests: FAILED (exit 127)')
})

it('caps the appended summary and verdict at six lines', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `Tests: ${i} passed`)
  expect(testVerdict(lines.join('\n'), 0).split('\n')).toEqual([...lines.slice(-5), 'tests: PASSED (exit 0)'])
})
