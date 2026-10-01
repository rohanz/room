import { manifestText } from './manifest-assert.js'
import { policyFromLevel } from '../src/policy.js'
import { it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Awareness } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import type { FSWatcher } from 'chokidar'
import { startRoomd, type RoomdOptions } from '../src/index.js'

vi.setConfig({ testTimeout: 60_000 })
beforeAll(() => { vi.stubEnv('CHOKIDAR_USEPOLLING', '1') })
afterAll(() => { vi.unstubAllEnvs() })

/** A vendored, gitignored tree (3,000 files, like a JUCE checkout; not named vendor/, which is pruned by name), a gitignored folder holding one
 * force-tracked file, and a few normal files. */
function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ignored-tree-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
  put('.gitignore', 'libs/JUCE/\nthird_party/\nout-cache/\n')
  put('app.py', 'x = 1\n'); put('lib/util.py', 'def f():\n    return 1\n'); put('third_party/keep.h', '#define KEEP 1\n')
  git('add', '.'); git('add', '-f', 'third_party/keep.h'); git('commit', '-qm', 'base')
  for (let m = 0; m < 30; m++) for (let s = 0; s < 10; s++) for (let f = 0; f < 10; f++) put(`libs/JUCE/modules/m${m}/src${s}/f${f}.cpp`, `// ${m}.${s}.${f}\n`)
  for (let f = 0; f < 50; f++) put(`third_party/gen/g${f}.h`, `// ${f}\n`)
  return dir
}

type Internals = { watcher: FSWatcher; refreshTracked(): Promise<void> }
const internals = (daemon: unknown) => daemon as Internals

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) { if (Date.now() > deadline) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)) }
}

it('prunes a gitignored tree at the folder and logs its skip summary once per real change', async () => {
  const dir = fixture()
  const logs: string[] = []
  const scanned: string[] = []
  const touched: string[] = []
  const inIgnoredTree = (p: unknown) => /[\\/](?:libs[\\/]JUCE|third_party[\\/]gen|out-cache)[\\/]/.test(String(p))
  const spies = (['lstatSync', 'statSync', 'realpathSync', 'readFileSync', 'openSync', 'readdirSync'] as const).map(name => {
    const original = fs[name] as (...args: unknown[]) => unknown
    return vi.spyOn(fs, name).mockImplementation(((...args: unknown[]) => {
      if (inIgnoredTree(args[0])) touched.push(`${name} ${String(args[0])}`)
      return original.apply(fs, args)
    }) as never)
  })
  // hotThrottleMs: 0, since each driven cycle republishes app.py and would otherwise make it a throttled hot path.
  const options: RoomdOptions = { policy: policyFromLevel('full'), dir, name: 'Test', room: 'ws://memory/ignored-tree', debounceMs: 20, hotThrottleMs: 0,
    trackedRefreshMs: 0, basePollMs: 0, reconcileIntervalMs: 0, log: line => logs.push(line), onScanned: p => scanned.push(p),
    providerFactory: (_server, _room, doc) => {
      const awareness = new Awareness(doc)
      return { synced: true, awareness, on() {}, off() {}, destroy() { awareness.destroy() } } as unknown as WebsocketProvider
    } }
  const daemon = await startRoomd(options)
  const skipLines = () => logs.filter(line => /\bskipped\b/.test(line))
  const watchedUnder = (rel: string) => Object.keys(internals(daemon).watcher.getWatched())
    .filter(d => d === path.join(dir, rel) || d.startsWith(path.join(dir, rel) + path.sep))
  try {
    // (a) The ignored trees are pruned at their folders: nothing under them is watched, stat'ed or read.
    expect(watchedUnder('libs/JUCE')).toEqual([])
    expect(watchedUnder('third_party/gen')).toEqual([])
    // The ignored folder that holds a tracked file is still watched, for that file.
    expect(watchedUnder('third_party')).toEqual([path.join(dir, 'third_party')])
    // Git also lists libs/ (everything in it is ignored today), but no rule matches libs/: a new file there is shared.
    fs.writeFileSync(path.join(dir, 'libs', 'new.c'), 'int x;\n')
    await until(() => manifestText(daemon.roomDoc, 'libs/new.c', 'Test') === 'int x;\n')

    // (b) Several cycles, with writes inside the ignored tree, log the summary exactly once.
    for (let cycle = 0; cycle < 3; cycle++) {
      for (let f = 0; f < 20; f++) fs.writeFileSync(path.join(dir, 'libs', 'JUCE', 'modules', `m${f}`, 'src0', 'f0.cpp'), `// cycle ${cycle}\n`)
      fs.writeFileSync(path.join(dir, 'app.py'), `x = ${cycle + 2}\n`)
      await until(() => manifestText(daemon.roomDoc, 'app.py', 'Test') === `x = ${cycle + 2}\n`)
      await internals(daemon).refreshTracked()
      await daemon.reconcileGitChanges()
      await daemon.settle()
    }
    expect(touched).toEqual([])
    expect(scanned.filter(inIgnoredTree)).toEqual([])
    expect(skipLines()).toHaveLength(1)
    expect(skipLines()[0]).toContain('2 gitignored folders, not watched: libs/JUCE/, third_party/gen/')

    // (c1) A real change: the tracked file inside an ignored folder changes. It is still seen, and withheld.
    fs.writeFileSync(path.join(dir, 'third_party', 'keep.h'), '#define KEEP 2\n')
    await until(() => skipLines().length === 2)
    expect(skipLines()[1]).toMatch(/skipped 1 file\(s\) \(1 ignore\), e\.g\. third_party\/keep\.h, and 2 gitignored folders/)
    expect(manifestText(daemon.roomDoc, 'third_party/keep.h', 'Test')).toBeUndefined()

    // (c2) A new ignored folder appears: it is pruned once Git reports it, and the summary is logged again, once.
    const writeOutput = (from: number, to: number) => {
      for (let f = from; f < to; f++) {
        fs.mkdirSync(path.join(dir, 'out-cache', `d${f % 5}`), { recursive: true })
        fs.writeFileSync(path.join(dir, 'out-cache', `d${f % 5}`, `o${f}.txt`), `${f}\n`)
      }
    }
    writeOutput(0, 50)
    await until(() => skipLines().length === 3)
    expect(skipLines()[2]).toContain('3 gitignored folders, not watched: libs/JUCE/, out-cache/, third_party/gen/')
    await daemon.settle()
    // Pruned: later output there produces no events at all.
    const before = scanned.length
    writeOutput(50, 100)
    fs.mkdirSync(path.join(dir, 'out-cache', 'late')); fs.writeFileSync(path.join(dir, 'out-cache', 'late', 'x.txt'), 'x\n')
    await new Promise(r => setTimeout(r, 1000))
    await daemon.settle()
    expect(scanned.slice(before).filter(inIgnoredTree)).toEqual([])
    for (let cycle = 0; cycle < 2; cycle++) {
      await internals(daemon).refreshTracked()
      await daemon.reconcileGitChanges()
      await daemon.settle()
    }
    expect(skipLines()).toHaveLength(3)
  } finally {
    for (const spy of spies) spy.mockRestore()
    await daemon.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

it('withdraws a shared file when its folder becomes ignored outside .gitignore, at the periodic folder listing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ignored-tree-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(dir, 'app.py'), 'x = 1\n'); git('add', '.'); git('commit', '-qm', 'base')
  fs.mkdirSync(path.join(dir, 'gen', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'gen', 'deep', 'out.txt'), 'generated\n')
  const logs: string[] = []
  const daemon = await startRoomd({ policy: policyFromLevel('full'), dir, name: 'Test', room: 'ws://memory/ignored-later', debounceMs: 20,
    trackedRefreshMs: 0, basePollMs: 0, reconcileIntervalMs: 0, log: line => logs.push(line),
    providerFactory: (_server, _room, doc) => {
      const awareness = new Awareness(doc)
      return { synced: true, awareness, on() {}, off() {}, destroy() { awareness.destroy() } } as unknown as WebsocketProvider
    } })
  try {
    expect(manifestText(daemon.roomDoc, 'gen/deep/out.txt', 'Test')).toBe('generated\n')
    // .git/info/exclude is not watched; the folder listing older than a minute is what notices it.
    fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), 'gen/\n')
    ;(daemon as unknown as { ignoredDirsAt: number }).ignoredDirsAt = 0
    await internals(daemon).refreshTracked()
    await until(() => manifestText(daemon.roomDoc, 'gen/deep/out.txt', 'Test') === undefined
      && logs.some(line => line.includes('1 gitignored folder, not watched: gen/')), 5_000)
    expect(daemon.roomDoc.manifestHead.get('Test')?.excluded).toEqual([])
  } finally {
    await daemon.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
