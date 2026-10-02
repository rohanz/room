import { expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RoomDoc } from '@room/shared'
import { setParticipantBase } from '@room/shared/testing'
import { GraphIndex } from '../src/graph-index.js'
import { ParseWorker } from '../src/parse/client.js'
import * as engine from '../src/parse/engine.js'
import { handlers as fileHandlers } from '../src/tools/files.js'
import { handlers as claimHandlers } from '../src/tools/claims.js'
import type { HandlerState } from '../src/tools/context.js'

it('keeps tools responsive through a 3,000-file Rust graph build', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-rust-lag-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  const texts = new Map<string, string>()
  const room = new RoomDoc()
  let index: GraphIndex | undefined
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let parsingStarted!: () => void
  const started = new Promise<void>(resolve => { parsingStarted = resolve })
  const mainThreadParse = vi.spyOn(engine, 'parseFile')
  const realParse = ParseWorker.prototype.parse
  const parse = vi.spyOn(ParseWorker.prototype, 'parse').mockImplementation(async function (p, texts) {
    parsingStarted()
    await gate
    return realParse.call(this, p, texts)
  })
  try {
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
    for (let i = 0; i < 3000; i++) {
      const name = `file${i}.rs`
      const text = Array.from({ length: 40 }, (_, f) => `pub fn function_${i}_${f}(value: usize) -> usize { let result = value + ${f}; result }\n`).join('')
      texts.set(name, text); fs.writeFileSync(path.join(dir, name), text)
    }
    git('add', '.'); git('commit', '-qm', 'synthetic Rust tree')
    setParticipantBase(room, 'A', git('rev-parse', 'HEAD'))
    // Immutable baseline reads are warm: isolate parsing from thousands of Git subprocesses.
    index = new GraphIndex(room, 'A', dir, undefined, { random: () => 0, minPublishMs: 0, read: async (_dir, _base, p) => texts.get(p) })
    const state = { S: () => ({ room, graph: index, me: { name: 'A', kind: 'agent' }, awareness: { getStates: () => new Map() } }),
      describeUsers: (_s: unknown, users: string[]) => users.join(', ') } as unknown as HandlerState
    const claim = claimHandlers(state).room_claim!
    const impact = fileHandlers(state).room_impact!
    index.start()
    await started
    // Hold every parse response: tools must finish before the index can complete,
    // and only the bounded refresh batch may reach the parser.
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(parse.mock.calls.length).toBeGreaterThan(0)
    expect(parse.mock.calls.length).toBeLessThanOrEqual(8)
    expect(index.graph.size).toBe(0)
    for (let i = 0; i < 10; i++) {
      expect(await claim({ path: 'file0.rs', from: 1, to: 1, intent: 'probe' })).toContain('no claim needed')
    }
    const response = await impact({ symbol: 'function_0_0' })
    expect(response).toBe('partial: graph still indexing (0 of 3000 files)')
    expect(index.graph.size).toBe(0)
    expect(parse.mock.calls.length).toBeLessThanOrEqual(8)
    release()
    await index.ready
    expect(index.graph.size).toBe(3000)
    expect(parse).toHaveBeenCalledTimes(3000)
    expect(new Set(parse.mock.calls.map(([p]) => p)).size).toBe(3000)
    expect(mainThreadParse).not.toHaveBeenCalled()
  } finally {
    release(); index?.stop(); parse.mockRestore(); mainThreadParse.mockRestore()
    room.doc.destroy(); fs.rmSync(dir, { recursive: true, force: true })
  }
}, 180_000)
