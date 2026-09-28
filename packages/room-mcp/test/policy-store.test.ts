import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PolicyStore, sharingFile } from '../src/policy-store.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function checkout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-policy-'))
  roots.push(dir)
  execFileSync('git', ['init', '-q', dir])
  return dir
}

it('keeps two participants in one common dir isolated and persists level with grant atomically', async () => {
  const dir = checkout()
  const alice = await PolicyStore.open({ dir, room: 'local/r/main', participant: 'alice', requested: 'declared' })
  const ben = await PolicyStore.open({ dir, room: 'local/r/main', participant: 'ben', requested: 'full' })
  await alice.declare(['src/'])
  await alice.declare([])
  expect(alice.policy.textPrefixes).toEqual(['src/'])
  expect(ben.policy.level).toBe('full')
  await alice.setRequested('intent')
  expect(JSON.parse(fs.readFileSync(await sharingFile(dir, 'local/r/main', 'alice'), 'utf8'))).toMatchObject({ requested: 'intent', declared: { active: [], ending: [], retained: [] } })
  expect(JSON.parse(fs.readFileSync(await sharingFile(dir, 'local/r/main', 'ben'), 'utf8')).requested).toBe('full')
})

it('retains a changed path when a scope ends during an edit, then drops it after equality', async () => {
  const dir = checkout()
  const store = await PolicyStore.open({ dir, room: 'local/r/main', participant: 'alice', requested: 'declared' })
  await store.declare(['src/'])
  const before = store.policy
  await store.declare([])
  expect(store.policy).not.toBe(before)
  expect(store.policy.ending).toEqual(['src/'])
  await store.settle(store.policy, new Map([['src/x', { change: 'M', state: 'shared' }]]), [])
  expect(store.policy.ending).toEqual([])
  expect(store.policy.textPrefixes).toEqual(['src/x'])
  await store.settle(store.policy, new Map(), [])
  expect(store.policy.textPrefixes).toEqual([])
})

it('keeps an ending prefix after an unsettled scan', async () => {
  const dir = checkout()
  const store = await PolicyStore.open({ dir, room: 'local/r/main', participant: 'alice', requested: 'declared' })
  await store.declare(['src/'])
  await store.declare([])
  await store.settle(store.policy, new Map(), ['src/x'])
  expect(store.policy.ending).toEqual(['src/'])
})

it('keeps a stored requested level on a default reopen and accepts an explicit override', async () => {
  const dir = checkout()
  const first = await PolicyStore.open({ dir, room: 'local/r/main', participant: 'alice', requested: 'full' })
  await first.setRequested('intent')
  const defaultJoin = await PolicyStore.open({ dir, room: 'local/r/main', participant: 'alice', requested: 'full' })
  expect(defaultJoin.requested).toBe('intent')
  await defaultJoin.setRequested('full')
  const explicitJoin = await PolicyStore.open({ dir, room: 'local/r/main', participant: 'alice', requested: 'intent' })
  expect(explicitJoin.requested).toBe('full')
})

it('migrates a matching legacy sharing level and retained grant, then removes the old fields', async () => {
  const dir = checkout()
  const choice = path.join(dir, '.git', 'room-choice.json')
  const oldGrant = path.join(dir, '.git', 'room-retained-declared.json')
  fs.writeFileSync(choice, JSON.stringify({ where: 'team', at: 1, share: 'declared', warnedLevels: { [`${fs.realpathSync(dir)}#ws://team`]: 'declared' } }))
  fs.writeFileSync(oldGrant, JSON.stringify({ room: 'repo/main', participant: 'alice', server: 'ws://team', paths: ['src/kept.py'] }))
  const store = await PolicyStore.open({ dir, room: 'repo/main', participant: 'alice', server: 'ws://team' })
  expect(store.requested).toBe('declared')
  expect(store.retained).toEqual(['src/kept.py'])
  expect(store.disclosed).toEqual({ level: 'declared', version: 1 })
  expect(fs.existsSync(oldGrant)).toBe(false)
  expect(JSON.parse(fs.readFileSync(choice, 'utf8'))).toEqual({ where: 'team', at: 1 })
})
