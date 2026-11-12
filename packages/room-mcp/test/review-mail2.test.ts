import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { RoomDoc, admit, deliveryIndex, retireRecipient, trim, type Msg, type RetiredWorker } from '@room/shared'
import { FileWorkerStore } from '../src/worker-file-store.js'
import { memorySession } from './fixtures/session.js'
import { createTools } from '../src/tools.js'
import { closeRegistryForDir } from '../src/worker-registry.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-mail2-')); roots.push(dir); return dir }
const message = (id: string, to = 'lead+w'): Msg => ({ id, type: 'question', from: 'lead', fromKind: 'agent', to, text: 'Please answer', at: Date.now(), priority: 'notify' })
const archive: RetiredWorker & { id: string } = { id: 'w_old', name: 'lead+w', tag: 'w', lead: 'lead', host: 'codex', task: '', summary: '', files: [], fileCount: 0, startedAt: 1, finishedAt: 2, retiredAt: 3, outcome: 'clean' }

it.each([true, false])('does not end fresh mail for an ordinary session reusing a retired worker name (holder: %s)', async holder => {
  const common = temp(), room = new RoomDoc()
  fs.mkdirSync(path.join(common, 'room', 'registry'), { recursive: true })
  const store = await FileWorkerStore.openReader(common)
  try {
    room.doc.getArray('retiredWorkers').push([archive])
    if (holder) room.participants.set('lead+w\0holder', { sessionId: 'ordinary', epoch: 2, pid: process.pid, startTime: '', executable: '', at: Date.now() })
    room.participants.set('lead+w\0id', { name: 'lead+w', kind: 'agent', owner: 'lead' })
    room.bus.push([message('fresh')])
    expect(room.workerOwnsName('w_old', 'lead+w')).toBe(false)
    await store.retireWorkerMail(room, 'lead', 'local/test')
    expect(deliveryIndex(room).pending.has('fresh')).toBe(true)
    expect(room.outcomes.has('fresh')).toBe(false)
    room.retireWorker(archive.id, archive, () => {})
    expect(deliveryIndex(room).pending.has('fresh')).toBe(true)
    expect(room.outcomes.has('fresh')).toBe(false)
    const index = deliveryIndex(room), totals = { bytes: index.owedBytes, recipients: structuredClone(index.recipients), pending: [...index.pending] }
    index.rebuild()
    expect({ bytes: index.owedBytes, recipients: index.recipients, pending: [...index.pending] }).toEqual(totals)
  } finally { store.close(); room.doc.destroy() }
})

it('room_wait reports retirement after the unanswered question leaves the bus', async () => {
  const dir = temp(), s = memorySession({ name: 'lead', kind: 'agent' }, dir)
  execFileSync('git', ['init', '-q', dir])
  const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir })
  try {
    const q = message('question')
    s.room.doc.getArray('retiredWorkers').push([archive])
    s.room.mail.set('control', message('control'))
    // The first tool reply can include the clone's one-time sharing notice before the status line.
    const control = (await tools.call('room_wait', { questionId: 'control', timeoutMs: 10 })).split('\n').at(-1)!
    expect(control).toContain('will not answer')
    s.room.mail.set(q.id, q)
    retireRecipient(s.room, q.to!, Date.now())
    expect(s.room.message(q.id)).toBeUndefined()
    expect(s.room.outcomes.get(q.id)?.outcome).toBe('recipient-retired')
    const result = await tools.call('room_wait', { questionId: q.id, timeoutMs: 10 })
    // With the body gone Room cannot tell an unanswered question from one whose answer was trimmed.
    expect(result).toBe(control.replace(" and will not answer;", "; no answer to this question is retained;"))
  } finally { await tools.shutdown(); await closeRegistryForDir(dir); s.awareness.destroy(); s.room.doc.destroy() }
})

it.runIf(process.env.REVIEW_MAIL2_SAVED === '1')('measures copied real saved room and registry without running cleanup against original paths', async () => {
  const source = process.env.REVIEW_MAIL2_SOURCE ?? '/Users/rohan/Documents/progwork/aitinkerhackathon/.git/room'
  const common = temp()
  fs.mkdirSync(path.join(common, 'room'), { recursive: true })
  fs.copyFileSync(path.join(source, 'relay', 'local%2Faitinkerhackathon.ydoc'), path.join(common, 'saved.ydoc'))
  execFileSync('cp', ['-R', path.join(source, 'registry'), path.join(common, 'room', 'registry')])
  const room = new RoomDoc(), store = await FileWorkerStore.openReader(common)
  try {
    Y.applyUpdate(room.doc, fs.readFileSync(path.join(common, 'saved.ydoc')))
    const records = fs.readdirSync(path.join(store.root, 'workers')).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(store.root, 'workers', f), 'utf8')))
    const retired = room.retiredWorkers().filter(r => r.lead === 'rohanz')
    const names = new Set(retired.map(r => r.name))
    const evidence = new Set(records.filter(r => names.has(r.name)).map(r => r.name))
    const index = deliveryIndex(room), before = index.owedBytes
    const owedRetired = [...index.recipients.keys()].filter(name => names.has(name))
    const owedRetiredWithDisk = owedRetired.filter(name => evidence.has(name))
    let messagePassMs = 0
    const retireMail = room.retireWorkerMail.bind(room)
    room.retireWorkerMail = (...args) => {
      const start = performance.now()
      try { return retireMail(...args) } finally { messagePassMs += performance.now() - start }
    }
    const started = performance.now()
    let lag = 0
    const timer = new Promise<void>(resolve => setTimeout(() => { lag = performance.now() - started; resolve() }, 0))
    await store.retireWorkerMail(room, 'rohanz', 'local/aitinkerhackathon')
    const passMs = performance.now() - started, after = index.owedBytes
    await timer
    const totals = { bytes: index.owedBytes, recipients: structuredClone(index.recipients), ids: [...index.pending.keys()].sort() }
    index.rebuild()
    expect({ bytes: index.owedBytes, recipients: index.recipients, ids: [...index.pending.keys()].sort() }).toEqual(totals)
    const admission = admit(room, { to: 'review-mail2-probe', text: 'hello' }, Date.now())
    const afterAdmission = index.owedBytes
    trim(room, Date.now())
    const outcomeBytes = [...room.outcomes].reduce((n, [id, o]) => n + id.length + Buffer.byteLength(JSON.stringify(o)), 0)
    console.log('REVIEW_MAIL2_REAL', JSON.stringify({ before, after, afterAdmission, admission, passMs, messagePassMs, timerDelayMs: lag, registryRecords: records.length, retiredNames: names.size, namesWithDiskRecord: evidence.size, namesWithoutDiskRecord: names.size - evidence.size, owedRetiredNames: owedRetired.length, owedRetiredWithDisk: owedRetiredWithDisk.length, owedRetiredWithoutDisk: owedRetired.length - owedRetiredWithDisk.length, remainingRecipients: [...index.recipients.keys()].map(name => ({ name, archived: names.has(name), disk: records.some(r => r.name === name) })), outcomeCountAfterTrim: room.outcomes.size, outcomeBytesAfterTrim: outcomeBytes }))
    expect(admission).toEqual({ ok: true })
  } finally { store.close(); room.doc.destroy() }
})
