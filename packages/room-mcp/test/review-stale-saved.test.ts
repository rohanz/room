import { expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { RoomDoc, deliveryIndex, validMessageShape, type Msg } from '@room/shared'
import { retiredNoticeMatcher } from '../../shared/src/notice-subjects.js'
import { FileWorkerStore } from '../src/worker-file-store.js'

it.runIf(process.env.REVIEW_STALE_SAVED === '1')('measures one retention mail/state pass on copies of the owner room and registry', async () => {
  const source = '/Users/rohan/Documents/progwork/aitinkerhackathon/.git/room'
  const common = fs.mkdtempSync(path.join(os.tmpdir(), 'review-stale-saved-'))
  fs.mkdirSync(path.join(common, 'room'), { recursive: true })
  fs.copyFileSync(path.join(source, 'relay', 'local%2Faitinkerhackathon.ydoc'), path.join(common, 'saved.ydoc'))
  fs.cpSync(path.join(source, 'registry'), path.join(common, 'room', 'registry'), { recursive: true })
  const room = new RoomDoc(), store = await FileWorkerStore.openReader(common)
  try {
    Y.applyUpdate(room.doc, fs.readFileSync(path.join(common, 'saved.ydoc')))
    const records = fs.readdirSync(path.join(store.root, 'workers')).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(store.root, 'workers', f), 'utf8')))
    const ended = records.filter(r => ['retired', 'abandoned'].includes(r.phase))
    const index = deliveryIndex(room), matches = retiredNoticeMatcher([...room.retiredWorkers(), ...ended])
    const count = () => [...index.pending.values()].filter(m => matches(m)).length
    const before = count(), pendingBefore = index.pending.size
    const initial = [...index.pending.values()]
    const legacy = (m: Msg) => validMessageShape(m) && m.from === 'room' && m.id.startsWith('cf:') &&
      ['conflict', 'merge-conflict', 'contract'].includes(m.type) && !m.noticeSubjects
    const legacyBefore = initial.filter(legacy).length
    let syncMs = 0
    const original = room.retireWorkerState.bind(room)
    room.retireWorkerState = (...args) => { const start = performance.now(); try { return original(...args) } finally { syncMs += performance.now() - start } }
    let maxLagMs = 0, last = performance.now()
    const interval = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - last); last = now }, 1)
    const start = performance.now()
    await store.retireWorkerMail(room, 'rohanz', 'local/aitinkerhackathon')
    const elapsedMs = performance.now() - start
    await new Promise(resolve => setTimeout(resolve, 5)); clearInterval(interval)
    const after = count(), remaining = [...index.pending.values()].map(m => ({ id: m.id, type: m.type, from: m.from, to: m.to, text: 'text' in m ? m.text : undefined }))
    const totals = { bytes: index.owedBytes, recipients: structuredClone(index.recipients), ids: [...index.pending.keys()].sort() }
    index.rebuild()
    expect({ bytes: index.owedBytes, recipients: index.recipients, ids: [...index.pending.keys()].sort() }).toEqual(totals)
    const legacyRemaining = [...index.pending.values()].filter(legacy).length
    const legacyRecipientRetired = initial.filter(m => legacy(m) && room.outcomes.get(m.id)?.outcome === 'recipient-retired').length
    fs.writeFileSync('/tmp/stale2-saved-result.json', JSON.stringify({ before, after, pendingBefore, pendingAfter: index.pending.size,
      legacyBefore, legacyRemaining, legacyRecipientRetired, registryRecords: records.length, elapsedMs, syncMs, maxLagMs, remaining }, null, 2))
    expect(after).toBe(0)
  } finally { store.close(); room.doc.destroy(); fs.rmSync(common, { recursive: true, force: true }) }
})
