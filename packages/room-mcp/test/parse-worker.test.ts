import { expect, it } from 'vitest'
import { ParseWorker } from '../src/parse/client.js'

it('loads grammars in its own thread and deduplicates equal versions', async () => {
  const worker = new ParseWorker()
  try {
    const text = 'pub fn sample(x: usize) -> usize { x }'
    const parsed = await worker.parse('sample.rs', [text, text, undefined])
    expect(parsed[0]?.defs).toMatchObject([{ name: 'sample', signature: 'pub fn sample(x: usize) -> usize' }])
    expect(parsed[1]).toEqual(parsed[0])
    expect(parsed[2]).toBeUndefined()
    const [python] = await worker.parse('sample.py', ['def sample(x):\n    return x\n'])
    expect(python?.defs[0]?.name).toBe('sample')
  } finally { worker.stop() }
})

it('rejects pending and subsequent requests on stop', async () => {
  const worker = new ParseWorker()
  const pending = worker.parse('sample.rs', ['pub fn sample() {}'])
  worker.stop()
  await expect(pending).rejects.toThrow('parser worker is closed')
  await expect(worker.parse('sample.rs', [''])).rejects.toThrow('parser worker is closed')
})
