import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { RoomDoc } from '@room/shared'
import { catchUpLocal, forgetLegacyLocal } from '../src/local-migrate.js'
import { loadMemory, memoryFile } from '../src/memory.js'

let common: string
beforeEach(() => { common = fs.mkdtempSync(path.join(os.tmpdir(), 'room-migrate-')) })
afterEach(() => { fs.rmSync(common, { recursive: true, force: true }) })

it('catches up a running old relay by ID without resurrecting a released claim', () => {
  const room = 'local/shop', oldName = `${room}/main`
  const oldFile = path.join(common, 'room-local', `${encodeURIComponent(oldName)}.ydoc`)
  fs.mkdirSync(path.dirname(oldFile), { recursive: true })
  fs.writeFileSync(path.join(common, 'room-local.json'), JSON.stringify({ pid: process.pid }))
  const old = new RoomDoc(new Y.Doc())
  old.bus.push([{ id: 'm1', type: 'note', from: 'ada', fromKind: 'agent', text: 'first', at: 1, priority: 'fyi' }])
  old.claims.set('c1', { id: 'c1', by: 'ada', byKind: 'agent', path: 'app.py', from: 1, to: 1, intent: 'fix', at: 1 })
  fs.writeFileSync(oldFile, Y.encodeStateAsUpdate(old.doc))
  const target = new RoomDoc(new Y.Doc())
  expect(catchUpLocal(common, room, target.doc)).toBe(true)
  expect(target.bus.toArray().map(m => m.id)).toEqual(['m1'])
  expect(target.claims.has('c1')).toBe(true)
  expect(fs.existsSync(memoryFile(common, room))).toBe(true)
  expect(new RoomDoc(loadMemory(common, room)).claims.has('c1')).toBe(true)
  target.claims.delete('c1')
  old.bus.push([{ id: 'm2', type: 'note', from: 'ada', fromKind: 'agent', text: 'later', at: 2, priority: 'fyi' }])
  fs.writeFileSync(oldFile, Y.encodeStateAsUpdate(old.doc))
  expect(catchUpLocal(common, room, target.doc)).toBe(true)
  expect(target.bus.toArray().map(m => m.id)).toEqual(['m1', 'm2'])
  expect(target.claims.has('c1')).toBe(false)
  fs.writeFileSync(path.join(common, 'room-local.json'), JSON.stringify({ pid: 999999 }))
  expect(catchUpLocal(common, room, target.doc)).toBe(false)
  expect(target.metaMap.get('localMigrating')).toBe(0)
  forgetLegacyLocal(common, room)
  expect(fs.existsSync(oldFile)).toBe(false)
  expect(fs.existsSync(path.join(common, 'room', 'relay', 'migrated.json'))).toBe(false)
})

it('keeps names from two legacy branches separate until their owners claim them', () => {
  const room = 'local/shop'
  fs.mkdirSync(path.join(common, 'room-local'), { recursive: true })
  for (const [branch, claimId] of [['main', 'c1'], ['feature', 'c2']] as const) {
    const source = new RoomDoc(new Y.Doc())
    source.claims.set(claimId, { id: claimId, by: 'ben', byKind: 'agent', path: `${branch}.py`, from: 1, to: 1, intent: 'edit', at: 1 })
    source.setScope({ by: 'ben', byKind: 'agent', area: branch, summary: branch, paths: [`${branch}.py`] })
    if (branch === 'main') source.mail.set('q1', { id: 'q1', type: 'question', from: 'ben', fromKind: 'agent', to: 'cy', text: 'help?', at: 1, priority: 'notify' })
    fs.writeFileSync(path.join(common, 'room-local', `${encodeURIComponent(`${room}/${branch}`)}.ydoc`), Y.encodeStateAsUpdate(source.doc))
  }
  const target = new RoomDoc(new Y.Doc())
  catchUpLocal(common, room, target.doc)
  expect(target.claims.size).toBe(0)
  const unresolved = target.doc.getMap<{ placeholder: string; claims: { id: string }[] }>('unresolved')
  expect(unresolved.size).toBe(2)
  expect(new RoomDoc(loadMemory(common, room)).doc.getMap('unresolved').size).toBe(2)
  expect([...unresolved.values()].flatMap(value => value.claims.map(claim => claim.id)).sort()).toEqual(['c1', 'c2'])
  expect(target.mail.get('q1')?.from).toMatch(/^\?[a-f0-9]{16}$/)
  expect(target.mail.get('q1')?.to).toBe('cy')
  catchUpLocal(common, room, target.doc)
  expect(unresolved.size).toBe(2)
})
