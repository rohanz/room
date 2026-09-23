import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'

/** Every git process roomd starts, by subcommand. */
const spawned: string[] = []
const gitArgs: string[][] = []
vi.mock('node:child_process', async importOriginal => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const count = (file: unknown, args: unknown) => { if (file === 'git' && Array.isArray(args)) { spawned.push(String(args[0])); gitArgs.push(args.map(String)) } }
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
const hashes = () => gitArgs.filter(args => args[0] === 'hash-object').length

function oversizedRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomd-large-seed-'))
  sh(dir, 'init', '-q', '-b', 'main'); sh(dir, 'config', 'user.email', 't@t'); sh(dir, 'config', 'user.name', 'T')
  fs.writeFileSync(path.join(dir, 'tracked.exr'), '123456789012345678901234')
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'init')
  for (let i = 0; i < 30; i++) { const file = path.join(dir, `large-${i}.exr`); fs.writeFileSync(file, ''); fs.truncateSync(file, 1024) }
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(dir, `small-${i}.txt`), `text ${i}\n`)
  return dir
}

async function startLarge(dir: string, basePollMs = 60_000): Promise<Roomd> {
  const d = await startRoomd({ dir, room: 'ws://memory/large', name: 'T', providerFactory: (_s, _n, doc) => provider(doc), log: () => {}, sizeCap: 16, trackedRefreshMs: 60_000, basePollMs })
  daemons.push(d)
  return d
}

describe('overlay seed cost', () => {
  it('seeds 30 sparse untracked oversized files without hashing any of them', async () => {
    const dir = oversizedRepo()
    gitArgs.length = 0
    const d = await startLarge(dir)
    expect(hashes()).toBe(0)
    expect(gitArgs.filter(args => args[0] === 'cat-file' && args.includes('--batch-check'))).toHaveLength(1)
    expect(d.skipped().size).toHaveLength(30)
    expect(d.roomDoc.changedPaths('T').sort()).toEqual(['small-0.txt', 'small-1.txt', 'small-2.txt'])
  })

  it('detects a tracked oversized file with a different size without hashing', async () => {
    const dir = oversizedRepo()
    fs.writeFileSync(path.join(dir, 'tracked.exr'), '1234567890123456789012345')
    gitArgs.length = 0
    const d = await startLarge(dir)
    expect(hashes()).toBe(0)
    expect(d.skipped().size).toContain('tracked.exr')
  })

  it('reuses a large file hash when HEAD moves to its content', async () => {
    const dir = oversizedRepo()
    fs.writeFileSync(path.join(dir, 'tracked.exr'), 'abcdefghijklmnopqrstuvwx')
    gitArgs.length = 0
    const d = await startLarge(dir, 50)
    expect(hashes()).toBe(1)
    sh(dir, 'add', 'tracked.exr'); sh(dir, 'commit', '-qm', 'record large file')
    const head = sh(dir, 'rev-parse', 'HEAD')
    gitArgs.length = 0
    const until = Date.now() + 5000
    while ((d.base !== head || d.skipped().size.includes('tracked.exr')) && Date.now() < until) await new Promise(r => setTimeout(r, 20))
    expect(d.base).toBe(head)
    expect(hashes()).toBe(0)
    expect(d.skipped().size).not.toContain('tracked.exr')
  })

  it('hashes a same-size tracked change once and reuses the verdict on reconcile', async () => {
    const dir = oversizedRepo()
    fs.writeFileSync(path.join(dir, 'tracked.exr'), 'abcdefghijklmnopqrstuvwx')
    gitArgs.length = 0
    const d = await startLarge(dir)
    expect(hashes()).toBe(1)
    expect(d.skipped().size).toContain('tracked.exr')
    gitArgs.length = 0
    await d.setShare('full')
    expect(hashes()).toBe(0)
    expect(d.skipped().size).toContain('tracked.exr')
  })

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
