import { it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Awareness } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd } from '../src/index.js'

it('reports only changed size skips and clears skip reasons and stale overlays on recovery/deletion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-signals-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(dir, 'large.txt'), 'a'.repeat(100))
  fs.writeFileSync(path.join(dir, 'small.txt'), 'base')
  git('add', '.'); git('commit', '-qm', 'base')
  const daemon = await startRoomd({ dir, name: 'Test', room: 'ws://memory/skips', sizeCap: 50, totalBudget: 20, log: () => {}, providerFactory: (_server, _room, doc) => {
    const awareness = new Awareness(doc)
    return { synced: true, awareness, on() {}, off() {}, destroy() { awareness.destroy() } } as unknown as WebsocketProvider
  } })
  // Re-evaluate deterministically through the public sharing API; no watcher sleeps.
  const write = async (file: string, text: string | null) => {
    if (text === null) fs.rmSync(path.join(dir, file))
    else fs.writeFileSync(path.join(dir, file), text)
    await daemon.setShare('full')
  }
  try {
    expect(daemon.skipped().size).toEqual([])
    await daemon.setShare('intent')
    expect(daemon.skipped().size).toEqual([])
    await write('large.txt', 'b'.repeat(100))
    expect(daemon.skipped().size).toEqual(['large.txt'])
    await write('large.txt', 'a'.repeat(100))
    expect(daemon.skipped().size).toEqual([])
    await write('small.txt', 'shared')
    expect(daemon.roomDoc.text('small.txt', 'Test')).toBe('shared')
    await write('small.txt', 'c'.repeat(30))
    expect(daemon.skipped().budget).toEqual(['small.txt'])
    expect(daemon.roomDoc.overlayText('Test', 'small.txt')).toBeUndefined()
    await write('small.txt', 'c'.repeat(100))
    expect(daemon.skipped().budget).toEqual([])
    expect(daemon.skipped().size).toEqual(['small.txt'])
    await write('small.txt', null)
    expect(daemon.skipped().size).toEqual([])
    expect(daemon.skipped().budget).toEqual([])
  } finally { await daemon.stop(); fs.rmSync(dir, { recursive: true, force: true }) }
})
