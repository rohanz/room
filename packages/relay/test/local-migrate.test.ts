import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { RoomDoc } from '@room/shared'
import { catchUpLocal, forgetLegacyLocal } from '../src/local-migrate.js'
import { loadMemory, memoryFile } from '../src/memory.js'
import { owed } from '@room/shared'
import { probeProcess } from '../src/process.js'

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

it('does not re-deliver receipted addressed questions, including after restart', () => {
  const room = 'local/shop', oldName = `${room}/main`
  fs.mkdirSync(path.join(common, 'room-local'), { recursive: true })
  const source = new RoomDoc(new Y.Doc())
  source.bus.push([{ id: 'seen-q', type: 'question', from: 'ada', fromKind: 'agent', to: 'ben', text: 'already seen?', at: 1, priority: 'notify' }])
  source.seen('ben').set('seen-q', 123)
  fs.writeFileSync(path.join(common, 'room-local', `${encodeURIComponent(oldName)}.ydoc`), Y.encodeStateAsUpdate(source.doc))
  const target = new RoomDoc(new Y.Doc())
  catchUpLocal(common, room, target.doc)
  expect(target.mail.has('seen-q')).toBe(false)
  expect(target.bus.toArray().some(m => m.id === 'seen-q')).toBe(false)
  const reloaded = new RoomDoc(loadMemory(common, room))
  expect(owed(reloaded, 'ben').some(m => m.id === 'seen-q')).toBe(false)
})

it('does not re-deliver a receipted question to an ambiguous migrated recipient', () => {
  const room = 'local/shop', dir = path.join(common, 'room-local')
  fs.mkdirSync(dir, { recursive: true })
  for (const branch of ['main', 'feature']) {
    const source = new RoomDoc(new Y.Doc())
    source.setScope({ by: 'ben', byKind: 'agent', area: branch, summary: branch, paths: [`${branch}.py`] })
    if (branch === 'main') {
      source.bus.push([{ id: 'seen-q', type: 'question', from: 'ada', fromKind: 'agent', to: 'ben', text: 'seen', at: 1, priority: 'notify' }])
      source.seen('ben').set('seen-q', 123)
    }
    fs.writeFileSync(path.join(dir, `${encodeURIComponent(`${room}/${branch}`)}.ydoc`), Y.encodeStateAsUpdate(source.doc))
  }
  const target = new RoomDoc(new Y.Doc())
  catchUpLocal(common, room, target.doc)
  expect(target.mail.has('seen-q')).toBe(false)
  expect(target.bus.toArray().some(m => m.id === 'seen-q')).toBe(false)
  expect([...target.doc.getMap<{ placeholder: string }>('unresolved').values()].map(e => e.placeholder)).toHaveLength(2)
  expect(new RoomDoc(loadMemory(common, room)).mail.has('seen-q')).toBe(false)
})

it('saves imported state before advancing the ledger on a failed save retry', () => {
  const room = 'local/shop', oldName = `${room}/main`
  fs.mkdirSync(path.join(common, 'room-local'), { recursive: true })
  const source = new RoomDoc(new Y.Doc())
  source.mail.set('retry-q', { id: 'retry-q', type: 'question', from: 'ada', fromKind: 'agent', to: 'ben', text: 'retry?', at: 1, priority: 'notify' })
  fs.writeFileSync(path.join(common, 'room-local', `${encodeURIComponent(oldName)}.ydoc`), Y.encodeStateAsUpdate(source.doc))
  const target = new RoomDoc(new Y.Doc()), file = memoryFile(common, room)
  fs.mkdirSync(file, { recursive: true })
  expect(() => catchUpLocal(common, room, target.doc, () => {})).toThrow('could not save')
  expect(fs.existsSync(path.join(common, 'room', 'relay', 'migrated.json'))).toBe(false)
  fs.rmSync(file, { recursive: true })
  catchUpLocal(common, room, target.doc)
  expect(new RoomDoc(loadMemory(common, room)).mail.has('retry-q')).toBe(true)
  expect(JSON.parse(fs.readFileSync(path.join(common, 'room', 'relay', 'migrated.json'), 'utf8')).messages).toContain('retry-q')
})

it('replays safely if ledger rename fails after the snapshot is durable', () => {
  const room = 'local/shop', dir = path.join(common, 'room-local')
  fs.mkdirSync(dir, { recursive: true })
  const source = new RoomDoc(new Y.Doc())
  source.mail.set('q-ledger', { id: 'q-ledger', type: 'question', from: 'ada', fromKind: 'agent', to: 'ben', text: 'ledger?', at: 1, priority: 'notify' })
  fs.writeFileSync(path.join(dir, `${encodeURIComponent(`${room}/main`)}.ydoc`), Y.encodeStateAsUpdate(source.doc))
  const ledger = path.join(common, 'room', 'relay', 'migrated.json')
  fs.mkdirSync(ledger, { recursive: true })
  const target = new RoomDoc(new Y.Doc())
  expect(() => catchUpLocal(common, room, target.doc)).toThrow()
  expect(new RoomDoc(loadMemory(common, room)).mail.has('q-ledger')).toBe(true)
  fs.rmSync(ledger, { recursive: true })
  catchUpLocal(common, room, target.doc)
  expect(JSON.parse(fs.readFileSync(ledger, 'utf8')).messages).toContain('q-ledger')
  expect(new RoomDoc(loadMemory(common, room)).mail.has('q-ledger')).toBe(true)
})

it('moves earlier unique facts to unresolved when a later branch makes the name ambiguous', () => {
  const room = 'local/shop', dir = path.join(common, 'room-local')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(common, 'room-local.json'), JSON.stringify({ pid: process.pid }))
  const put = (branch: string, id: string) => {
    const source = new RoomDoc(new Y.Doc())
    source.claims.set(id, { id, by: 'ben', byKind: 'agent', path: `${branch}.py`, from: 1, to: 1, intent: 'edit', at: 1 })
    source.setScope({ by: 'ben', byKind: 'agent', area: branch, summary: branch, paths: [`${branch}.py`] })
    source.mail.set(`q-${id}`, { id: `q-${id}`, type: 'question', from: 'ben', fromKind: 'agent', to: 'cy', text: id, at: 1, priority: 'notify' })
    fs.writeFileSync(path.join(dir, `${encodeURIComponent(`${room}/${branch}`)}.ydoc`), Y.encodeStateAsUpdate(source.doc))
  }
  put('main', 'c1')
  const target = new RoomDoc(new Y.Doc())
  catchUpLocal(common, room, target.doc)
  expect(target.claims.get('c1')?.by).toBe('ben')
  put('feature', 'c2')
  catchUpLocal(common, room, target.doc)
  expect(target.claims.has('c1')).toBe(false)
  expect(target.scopes.has('ben')).toBe(false)
  const unresolved = target.doc.getMap<{ claims: { id: string }[]; scope?: unknown }>('unresolved')
  expect(unresolved.get(`${room}/main\0ben`)?.claims.map(c => c.id)).toEqual(['c1'])
  expect(unresolved.get(`${room}/main\0ben`)?.scope).toBeDefined()
  expect(target.mail.get('q-c1')?.from).toMatch(/^\?[a-f0-9]{16}$/)
  expect(new RoomDoc(loadMemory(common, room)).claims.has('c1')).toBe(false)
})

it('freezes completed legacy imports and treats a reused pid as gone', () => {
  const room = 'local/shop', oldName = `${room}/main`, file = path.join(common, 'room-local', `${encodeURIComponent(oldName)}.ydoc`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const source = new RoomDoc(new Y.Doc())
  source.bus.push([{ id: 'first', type: 'note', from: 'ada', fromKind: 'agent', text: 'first', at: 1, priority: 'fyi' }])
  fs.writeFileSync(file, Y.encodeStateAsUpdate(source.doc))
  fs.writeFileSync(path.join(common, 'room-local.json'), JSON.stringify({ pid: process.pid, startTime: 'reused-pid', executable: 'node' }))
  const target = new RoomDoc(new Y.Doc())
  expect(catchUpLocal(common, room, target.doc, () => {}, () => ({ startTime: 'actual', executable: 'node' }))).toBe(false)
  expect(target.bus.toArray().map(m => m.id)).toEqual(['first'])
  source.bus.push([{ id: 'late', type: 'note', from: 'ada', fromKind: 'agent', text: 'late', at: 2, priority: 'fyi' }])
  fs.writeFileSync(file, Y.encodeStateAsUpdate(source.doc))
  expect(catchUpLocal(common, room, target.doc)).toBe(false)
  expect(target.bus.toArray().map(m => m.id)).toEqual(['first'])
  expect(probeProcess(process.pid)?.startTime).not.toBe('reused-pid')
})
