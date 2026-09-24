import { expect, it, vi } from 'vitest'
import { observeTakeover } from '../src/index.js'

it('reports a rejected relay takeover without an unhandled rejection', async () => {
  const report = vi.fn()
  await expect(observeTakeover(() => Promise.reject(new Error('discovery file unwritable')), report)).resolves.toBeUndefined()
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'discovery file unwritable' }))
})
