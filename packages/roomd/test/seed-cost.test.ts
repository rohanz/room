import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'

/** Every git process roomd starts, by subcommand. */
const spawned: string[] = []
vi.mock('node:child_process', async importOriginal => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const count = (file: unknown, args: unknown) => { if (file === 'git' && Array.isArray(args)) spawned.push(String(args[0])) }
  return {
    ...real,
    execFile: ((file: string, args: string[], ...rest: unknown[]) => { count(file, args); return (real.execFile as Function)(file, args, ...rest) }) as typeof real.execFile,
    spawn: ((file: string, args: string[], ...rest: unknown[]) => { count(file, args); return (real.spawn as Function)(file, args, ...rest) }) as typeof real.spawn,
  }
})
const { startRoomd } = await import('../src/index.js')
type Roomd = Awaited<ReturnType<typeof startRoomd>>

const sh = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
const provider = (doc: Y.Doc): WebsocketProvider => {
  const states = new Map<number, unknown>()
  let local: unknown = null
  return { synced: true, awareness: { setLocalState(s: unknown) { local = s; if (s) states.set(doc.clientID, s); else states.delete(doc.clientID) }, getStates: () => states, getLocalState: () => local }, on() {}, off() {}, destroy() {} } as unknown as WebsocketProvider
}
const daemons: Roomd[] = []
afterEach(async () => { await Promise.all(daemons.splice(0).map(d => d.stop())) })

describe('overlay seed cost', () => {
  it('starts and follows a HEAD move with git work proportional to changed files, not tracked files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomd-seed-'))
    sh(dir, 'init', '-q', '-b', 'main'); sh(dir, 'config', 'user.email', 't@t'); sh(dir, 'config', 'user.name', 'T')
    for (let i = 0; i < 300; i++) { fs.mkdirSync(path.join(dir, `d${i % 10}`), { recursive: true }); fs.writeFileSync(path.join(dir, `d${i % 10}`, `f${i}.txt`), `line ${i}\n`) }
    sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'init')
    fs.appendFileSync(path.join(dir, 'd1/f1.txt'), 'changed\n')
    fs.rmSync(path.join(dir, 'd2/f2.txt'))
    fs.writeFileSync(path.join(dir, 'new.txt'), 'untracked\n')
    spawned.length = 0
    const d = await startRoomd({ dir, room: 'ws://memory/seed', name: 'T', providerFactory: (_s, _n, doc) => provider(doc), log: () => {}, basePollMs: 50, trackedRefreshMs: 60_000 })
    daemons.push(d)
    expect(d.roomDoc.changedPaths('T').sort()).toEqual(['d1/f1.txt', 'd2/f2.txt', 'new.txt'])
    expect(d.roomDoc.text('d1/f1.txt', 'T')).toBe('line 1\nchanged\n')
    expect(spawned.length).toBeLessThan(25)

    spawned.length = 0
    sh(dir, 'add', 'd1/f1.txt'); sh(dir, 'commit', '-qm', 'commit one change')
    const head = sh(dir, 'rev-parse', 'HEAD')
    while (d.base !== head || d.roomDoc.changedPaths('T').includes('d1/f1.txt')) await new Promise(r => setTimeout(r, 20))
    await d.settle()
    expect(d.roomDoc.changedPaths('T').sort()).toEqual(['d2/f2.txt', 'new.txt'])
    expect(spawned.filter(c => c !== 'rev-parse').length).toBeLessThan(25)
  }, 60_000)
})
