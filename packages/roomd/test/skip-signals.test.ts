import { manifestText, incarnationText } from './manifest-assert.js'
import { policyFromLevel } from '../src/policy.js'
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
  const daemon = await startRoomd({ policy: policyFromLevel('full'), dir, name: 'Test', room: 'ws://memory/skips', sizeCap: 50, totalBudget: 20, log: () => {}, providerFactory: (_server, _room, doc) => {
    const awareness = new Awareness(doc)
    return { synced: true, awareness, on() {}, off() {}, destroy() { awareness.destroy() } } as unknown as WebsocketProvider
  } })
  // Re-evaluate deterministically through the new policy inputs; no watcher sleeps.
  const level = async (next: 'intent' | 'full') => {
    daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel(next) })
    await daemon.reconcileGitChanges()
  }
  const write = async (file: string, text: string | null) => {
    if (text === null) fs.rmSync(path.join(dir, file))
    else fs.writeFileSync(path.join(dir, file), text)
    await daemon.reconcileGitChanges()
  }
  try {
    expect(daemon.skipped().size).toEqual([])
    await level('intent')
    expect(daemon.skipped().size).toEqual([])
    await level('full')
    await write('large.txt', 'b'.repeat(100))
    expect(daemon.skipped().size).toEqual(['large.txt'])
    await write('large.txt', 'a'.repeat(100))
    expect(daemon.skipped().size).toEqual([])
    await write('small.txt', 'shared')
    expect(manifestText(daemon.roomDoc, 'small.txt', 'Test')).toBe('shared')
    await write('small.txt', 'c'.repeat(30))
    expect(daemon.skipped().budget).toEqual(['small.txt'])
    expect(incarnationText(daemon.roomDoc, 'Test', 'small.txt')).toBeUndefined()
    await write('small.txt', 'c'.repeat(100))
    expect(daemon.skipped().budget).toEqual([])
    expect(daemon.skipped().size).toEqual(['small.txt'])
    await write('small.txt', null)
    expect(daemon.skipped().size).toEqual([])
    expect(daemon.skipped().budget).toEqual([])
  } finally { await daemon.stop(); fs.rmSync(dir, { recursive: true, force: true }) }
})
