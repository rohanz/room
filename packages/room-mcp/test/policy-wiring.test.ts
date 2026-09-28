import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd, type Roomd } from '@room/roomd'
import { PolicyStore } from '../src/policy-store.js'
import { applySessionPolicy } from '../src/session.js'
import { testPolicyStore } from './policy-fixture.js'

const roots: string[] = []
const daemons: Roomd[] = []
afterEach(async () => { for (const d of daemons.splice(0)) await d.stop(); for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }) })
function checkout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-policy-wiring-'))
  roots.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'src', 'x'), 'base')
  git('add', '-A'); git('commit', '-qm', 'base')
  return dir
}
function provider(doc: Y.Doc): WebsocketProvider {
  let state: unknown = null
  return { synced: true, awareness: { getLocalState: () => state, setLocalState: (s: unknown) => { state = s }, getStates: () => new Map([[doc.clientID, state]]) }, on() {}, off() {}, destroy() {} } as unknown as WebsocketProvider
}

it('settles a departed prefix through the session onChange callback', async () => {
  const dir = checkout()
  let daemon: Roomd | undefined
  const store = await PolicyStore.open({ dir, room: 'local/r/main', participant: 'Ben', requested: 'declared', onChange: policy => { if (daemon) applySessionPolicy(daemon, policy) } })
  daemon = await startRoomd({ dir, room: 'ws://memory/local/r/main', localKey: 'test', name: 'Ben', sessionId: 's1', policy: store.policy,
    onFullScan: (policy, entries, unsettled) => store.settle(policy, entries, unsettled).then(() => {}),
    providerFactory: (_s, _n, doc) => provider(doc), basePollMs: 0, trackedRefreshMs: 60000, log: () => {} })
  daemons.push(daemon)
  await store.declare(['src/'])
  fs.writeFileSync(path.join(dir, 'src', 'x'), 'changed')
  await store.declare([])
  await (daemon as any).publisher.reconcile('all')
  expect(store.policy.ending).toEqual([])
  expect(store.retained).toEqual(['src/x'])
})

it('keeps active scope grants across level changes and same-level requests', async () => {
  const dir = checkout()
  const store = await PolicyStore.open({ dir, room: 'local/r/main', participant: 'Ben', requested: 'declared' })
  await store.declare(['src/'])
  await store.setRequested('full')
  await store.setRequested('full')
  await store.setRequested('declared')
  expect(store.policy.textPrefixes).toEqual(['src/'])
  const before = store.policy
  await store.setRequested('declared')
  expect(store.policy).toBe(before)
  const fake = testPolicyStore('declared')
  await fake.declare(['src/'])
  await fake.setRequested('full')
  await fake.setRequested('declared')
  expect(fake.policy.textPrefixes).toEqual(['src/'])
})

it('retains unresolved files after a failed settling scan', async () => {
  const store = await PolicyStore.open({ dir: checkout(), room: 'local/r/main', participant: 'Ben', requested: 'declared' })
  await store.declare(['src/']); await store.declare([])
  await store.settle(store.policy, new Map([['src/x', { state: 'shared', change: 'M' }]]), [])
  await store.settle(store.policy, new Map(), ['src/x'])
  expect(store.retained).toEqual(['src/x'])
})
