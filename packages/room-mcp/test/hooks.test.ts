import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { RoomDoc } from '@room/shared'
import { HooksBridge } from '../src/hooks-bridge.js'
import type { Session } from '../src/session.js'

const HOOKS = resolve(__dirname, '../../../plugins/room/hooks')
let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-hooks-'))
  execFileSync('git', ['-C', dir, 'init', '-q'])
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function runHook(script: string, input: object): Promise<string> {
  return new Promise((res, rej) => {
    const p = execFile('node', [join(HOOKS, script)], { cwd: HOOKS }, (err, out) => err ? rej(err) : res(out))
    p.stdin!.end(JSON.stringify(input))
  })
}

function session(room: RoomDoc): Session {
  const awareness = new Awareness(room.doc)
  return { room, awareness, me: { name: 'Rohan', kind: 'agent' }, dir, roomUrl: 'ws://x/r', roomName: 'r', browserUrl: '', provider: { synced: true } as never, daemon: { touch() {}, async stop() {} } as never }
}

describe('hooks bridge + plugin hook scripts', () => {
  it('SessionStart records the thread id; interrupts and questions for me wake it once', async () => {
    await runHook('session-start.mjs', { session_id: 'thread-1', cwd: dir })
    expect(JSON.parse(readFileSync(join(dir, '.git/room-session.json'), 'utf8')).session_id).toBe('thread-1')
    const room = new RoomDoc()
    const s = session(room)
    const queued: string[] = []
    const b = new HooksBridge(s, { forMe: m => m.to === 'Rohan' || m.type === 'conflict' || m.type === 'base', isSeen: () => false, queue: async (id, text) => { queued.push(`${id}: ${text.split('\n')[0]}`) } })
    b.start()
    const k = { name: 'Kieran', kind: 'agent' as const }
    // remote inserts: apply from another doc so transaction.local is false
    const other = new RoomDoc(); other.doc.on('update', (u: Uint8Array) => Y.applyUpdate(room.doc, u))
    other.post(k, { type: 'note', to: 'Rohan', text: 'fyi only' } as never)
    other.post(k, { type: 'question', to: 'Rohan', text: 'are you done?' } as never)
    other.post(k, { type: 'note', to: 'Rohan', text: 'stop!', priority: 'interrupt' } as never)
    // a base move wakes only when I have uncommitted work
    other.post(k, { type: 'base', base: 'b'.repeat(40), prev: 'a'.repeat(40), commits: 1, paths: ['app.py'], summary: 'x' } as never)
    await new Promise(r => setTimeout(r, 50))
    expect(queued.length).toBe(2)
    room.setOverlay('Rohan', 'app.py', 'x = 2\n')
    other.post(k, { type: 'base', base: 'c'.repeat(40), prev: 'b'.repeat(40), commits: 1, paths: ['app.py'], summary: 'y' } as never)
    await new Promise(r => setTimeout(r, 50))
    expect(queued.length).toBe(3)
    expect(queued[2]).toContain('moved the base')
    expect(queued[0]).toContain('thread-1: [room] [notify]')
    expect(queued[1]).toContain('stop!')
    b.stop()
  })

  it('a failed wake retries with backoff and marks the message only once it succeeds', async () => {
    writeFileSync(join(dir, '.git/room-session.json'), JSON.stringify({ session_id: 'thread-2', at: Date.now(), cwd: dir, host: 'codex' }))
    const room = new RoomDoc()
    const s = session(room)
    let calls = 0
    const b = new HooksBridge(s, { forMe: m => m.to === 'Rohan', isSeen: () => false, retryDelaysMs: [1, 1, 1], queue: async () => { calls++; if (calls < 3) throw new Error('codex busy') } })
    b.start()
    const other = new RoomDoc(); other.doc.on('update', (u: Uint8Array) => Y.applyUpdate(room.doc, u))
    other.post({ name: 'Kieran', kind: 'agent' }, { type: 'note', to: 'Rohan', text: 'stop!', priority: 'interrupt' } as never)
    await new Promise(r => setTimeout(r, 60))
    expect(calls).toBe(3)
    expect((b as unknown as { woken: Set<string> }).woken.size).toBe(1)
    b.stop()
  })

  it('gives up after the retries are exhausted without marking the message', async () => {
    writeFileSync(join(dir, '.git/room-session.json'), JSON.stringify({ session_id: 'thread-2', at: Date.now(), cwd: dir }))
    const room = new RoomDoc()
    const s = session(room)
    let calls = 0
    const logs: string[] = []
    const b = new HooksBridge(s, { forMe: m => m.to === 'Rohan', isSeen: () => false, retryDelaysMs: [1, 1], log: l => logs.push(l), queue: async () => { calls++; throw new Error('down') } })
    b.start()
    const other = new RoomDoc(); other.doc.on('update', (u: Uint8Array) => Y.applyUpdate(room.doc, u))
    other.post({ name: 'Kieran', kind: 'agent' }, { type: 'question', to: 'Rohan', text: '?' } as never)
    await new Promise(r => setTimeout(r, 60))
    expect(calls).toBe(3)
    expect((b as unknown as { woken: Set<string> }).woken.size).toBe(0)
    expect(logs.some(l => l.includes('after 3 attempts'))).toBe(true)
    b.stop()
  })

  it('a stale or foreign session file is ignored; the wake stays pending until a fresh one appears', async () => {
    writeFileSync(join(dir, '.git/room-session.json'), JSON.stringify({ session_id: 'old-thread', at: Date.now() - 60 * 60 * 1000, cwd: dir }))
    const room = new RoomDoc()
    const s = session(room)
    const queued: string[] = []
    const b = new HooksBridge(s, { forMe: m => m.to === 'Rohan', isSeen: () => false, pendingPollMs: 10, retryDelaysMs: [], queue: async id => { queued.push(id) } })
    b.start()
    const other = new RoomDoc(); other.doc.on('update', (u: Uint8Array) => Y.applyUpdate(room.doc, u))
    other.post({ name: 'Kieran', kind: 'agent' }, { type: 'note', to: 'Rohan', text: 'stop!', priority: 'interrupt' } as never)
    await new Promise(r => setTimeout(r, 30))
    expect(queued).toEqual([])
    // a file for another clone is foreign too
    writeFileSync(join(dir, '.git/room-session.json'), JSON.stringify({ session_id: 'elsewhere', at: Date.now(), cwd: '/somewhere/else' }))
    await new Promise(r => setTimeout(r, 30))
    expect(queued).toEqual([])
    writeFileSync(join(dir, '.git/room-session.json'), JSON.stringify({ session_id: 'thread-3', at: Date.now(), cwd: dir }))
    await new Promise(r => setTimeout(r, 40))
    expect(queued).toEqual(['thread-3'])
    b.stop()
  })

  it('a Claude Code host is not queued through codex; the channel already delivered it', async () => {
    writeFileSync(join(dir, '.git/room-session.json'), JSON.stringify({ session_id: 'claude-1', at: Date.now(), cwd: dir, host: 'claude' }))
    const room = new RoomDoc()
    const s = session(room)
    const queued: string[] = []
    const logs: string[] = []
    const b = new HooksBridge(s, { forMe: m => m.to === 'Rohan', isSeen: () => false, log: l => logs.push(l), queue: async id => { queued.push(id) } })
    b.start()
    const other = new RoomDoc(); other.doc.on('update', (u: Uint8Array) => Y.applyUpdate(room.doc, u))
    other.post({ name: 'Kieran', kind: 'agent' }, { type: 'note', to: 'Rohan', text: 'stop!', priority: 'interrupt' } as never)
    await new Promise(r => setTimeout(r, 30))
    expect(queued).toEqual([])
    expect(logs.some(l => l.includes('claude host') && l.includes('via channel'))).toBe(true)
    expect((b as unknown as { woken: Set<string> }).woken.size).toBe(1)
    b.stop()
  })

  it('writes room-state.json and the PreToolUse hook injects unread messages and claims on edited files', async () => {
    const room = new RoomDoc()
    const s = session(room)
    const b = new HooksBridge(s, { forMe: m => m.to === 'Rohan', isSeen: () => false })
    const k = { name: 'Kieran', kind: 'agent' as const }
    room.post(k, { type: 'question', to: 'Rohan', text: 'touching app.py?' } as never)
    room.addClaim({ path: 'app.py', from: 1, to: 1, by: 'Kieran', byKind: 'agent', intent: 'bump x', plans: [{ kind: 'rename', symbol: 'x', detail: 'y' }] })
    b.write()
    expect(existsSync(join(dir, '.git/room-state.json'))).toBe(true)
    const out = await runHook('before-edit.mjs', { tool_name: 'apply_patch', cwd: dir, tool_input: { input: '*** Begin Patch\n*** Update File: app.py\n@@\n-x = 1\n+x = 2\n*** End Patch\n' } })
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string
    expect(ctx).toContain('[room inbox 1]')
    expect(ctx).toContain('touching app.py?')
    expect(ctx).toContain("Kieran's agent holds app.py:1-1 — bump x (plans: rename x → y)")
    // second edit: inbox already shown by the hook, claim still reported
    const out2 = await runHook('before-edit.mjs', { tool_name: 'Write', cwd: dir, tool_input: { file_path: join(dir, 'app.py') } })
    const ctx2 = JSON.parse(out2).hookSpecificOutput.additionalContext as string
    expect(ctx2).not.toContain('[room inbox')
    expect(ctx2).toContain("Kieran's agent holds")
    // unrelated file, nothing new: silent
    expect(await runHook('before-edit.mjs', { tool_name: 'Write', cwd: dir, tool_input: { file_path: join(dir, 'other.py') } })).toBe('')
    b.stop()
    expect(existsSync(join(dir, '.git/room-state.json'))).toBe(false)
  })
})
