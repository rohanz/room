import { afterEach, expect, it, vi } from 'vitest'
import { DiskBatch } from '../src/disk-batch.js'

afterEach(() => vi.useRealTimers())

it('cancels a selected batch stopped before its queued run microtask starts', async () => {
  vi.useFakeTimers()
  const run = vi.fn(), batch = new DiskBatch(run, 10)
  try {
    batch.add('synthetic.js', true)
    vi.advanceTimersByTime(10)
    batch.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).not.toHaveBeenCalled()
    expect(batch.knownPaths()).toEqual([])
  } finally { batch.stop() }
})

it('retains one latest batch across twenty blocked bursts and preserves new-file flags', async () => {
  vi.useFakeTimers()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const seen: Map<string,boolean>[] = []
  const run = vi.fn(async (paths: Map<string,boolean>) => { seen.push(new Map(paths)); if(seen.length===1) await gate })
  const batch = new DiskBatch(run, 1)
  try {
    batch.add('active.js', false); await vi.advanceTimersByTimeAsync(1)
    for(let burst=0;burst<20;burst++) {
      for(let i=0;i<100;i++) batch.add(`p${i}.js`, burst===0)
      await vi.advanceTimersByTimeAsync(2010)
    }
    expect(run).toHaveBeenCalledTimes(1)
    expect(batch.knownPaths()).toHaveLength(101)
    release(); await vi.advanceTimersByTimeAsync(2100)
    expect(run).toHaveBeenCalledTimes(2)
    expect(seen[1].size).toBe(100)
    expect([...seen[1].values()].every(Boolean)).toBe(true)
    expect(batch.knownPaths()).toEqual([])
  } finally { release(); batch.stop() }
})
