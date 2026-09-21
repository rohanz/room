import { expect, it } from 'vitest'
import { testVerdict } from '../src/tools/files.js'

it('retains ANSI-free vitest summaries even before long trailing logs', () => {
  const output = '\u001b[32m Test Files  2 passed (2)\u001b[0m\n Tests  8 passed (8)\n' + 'log\n'.repeat(40)
  expect(testVerdict(output, 0)).toEqual({ passed: true, text: 'Test Files  2 passed (2)\nTests  8 passed (8)\ntests: PASSED (exit 0)' })
})

it('recognises runner failures even when a pipeline masks the exit status', () => {
  const failures = [
    '=== 1 failed, 2 passed in 0.1s ===',
    '=== 2 error in 0.1s ===',
    'Tests  1 failed | 2 passed (3)',
    'FAIL src/example.test.ts',
    'FAIL\texample/pkg',
    'test result: FAILED. 2 passed; 1 failed',
    'FAILED (failures=1)',
  ]
  for (const output of failures) {
    const result = testVerdict(output, 0)
    expect(result.passed, output).toBe(false)
    expect(result.text, output).toContain('tests: FAILED (exit 0)')
  }
  expect(testVerdict('Tests: 3 passed, 3 total', 2)).toEqual({ passed: false, text: 'Tests: 3 passed, 3 total\ntests: FAILED (exit 2)' })
  expect(testVerdict('no recognised summary', 127)).toEqual({ passed: false, text: 'tests: FAILED (exit 127)' })
})

it('does not certify an arbitrary zero-exit command as passing tests', () => {
  expect(testVerdict('no recognised summary', 0)).toEqual({ passed: false, text: 'tests: exit 0 (no test summary recognised)' })
})

it('caps the appended summary and verdict at six lines', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `Tests: ${i} passed`)
  expect(testVerdict(lines.join('\n'), 0).text.split('\n')).toEqual([...lines.slice(-5), 'tests: PASSED (exit 0)'])
})
