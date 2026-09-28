// Ledger test 6 (MF1): a reply's receipts are written only once its bytes reached the host's pipe.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import type { NoteMsg } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { createTools, type Settle } from '../src/tools/index.js'
import { FlushedStdioTransport } from '../src/transport.js'
import { memorySession } from './fixtures/session.js'

const me = { name: 'Pat', kind: 'agent' as const }
const quinn = { name: 'Quinn', kind: 'agent' as const }
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** stdout whose write() returns true at once and whose callback reports `error` later (or never). */
function pipe(error: Error | null | 'never') {
  const out = new Writable({
    highWaterMark: 1 << 20,
    write(_chunk, _enc, callback) { if (error !== 'never') setTimeout(() => callback(error), 5) },
  })
  return out.on('error', () => {})
}

async function reply(error: Error | null | 'never') {
  const dir = mkdtempSync(join(tmpdir(), 'room-transport-')); dirs.push(dir)
  const s = memorySession(me, dir)
  const m = hubAppend<NoteMsg>(s.room, quinn, { type: 'note', to: me.name, text: 'owed to Pat' })
  const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir })
  let settle!: Settle
  const text = await tools.call('room_state', {}, undefined, x => { settle = x })
  expect(text).toContain('owed to Pat')
  const transport = new FlushedStdioTransport(new PassThrough(), pipe(error))
  transport.expect(1, settle)
  const sent = transport.send({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } })
  return { s, m, tools, dir, sent }
}

describe('FlushedStdioTransport (ledger test 6)', () => {
  it('commits the reply batch when the write callback succeeds', async () => {
    const { s, m, sent } = await reply(null)
    await sent
    expect(s.room.seen(me.name).get(m.id)).toMatchObject({ via: 'reply' })
  })

  it('write() returned true but the callback errors: no receipt, and the message is shown again', async () => {
    const { s, m, tools, sent } = await reply(new Error('EPIPE'))
    await expect(sent).rejects.toThrow('EPIPE')
    expect(s.room.seen(me.name).has(m.id)).toBe(false)
    expect(await tools.call('room_state', {})).toContain('owed to Pat')
  })

  it('killed before the callback: no receipt, and a restarted MCP delivers it', async () => {
    const { s, m, dir } = await reply('never')
    await new Promise(r => setTimeout(r, 20))
    expect(s.room.seen(me.name).has(m.id)).toBe(false)
    const restarted = createTools({ getSession: () => s, setSession: () => {}, cwd: dir })
    expect(await restarted.call('room_state', {})).toContain('owed to Pat')
    expect(s.room.seen(me.name).get(m.id)).toMatchObject({ via: 'reply' })
  })
})
