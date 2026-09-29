import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { migrateLocalState } from '../src/local-migration.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-local-migration-'))
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

it('copies only non-message hook dedupe, renames legacy files, and is repeatable', () => {
  const legacy = path.join(root, 'git'), session = path.join(root, 'session')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(legacy, 'room-session.json'), JSON.stringify({ session_id: 'host-1' }))
  fs.writeFileSync(path.join(legacy, 'room-hook-seen.json'), JSON.stringify({
    seen: ['owed-id'], shown: { 'owed-id': 'Rohan' }, companyTold: true,
    near: { 'a.py': 'open:near' }, claims: { 'a.py': 'claim-1' },
  }))
  for (const name of ['room-state.json', 'room-write-intents-123.json', 'room-hook-activity.json', 'worker.notice-lock']) {
    fs.writeFileSync(path.join(legacy, name), '{}')
  }
  migrateLocalState(legacy, session, 'host-1')
  const hook = JSON.parse(fs.readFileSync(path.join(session, 'hook.json'), 'utf8'))
  expect(hook).toEqual({ companyTold: true, near: { 'a.py': 'open:near' }, claims: { 'a.py': 'claim-1' } })
  expect(fs.readdirSync(legacy).filter(name => name.endsWith('.migrated'))).toHaveLength(6)
  migrateLocalState(legacy, session, 'host-1')
  expect(JSON.parse(fs.readFileSync(path.join(session, 'hook.json'), 'utf8'))).toEqual(hook)
  expect(fs.readdirSync(session).some(name => name.endsWith('.tmp'))).toBe(false)
})

it('never imports another host session into the bound session', () => {
  const legacy = path.join(root, 'git'), session = path.join(root, 'session')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(legacy, 'room-session.json'), JSON.stringify({ session_id: 'other' }))
  fs.writeFileSync(path.join(legacy, 'room-hook-seen.json'), JSON.stringify({ seen: ['owed-id'], companyTold: true }))
  migrateLocalState(legacy, session, 'host-1')
  expect(fs.existsSync(path.join(legacy, 'room-hook-seen.json'))).toBe(true)
  expect(fs.existsSync(path.join(session, 'hook.json'))).toBe(false)
})

it('keeps worker session evidence until the registry import is complete', () => {
  const legacy = path.join(root, 'git'), session = path.join(root, 'session'), registry = path.join(root, 'registry')
  fs.mkdirSync(legacy, { recursive: true })
  fs.mkdirSync(registry, { recursive: true })
  fs.writeFileSync(path.join(legacy, 'room-session.json'), JSON.stringify({ session_id: 'host-1', worker_id: 'old-worker' }))
  expect(migrateLocalState(legacy, session, 'host-1', registry)).toBe(false)
  expect(fs.existsSync(path.join(legacy, 'room-session.json'))).toBe(true)
  fs.writeFileSync(path.join(registry, 'migration.json'), JSON.stringify({ done: true }))
  expect(migrateLocalState(legacy, session, 'host-1', registry)).toBe(true)
  expect(fs.existsSync(path.join(legacy, 'room-session.json.migrated'))).toBe(true)
})
