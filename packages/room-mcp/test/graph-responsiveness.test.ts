import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { RoomDoc } from '@room/shared'
import { setParticipantBase } from '@room/shared/testing'
import { GraphIndex } from '../src/graph-index.js'
import { handlers as fileHandlers } from '../src/tools/files.js'
import { handlers as claimHandlers } from '../src/tools/claims.js'
import type { HandlerState } from '../src/tools/context.js'

it('keeps tools responsive through a 3,000-file Rust graph build', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-rust-lag-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  const texts = new Map<string, string>()
  const room = new RoomDoc()
  let index: GraphIndex | undefined
  let timer: NodeJS.Timeout | undefined
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
    let maxLag = 0, last = performance.now(), maxClaim = 0, claims = 0
    const inFlight: Promise<void>[] = []
    timer = setInterval(() => {
      const now = performance.now(); maxLag = Math.max(maxLag, now - last - 10); last = now
      const start = now
      inFlight.push(claim({ path: 'file0.rs', from: 1, to: 1, intent: 'probe' }).then(() => {
        maxClaim = Math.max(maxClaim, performance.now() - start); claims++
      }))
    }, 10)
    const start = performance.now()
    index.start()
    while (index.graph.size < 8) await new Promise(resolve => setTimeout(resolve, 10))
    const impactStart = performance.now()
    const response = await impact({ symbol: 'function_0_0' })
    const impactMs = performance.now() - impactStart
    await index.ready
    const duration = performance.now() - start
    clearInterval(timer); await Promise.all(inFlight)
    console.log(JSON.stringify({ files: index.graph.size, indexingMs: Math.round(duration), maxLagMs: Math.round(maxLag), maxClaimMs: Math.round(maxClaim), impactMs: Math.round(impactMs), claims }))
    expect(index.graph.size).toBe(3000)
    expect(claims).toBeGreaterThan(5)
    expect(maxClaim).toBeLessThan(500)
    expect(maxLag).toBeLessThan(100)
    expect(impactMs).toBeLessThan(500)
    expect(response).toMatch(/graph still indexing \(\d+ of 3000 files\)/)
  } finally {
    clearInterval(timer); index?.stop(); room.doc.destroy(); fs.rmSync(dir, { recursive: true, force: true })
  }
}, 180_000)
