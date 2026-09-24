import { expect, it, vi } from 'vitest'
import { observeCallback } from '../src/index.js'

it('reports synchronous and asynchronous daemon observer failures', async () => {
  const report = vi.fn()
  observeCallback(() => { throw new Error('sync') }, report)
  observeCallback(() => Promise.reject(new Error('async')), report)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(report.mock.calls.map(([error]) => error.message)).toEqual(['sync', 'async'])
})
