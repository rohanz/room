import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RoomDoc } from '@room/shared'
import { FileWorkerStore } from '../src/worker-file-store.js'
import type { WorkerRecord } from '../src/worker-status.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

it('reads each record once per mail or retention inventory, including inferred checkout owners', async () => {
  const common = fs.mkdtempSync(path.join(os.tmpdir(), 'room-registry-stalls-'))
  roots.push(common)
  const store = await FileWorkerStore.openReader(common)
  const now = Date.now()
  // Keep every fixture in the cache's racy timestamp window, even on a slow CI disk.
  vi.spyOn(Date, 'now').mockReturnValue(now)
  for (const family of ['workers', 'tags', 'runs']) fs.mkdirSync(path.join(store.root, family), { recursive: true })
  for (let i = 0; i < 90; i++) {
    const tag = `worker-${i}`, id = `w_fixture_${i}`
    const record: WorkerRecord = {
      v: 1, id, tag, name: `lead+${tag}`, mode: 'local', room: 'local/test/main',
      lead: { participant: 'lead', room: 'local/test/main', instance: store.instance }, host: 'claude',
      budget: { threads: 1, memGb: 1, nice: 10 }, share: 'full', task: 'test', outside: true,
      // Existing dir= workers require inferred owner lookup; no sharedWith was written.
      dir: path.join(common, 'outside', String(i)), logFile: path.join(common, `${tag}.log`), branch: 'main', prep: { step: 'prepared' },
      capabilities: { resume: false, signal: false, collect: 'copy' }, phase: i < 60 ? 'active' : 'retired',
      runs: [{ n: 1, mode: 'fresh', intentAt: now, nonce: id, busFrontier: 0, promptMsgIds: [],
        launcher: store.instance, logStart: 0, launch: { outcome: 'launched', pid: process.pid } }],
      ...(i >= 60 ? { archive: { id, tag, name: `lead+${tag}`, lead: 'lead', host: 'claude', task: 'test', files: [],
        fileCount: 0, startedAt: now, finishedAt: now, retiredAt: now, summary: 'done', outcome: 'dismissed' } as const,
      cleanup: { 'local/test/main': 'done' as const } } : {}),
      createdAt: now, seq: 1,
    }
    fs.writeFileSync(path.join(store.root, 'workers', `${id}.json`), JSON.stringify(record))
    fs.writeFileSync(path.join(store.root, 'tags', `${tag}.json`), JSON.stringify({ id }))
    const runs = path.join(store.root, 'runs', id)
    fs.mkdirSync(runs)
    fs.writeFileSync(path.join(runs, '1.report.json'), JSON.stringify({ run: 1, nonce: id, chain: [], joinedAt: now }))
    fs.writeFileSync(path.join(runs, '1.exit.json'), JSON.stringify({ run: 1, code: 0, at: now, witnessed: true }))
    fs.writeFileSync(path.join(common, `${tag}.log`), '{"type":"result","result":"done"}\n')
  }
  const room = new RoomDoc()
  const read = fs.readFileSync.bind(fs)
  const counts = new Map<string, number>()
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => {
    if (String(file).startsWith(store.root) && String(file).endsWith('.json')) counts.set(String(file), (counts.get(String(file)) ?? 0) + 1)
    return read(file, ...args as [])
  }) as typeof fs.readFileSync)
  const measurements: { name: string; ms: number; reads: number; maxReadsPerFile: number }[] = []
  try {
    for (const [name, run] of [
      ['mail', () => store.retireWorkerMail(room, 'lead', 'local/test/main')],
      ['prune', () => store.pruneRetired(7 * 86_400_000)],
    ] as const) {
      counts.clear()
      const start = performance.now()
      await run()
      measurements.push({ name, ms: performance.now() - start, reads: [...counts.values()].reduce((a, b) => a + b, 0), maxReadsPerFile: Math.max(...counts.values()) })
    }
  } finally { spy.mockRestore(); store.close(); room.doc.destroy() }
  process.stdout.write(JSON.stringify({ registryRecords: 90, measurements }) + '\n')
  for (const measurement of measurements) {
    expect(measurement.reads).toBe(180)
    expect(measurement.maxReadsPerFile).toBe(1)
  }
})
