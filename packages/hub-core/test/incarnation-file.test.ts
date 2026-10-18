import { expect, it } from 'vitest'
import { incarnationFile } from '../src/incarnation-file.js'

it('preserves missing, malformed and host-specific null record handling', async () => {
  const missing = incarnationFile('record', { read: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }, write: () => {} })
  await expect(missing.current()).resolves.toBeUndefined()
  for (const contents of ['{', 'null']) {
    const store = incarnationFile('record', { read: () => contents, write: () => {} })
    await expect(store.current()).rejects.toThrow()
  }
  const relay = incarnationFile('record', { read: () => 'null', nullIsMissing: true, write: () => {} })
  await expect(relay.current()).resolves.toBeUndefined()
})

it('awaits durable writes and retains the serialized maximum across advances', async () => {
  let contents = '{"max":4}'
  const store = incarnationFile('record', {
    read: file => { expect(file).toBe('record'); return contents },
    write: async (file, record) => { expect(file).toBe('record'); await Promise.resolve(); contents = JSON.stringify(record) },
  })
  await expect(Promise.all([store.advance(0), store.advance(0)])).resolves.toEqual([5, 6])
  await expect(store.current()).resolves.toBe(6)
})
