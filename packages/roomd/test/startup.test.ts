import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd } from '../src/index.js'

// Native watching on purpose: these cases are about what the platform watcher reports during startup.
const sh = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
const provider = (doc: Y.Doc): WebsocketProvider => {
  const states = new Map<number, unknown>()
  let local: unknown = null
  return { synced: true, awareness: { setLocalState(s: unknown) { local = s; if (s) states.set(doc.clientID, s); else states.delete(doc.clientID) }, getStates: () => states, getLocalState: () => local }, on() {}, off() {}, destroy() {} } as unknown as WebsocketProvider
}
function dirtyRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomd-startup-'))
  sh(dir, 'init', '-q', '-b', 'main'); sh(dir, 'config', 'user.email', 't@t'); sh(dir, 'config', 'user.name', 'T')
  fs.writeFileSync(path.join(dir, 'app.py'), 'x = 1\n')
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'init')
  fs.writeFileSync(path.join(dir, 'app.py'), 'x = 2\n')
  return dir
}
const restore: (() => void)[] = []
afterEach(() => { for (const r of restore.splice(0)) r() })

describe('roomd startup', () => {
  it('fails the start, naming the watch step, when the clone itself cannot be watched', async () => {
    const dir = dirtyRepo()
    restore.push(() => fs.chmodSync(dir, 0o755))
    // Git has read the clone by the time the seed publishes; then the clone stops being listable.
    const start = startRoomd({ dir, room: 'ws://memory/w', name: 'T', providerFactory: (_s, _n, doc) => provider(doc), log: () => {},
      beforePublishWrite: async () => { fs.chmodSync(dir, 0o300) } })
    const error = await start.then(() => undefined, e => e)
    expect(error).toMatchObject({ phase: 'watch' })
    expect(String(error)).toMatch(/cannot watch/)
  })

  it('enforces an overall startup deadline and names the step that overran', async () => {
    const dir = dirtyRepo()
    const started = Date.now()
    const error = await startRoomd({ dir, room: 'ws://memory/d', name: 'T', providerFactory: (_s, _n, doc) => provider(doc), log: () => {}, startupTimeoutMs: 500,
      beforePublishWrite: () => new Promise(() => { /* a seed step that never finishes */ }) }).then(() => undefined, e => e)
    expect(error).toMatchObject({ phase: 'seed' })
    expect(String(error)).toMatch(/startup did not finish within 1s|startup did not finish within 0s/)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('allows a seed to exceed the deadline while each path keeps making progress', async () => {
    const dir = dirtyRepo()
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dir, `new-${i}.txt`), `new ${i}\n`)
    const started = Date.now()
    const d = await startRoomd({ dir, room: 'ws://memory/progress', name: 'T', providerFactory: (_s, _n, doc) => provider(doc), log: () => {}, startupTimeoutMs: 350,
      beforePublishWrite: () => new Promise(resolve => setTimeout(resolve, 120)) })
    try {
      expect(Date.now() - started).toBeGreaterThan(350)
      expect(d.roomDoc.changedPaths('T')).toHaveLength(7)
    } finally { await d.stop() }
  })
})
