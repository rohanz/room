import { expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasCompany } from '../src/company.js'
import { HooksBridge } from '../src/hooks-bridge.js'
import { memorySession } from './fixtures/session.js'

it('counts fresh visible neighbours, never PR mirrors, as company', () => {
  const s = memorySession({ name: 'Me', kind: 'agent' }, '/tmp')
  const now = Date.now()
  for (const [id, name] of [[101, 'Ada'], [102, 'pr#7']] as const) {
    s.room.participants.set(`${name}\0id`, { name, kind: 'agent' })
    s.room.participants.set(`${name}\0holder`, { sessionId: name, machine: 'machine', pid: id, startTime: 'boot:1', executable: 'codex' })
    s.awareness.getStates().set(id, { user: { name, kind: 'agent' }, sessionId: name })
    s.awareness.meta.set(id, { clock: 1, lastUpdated: now })
  }
  expect(hasCompany(s, [], now).others).toEqual(['Ada'])
  s.room.participants.delete('Ada\0id')
  s.room.participants.delete('Ada\0holder')
  expect(hasCompany(s, [], now).others).toEqual([])
  s.awareness.destroy()
  s.room.doc.destroy()
})

it('keeps a mirrored PR scope in hook proximity without treating the PR as company', () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-near-'))
  const s = memorySession({ name: 'Me', kind: 'agent' }, dir)
  s.room.setScope({ by: 'pr#7', byKind: 'agent', area: 'src', summary: 'PR', paths: ['src/api.ts'] })
  const bridge = new HooksBridge(s, {
    forMe: () => false, owedCount: () => 0, fenced: () => true,
    session: () => ({ id: 'test', host: 'codex' }), sessionDir: () => dir,
  })
  bridge.write()
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  expect(state.near).toContainEqual({ by: 'pr#7', path: 'src/api.ts', reason: 'scope' })
  expect(state.company).toBe(false)
  bridge.stop()
  s.awareness.destroy()
  s.room.doc.destroy()
  rmSync(dir, { recursive: true, force: true })
})
