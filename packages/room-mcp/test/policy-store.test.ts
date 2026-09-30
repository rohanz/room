import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PolicyStore, sharingFile } from '../src/policy-store.js'
import { writeChoice } from '../src/choice.js'

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

it('migrates a matching legacy sharing level and retained grant into a durable clone-wide floor', async () => {
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
  expect(JSON.parse(fs.readFileSync(choice, 'utf8')).share).toBe('declared')
  expect(JSON.parse(fs.readFileSync(path.join(dir, '.git', 'room', 'sharing', 'legacy-baseline.json'), 'utf8')).level).toBe('declared')
})

it('carries restricted legacy fields through destination rewrites until the new policy is durable', async () => {
  const dir = checkout(), choice = path.join(dir, '.git', 'room-choice.json')
  fs.writeFileSync(choice, JSON.stringify({ where: 'local', at: 1, share: 'intent', warned: ['old'] }))
  await writeChoice(dir, 'ws://team')
  expect(JSON.parse(fs.readFileSync(choice, 'utf8'))).toMatchObject({ share: 'intent', warned: ['old'] })
  const store = await PolicyStore.open({ dir, room: 'repo', participant: 'alice', requested: 'full' })
  expect(store.requested).toBe('intent')
  expect(JSON.parse(fs.readFileSync(choice, 'utf8')).share).toBe('intent')
  expect((await PolicyStore.open({ dir, room: 'repo', participant: 'ben', requested: 'full' })).requested).toBe('intent')
})

it('keeps the safer baseline if an older client later rewrites its clone choice', async () => {
  const dir = checkout(), choice = path.join(dir, '.git', 'room-choice.json')
  fs.writeFileSync(choice, JSON.stringify({ where: 'team', share: 'intent' }))
  expect((await PolicyStore.open({ dir, room: 'repo', participant: 'alice' })).requested).toBe('intent')
  fs.writeFileSync(choice, JSON.stringify({ where: 'team', share: 'full' }))
  expect((await PolicyStore.open({ dir, room: 'repo', participant: 'ben' })).requested).toBe('intent')
  const explicit = await PolicyStore.open({ dir, room: 'repo', participant: 'alice' })
  await explicit.setRequested('full')
  expect((await PolicyStore.open({ dir, room: 'repo', participant: 'alice' })).requested).toBe('full')
  expect((await PolicyStore.open({ dir, room: 'repo', participant: 'later-worker' })).requested).toBe('intent')
})

it.each([['ambiguous', '{broken'], ['unknown level', JSON.stringify({ where: 'local', share: 'private' })]])('fails closed for %s legacy choice', async (_case, contents) => {
  const dir = checkout()
  fs.writeFileSync(path.join(dir, '.git', 'room-choice.json'), contents)
  const store = await PolicyStore.open({ dir, room: 'repo', participant: 'alice', requested: 'full' })
  expect(store.requested).toBe('intent')
})
