import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomDoc } from '@room/shared'
import { setParticipantBase } from '@room/shared/testing'
import { setGitObserver } from '@room/roomd/git'
import { GraphIndex } from '../src/graph-index.js'
import { DISK_TEXT_LIMIT, HistoricalTextTooLarge, readBoundedHistoricalText, readBoundedHistoricalTexts } from '../src/tools/disk-text.js'

let dir: string, first: string, second: string
const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
const PATHS = [...Array.from({ length: 70 }, (_, i) => `m${i}.py`), 'use.py', 'latin1.py', 'big.js']
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-graph-batch-'))
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  for (let i = 0; i < 70; i++) writeFileSync(join(dir, `m${i}.py`), `def f${i}(x):\n    return x\n`)
  writeFileSync(join(dir, 'use.py'), 'from m1 import f1\n\ndef g(x):\n    return f1(x)\n')
  writeFileSync(join(dir, 'latin1.py'), Buffer.concat([Buffer.from('# '), Buffer.from([0xe9]), Buffer.from('\ndef h(): pass\n')]))
  writeFileSync(join(dir, 'big.js'), `// ${'x'.repeat(DISK_TEXT_LIMIT)}\n`)
  git('add', '.'); git('commit', '-qm', 'one'); first = git('rev-parse', 'HEAD').trim()
  writeFileSync(join(dir, 'm2.py'), 'def renamed(x):\n    return x\n')
  writeFileSync(join(dir, 'use.py'), 'from m2 import renamed\n\ndef g(x):\n    return renamed(x)\n')
  git('add', '.'); git('commit', '-qm', 'two'); second = git('rev-parse', 'HEAD').trim()
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const snapshot = (index: GraphIndex) => ({ size: index.graph.size,
  files: PATHS.map(path => [path, index.graph.symbolsOf(path), index.graph.dependenciesOf(path)]) })

async function build(base: string, opts: ConstructorParameters<typeof GraphIndex>[4] = {}) {
  const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base)
  const logs: string[] = []
  const index = new GraphIndex(room, 'Rohan', dir, line => logs.push(line), { minPublishMs: 0, random: () => 0, ...opts })
  index.start(); await index.ready; await index.whenIdle()
  return { index, room, logs }
}

/** Git subcommands run while `work` runs, e.g. 'cat-file --batch'. */
async function gitCalls(work: () => Promise<unknown>): Promise<string[]> {
  const calls: string[] = []
  setGitObserver(args => { calls.push(args.slice(0, 2).join(' ')) })
  try { await work() } finally { setGitObserver(undefined) }
  return calls
}

describe('batched base reads', () => {
  it('reads many paths exactly as the per-path reader does', async () => {
    const texts = await readBoundedHistoricalTexts(dir, first, ['m0.py', 'latin1.py', 'big.js', 'absent.py'])
    expect(texts.get('m0.py')).toBe(await readBoundedHistoricalText(dir, first, 'm0.py'))
    expect(texts.get('latin1.py')).toBe(await readBoundedHistoricalText(dir, first, 'latin1.py'))
    expect(texts.get('big.js')).toBeInstanceOf(HistoricalTextTooLarge)
    expect(texts.get('absent.py')).toBeUndefined()
    await expect(readBoundedHistoricalTexts(dir, '0'.repeat(40), ['m0.py'])).rejects.toThrow('is unavailable')
  })

  it('indexes a base with a few Git calls and the same graph as per-file reads', async () => {
    let built!: Awaited<ReturnType<typeof build>>
    const calls = await gitCalls(async () => { built = await build(first) })
    expect(calls.filter(call => call === 'cat-file -p')).toEqual([])
    // 73 paths at 32 per read-ahead batch: a size check and a read each.
    expect(calls.filter(call => call.startsWith('cat-file'))).toHaveLength(6)
    expect(built.logs.filter(line => line.includes('big.js'))).toEqual([`graph: big.js is over the ${DISK_TEXT_LIMIT / 1024} KB read limit; not indexed`])
    const reference = await build(first, { read: readBoundedHistoricalText })
    expect(snapshot(built.index)).toEqual(snapshot(reference.index))
    built.index.stop(); reference.index.stop()
  })

  it('batches a refresh of every file after the build, as a grant change queues', async () => {
    const { index } = await build(first)
    const before = snapshot(index)
    const calls = await gitCalls(() => Promise.all(PATHS.map(path => index.refresh(path))).then(() => index.whenIdle()))
    expect(calls.filter(call => call.startsWith('cat-file')).length).toBeLessThanOrEqual(6)
    expect(snapshot(index)).toEqual(before)
    index.stop()
  })

  it('a base move reparses only changed blobs and matches a fresh build', async () => {
    const { index, room, logs } = await build(first)
    expect(index.graph.symbolsOf('m2.py')?.defs).toEqual(['f2'])
    setParticipantBase(room, 'Rohan', second)
    await index.ready; await index.whenIdle()
    // m2.py and use.py changed; big.js has no symbols to carry.
    expect(logs).toContain(`graph: reused 70 base files unchanged since ${first.slice(0, 10)}`)
    const fresh = await build(second)
    expect(snapshot(index)).toEqual(snapshot(fresh.index))
    expect(room.graphs.get('Rohan')?.edges).toEqual(fresh.room.graphs.get('Rohan')?.edges)
    index.stop(); fresh.index.stop()
  })

  it('a reconnect seed from an older base is reused for unchanged blobs only', async () => {
    const old = await build(first)
    const seed = old.index.baseSeed()
    old.index.stop()
    const next = await build(second, { seed })
    expect(next.logs).toContain(`graph: reused 70 base files unchanged since ${first.slice(0, 10)}`)
    expect(next.index.graph.definersOf('renamed')).toEqual(['m2.py'])
    expect(next.index.graph.definersOf('f2')).toEqual([])
    next.index.stop()
  })
})
