import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PolicyStore } from '../src/policy-store.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function checkout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-ending-scope-'))
  roots.push(dir)
  execFileSync('git', ['init', '-q', dir])
  return dir
}
async function declared(dir: string) {
  return PolicyStore.open({ dir, room: 'local/r/main', participant: 'Rohan', requested: 'declared' })
}
const shared = (path: string) => new Map([[path, { state: 'shared', change: 'M' }]])

it('keeps a departing scope authorized while its watcher edit is pending, then retains the changed path', async () => {
  const store = await declared(checkout())
  await store.declare(['src/a.py'])
  await store.declare([])
  expect(store.policy.ending).toEqual(['src/a.py'])
  expect(store.policy.textPrefixes).toEqual(['src/a.py'])
  await store.settle(store.policy, shared('src/a.py'), [])
  expect(store.policy.ending).toEqual([])
  expect(store.retained).toEqual(['src/a.py'])
  expect(store.policy.textPrefixes).toEqual(['src/a.py'])
})

it('a hot file reverted and edited again remains retained after the unthrottled settling scan', async () => {
  const store = await declared(checkout())
  await store.declare(['src/a.py'])
  await store.declare([])
  await store.settle(store.policy, shared('src/a.py'), [])
  expect(store.retained).toEqual(['src/a.py'])
  await store.settle(store.policy, shared('src/a.py'), [])
  expect(store.retained).toEqual(['src/a.py'])
  await store.settle(store.policy, new Map(), [])
  expect(store.retained).toEqual([])
})

it('a failed settling read leaves the departing prefix authorized', async () => {
  const store = await declared(checkout())
  await store.declare(['src/a.py'])
  await store.declare([])
  await store.settle(store.policy, new Map(), ['src/a.py'])
  expect(store.policy.ending).toEqual(['src/a.py'])
  expect(store.retained).toEqual([])
  await store.settle(store.policy, shared('src/a.py'), [])
  expect(store.retained).toEqual(['src/a.py'])
})

it('retained grants survive restart and clear atomically with an intent level change', async () => {
  const dir = checkout()
  const first = await declared(dir)
  await first.declare(['src/a.py'])
  await first.declare([])
  await first.settle(first.policy, shared('src/a.py'), [])
  const next = await declared(dir)
  expect(next.retained).toEqual(['src/a.py'])
  await next.setRequested('intent')
  const reopened = await declared(dir)
  expect(reopened.requested).toBe('intent')
  expect(reopened.retained).toEqual([])
})
