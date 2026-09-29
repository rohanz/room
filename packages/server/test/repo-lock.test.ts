import { expect, it } from 'vitest'
import { RepoLocks } from '../src/repo-lock.js'

it('serializes one repo while another proceeds, including after a rejection', async () => {
  const locks = new RepoLocks()
  const order: string[] = []
  let release!: () => void
  const held = locks.run('a', async () => { order.push('a1'); await new Promise<void>(r => { release = r }); throw Error('failure') })
  const next = locks.run('a', async () => { order.push('a2') })
  const other = locks.run('b', async () => { order.push('b1') })
  await other
  expect(order).toEqual(['a1', 'b1'])
  release()
  await expect(held).rejects.toThrow('failure')
  await next
  expect(order).toEqual(['a1', 'b1', 'a2'])
})
