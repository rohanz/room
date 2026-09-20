import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { execFileSync, execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { RoomDoc } from '@room/shared'
import { HooksBridge } from '../src/hooks-bridge.js'
import type { Session } from '../src/session.js'
import { hasCompany } from '../src/company.js'
import type { Worker } from '@room/shared'

const HOOKS = resolve(__dirname, '../../../plugins/room/hooks')
let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-hooks-'))
  execFileSync('git', ['-C', dir, 'init', '-q'])
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  mkdirSync(join(dir, 'api'))
  writeFileSync(join(dir, 'api/tax.py'), 'x = 1\n')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  rmSync(join(dir, '.git/room-state.json'), { force: true })
  rmSync(join(dir, '.git/room-hook-seen.json'), { force: true })
})

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

function addPresence(s: Session, name: string, kind: 'agent' | 'human' = 'agent', status = 'idle') {
  const peer = new Awareness(new Y.Doc())
  peer.setLocalState({ user: { name, kind, color: '#111' }, status, lastActive: Date.now() })
  applyAwarenessUpdate(s.awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
  return peer
}

describe('hasCompany', () => {
  it('distinguishes alone, another participant, and a browser viewer', () => {
    const alone = session(new RoomDoc())
    expect(hasCompany(alone)).toEqual({ company: false, others: [] })
    const agent = addPresence(alone, 'Kieran')
    expect(hasCompany(alone)).toMatchObject({ company: true, others: ["Kieran's agent"] })
    agent.destroy()

    const viewed = session(new RoomDoc())
    addPresence(viewed, 'Kieran', 'human', 'viewing')
    expect(hasCompany(viewed)).toEqual({ company: false, others: [] })

  })

  it('counts an old lastActive with a fresh awareness heartbeat', () => {
    const stale = session(new RoomDoc())
    const peer = new Awareness(new Y.Doc())
    peer.setLocalState({ user: { name: 'Kieran', kind: 'agent', color: '#111' }, status: 'idle', lastActive: Date.now() - 5 * 60_000 })
    applyAwarenessUpdate(stale.awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
    expect(hasCompany(stale)).toEqual({ company: true, others: ["Kieran's agent"] })
    peer.destroy()
    stale.awareness.destroy()
  })

  it('ignores a 31-second-old heartbeat even with fresh lastActive', () => {
    const s = session(new RoomDoc())
    const peer = addPresence(s, 'Kieran')
    const now = Date.now()
    s.awareness.meta.get(peer.clientID)!.lastUpdated = now - 31_000
    expect(hasCompany(s, [], now)).toEqual({ company: false, others: [] })
    peer.destroy()
    s.awareness.destroy()
  })

  it('counts a running worker', () => {
    const s = session(new RoomDoc())
    const worker = { name: 'Rohan+tests', status: 'running' } as Worker
    expect(hasCompany(s, [worker])).toMatchObject({ company: true, others: ['Rohan+tests'] })
  })

  it('does not count a foreign overlay alone', () => {
    const s = session(new RoomDoc())
    s.room.setOverlay('Kieran', 'app.py', 'x = 2\n')
    expect(hasCompany(s)).toEqual({ company: false, others: [] })
  })

  it('does not count a foreign deleted mark alone', () => {
    const s = session(new RoomDoc())
    s.room.markDeleted('Kieran', 'app.py')
    expect(hasCompany(s)).toEqual({ company: false, others: [] })
  })

  it('does not count a foreign open claim alone', () => {
    const s = session(new RoomDoc())
    s.room.addClaim({ path: 'app.py', from: 1, to: 1, by: 'Kieran', byKind: 'agent', intent: 'offline work' })
    expect(hasCompany(s)).toEqual({ company: false, others: [] })
  })
})

describe('shell edit hooks', () => {
  const shellNames = ['Bash', 'shell', 'local_shell', 'exec', 'exec_command', 'unified_exec']
  const claim = { by: 'Kieran', path: 'api/tax.py', from: 1, to: 1, intent: 'tax rules' }
  const state = (extra = {}) => writeFileSync(join(dir, '.git/room-state.json'), JSON.stringify({ claims: [claim], ...extra }))

  it.each(shellNames)('%s matches Codex hooks and announces company only once', async tool_name => {
    const manifest = JSON.parse(readFileSync(join(HOOKS, '../hooks.json'), 'utf8'))
    expect(new RegExp(manifest.hooks.PreToolUse[0].matcher).test(tool_name)).toBe(true)
    state({ company: true, others: ['Kieran'] })
    const input = { tool_name, cwd: dir, tool_input: { command: 'git status' } }
    expect(JSON.parse(await runHook('before-edit.mjs', input)).hookSpecificOutput.additionalContext).toContain('[room] Kieran is in this room')
    expect(await runHook('before-edit.mjs', input)).toBe('')
  })

  it('matches Bash in the Claude hook manifest', () => {
    const manifest = JSON.parse(readFileSync(join(HOOKS, 'claude.json'), 'utf8'))
    expect(new RegExp(manifest.hooks.PreToolUse[0].matcher).test('Bash')).toBe(true)
  })

  it.each([
    "sed -i '' 's/x/y/' api/tax.py", "perl -pi -e 's/x/y/' api/tax.py",
    'echo x >api/tax.py', 'echo x >>api/tax.py', 'tee api/tax.py',
    'mv api/tax.py old.py', 'cp app.py api/tax.py', 'rm api/tax.py',
    'python3 -c "pass" api/tax.py', 'node -e "0" api/tax.py',
    "python <<'PY'\nopen('api/tax.py', 'w')\nPY", "node <<'JS'\nwrite('api/tax.py')\nJS",
    'apply_patch api/tax.py', 'git apply api/tax.py', 'git checkout -- api/tax.py',
    'git restore api/tax.py', 'git stash -- api/tax.py', 'git merge api/tax.py', 'git rebase api/tax.py',
  ])('warns on likely shell write: %s', async cmd => {
    state()
    const out = JSON.parse(await runHook('before-edit.mjs', { tool_name: 'exec', cwd: dir, tool_input: { cmd } }))
    expect(out.hookSpecificOutput.additionalContext).toContain("Kieran's agent holds api/tax.py:1-1")
  })

  it.each(['cat', 'ls', 'grep x', 'git status', 'git diff', 'git log', 'pytest', 'npm test'])('does not warn on claims for %s', async command => {
    state()
    expect(await runHook('before-edit.mjs', { tool_name: 'Bash', cwd: dir, tool_input: { command: command + ' api/tax.py' } })).toBe('')
  })

  it('delivers unread inbox messages on read-only shell calls once', async () => {
    state({ unread: [{ id: 'shell-inbox', priority: 'notify', line: 'check the new tax rules' }] })
    const input = { tool_name: 'exec_command', cwd: dir, tool_input: { cmd: 'cat api/tax.py' } }
    const out = JSON.parse(await runHook('before-edit.mjs', input)).hookSpecificOutput.additionalContext
    expect(out).toContain('check the new tax rules')
    expect(out).not.toContain('[room claims')
    expect(await runHook('before-edit.mjs', input)).toBe('')
  })

  it('bounds path candidates across input strings and supports shell argv', async () => {
    const { pathsOf, shellLooksLikeWrite } = await import(join(HOOKS, 'common.mjs'))
    expect(pathsOf('exec', { cmd: 'sed -i "s/x/y/" "api/tax.py"' }, dir)).toContain('api/tax.py')
    expect(pathsOf('exec', { cmd: 'x '.repeat(200), extra: 'api/tax.py' }, dir)).toEqual([])
    expect(pathsOf('exec', { cmd: 'x'.repeat(20_001), extra: 'api/tax.py' }, dir)).toEqual(['api/tax.py'])
    expect(shellLooksLikeWrite({ command: ['python3', '-c', 'pass', 'api/tax.py'] })).toBe(true)
    expect(pathsOf('shell', { command: ['python3', '-c', 'pass', 'api/tax.py'] }, dir)).toEqual(['api/tax.py'])
    expect(pathsOf('exec', { cmd: 'rm ../outside.py /etc/hosts' }, dir)).toEqual([])
  })

  it('skips a 1 MB command within 100 ms and still delivers company', async () => {
    const { pathsOf, shellLooksLikeWrite } = await import(join(HOOKS, 'common.mjs'))
    const tool_input = { cmd: 'sed -i ' + 'x'.repeat(1_000_000) + ' api/tax.py' }
    const start = performance.now()
    expect(pathsOf('exec', tool_input, dir)).toEqual([])
    expect(shellLooksLikeWrite(tool_input)).toBe(false)
    expect(performance.now() - start).toBeLessThan(100)
    state({ company: true, others: ['Kieran'] })
    const out = JSON.parse(await runHook('before-edit.mjs', { tool_name: 'exec', cwd: dir, tool_input }))
    expect(out.hookSpecificOutput.additionalContext).toContain('[room] Kieran is in this room')
    expect(out.hookSpecificOutput.additionalContext).not.toContain('[room claims')
  })
})

describe('hooks bridge + plugin hook scripts', () => {
  it('SessionStart is silent without company and prints one line with company', async () => {
    expect(await runHook('session-start.mjs', { session_id: 'quiet', cwd: dir })).toBe('')
    writeFileSync(join(dir, '.git/room-state.json'), JSON.stringify({ company: false, others: [] }))
    expect(await runHook('session-start.mjs', { session_id: 'alone', cwd: dir })).toBe('')
    writeFileSync(join(dir, '.git/room-state.json'), JSON.stringify({ company: true, others: ["Kieran's agent"] }))
    const out = JSON.parse(await runHook('session-start.mjs', { session_id: 'shared', cwd: dir }))
    expect(out.hookSpecificOutput.additionalContext).toBe("Room: Kieran's agent in this room. Follow the room-etiquette skill.")
  })

  it('SessionStart resets company delivery for a new session without forgetting seen inbox ids', async () => {
    const seenFile = join(dir, '.git/room-hook-seen.json')
    writeFileSync(seenFile, JSON.stringify({ seen: ['old'], companyTold: true }))
    writeFileSync(join(dir, '.git/room-state.json'), JSON.stringify({
      company: true, others: ['Kieran'],
      unread: [{ id: 'old', priority: 'notify', line: 'old message' }], claims: [],
    }))
    await runHook('session-start.mjs', { session_id: 'new-session', cwd: dir })
    expect(JSON.parse(readFileSync(seenFile, 'utf8'))).toEqual({ seen: ['old'], companyTold: false })
    const input = { tool_name: 'Write', cwd: dir, tool_input: { file_path: join(dir, 'app.py') } }
    const out = JSON.parse(await runHook('before-edit.mjs', input)).hookSpecificOutput.additionalContext
    expect(out).toContain('[room] Kieran is in this room')
    expect(out).not.toContain('old message')
    expect(JSON.parse(readFileSync(seenFile, 'utf8'))).toEqual({ seen: ['old'], companyTold: true })
    expect(await runHook('before-edit.mjs', input)).toBe('')
  })

  it('PreToolUse announces company once, then again after company went false', async () => {
    const state = join(dir, '.git/room-state.json')
    writeFileSync(state, JSON.stringify({ company: true, others: ['Kieran'], unread: [], claims: [] }))
    const input = { tool_name: 'Write', cwd: dir, tool_input: { file_path: join(dir, 'app.py') } }
    expect(JSON.parse(await runHook('before-edit.mjs', input)).hookSpecificOutput.additionalContext).toContain('[room] Kieran is in this room')
    expect(await runHook('before-edit.mjs', input)).toBe('')
    writeFileSync(state, JSON.stringify({ company: false, others: [], unread: [], claims: [] }))
    expect(await runHook('before-edit.mjs', input)).toBe('')
    writeFileSync(state, JSON.stringify({ company: true, others: ['Kieran'], unread: [], claims: [] }))
    expect(JSON.parse(await runHook('before-edit.mjs', input)).hookSpecificOutput.additionalContext).toContain('[room] Kieran is in this room')
  })

  it.each([
    { others: ['Kieran', 'Rohan+tests'], text: 'Kieran, Rohan+tests are in this room' },
    { others: [], text: 'Someone is in this room' },
    { others: undefined, text: 'Someone is in this room' },
  ])('PreToolUse describes current company: $text', async ({ others, text }) => {
    writeFileSync(join(dir, '.git/room-state.json'), JSON.stringify({ company: true, others, unread: [], claims: [] }))
    const out = JSON.parse(await runHook('before-edit.mjs', { tool_name: 'Write', cwd: dir, tool_input: { file_path: join(dir, 'app.py') } }))
    expect(out.hookSpecificOutput.additionalContext).toContain(`[room] ${text}:`)
  })

  it('reads the old array-form seen file and migrates it on the next delivery', async () => {
    writeFileSync(join(dir, '.git/room-hook-seen.json'), JSON.stringify(['old']))
    writeFileSync(join(dir, '.git/room-state.json'), JSON.stringify({ company: false, others: [], unread: [
      { id: 'old', priority: 'notify', line: 'old message' },
      { id: 'new', priority: 'notify', line: 'new message' },
    ], claims: [] }))
    const out = JSON.parse(await runHook('before-edit.mjs', { tool_name: 'Write', cwd: dir, tool_input: { file_path: join(dir, 'app.py') } }))
    expect(out.hookSpecificOutput.additionalContext).toContain('new message')
    expect(out.hookSpecificOutput.additionalContext).not.toContain('old message')
    expect(JSON.parse(readFileSync(join(dir, '.git/room-hook-seen.json'), 'utf8')).seen).toEqual(['old', 'new'])
  })

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

  it('does not wake an idle session merely because another participant joins', async () => {
    writeFileSync(join(dir, '.git/room-session.json'), JSON.stringify({ session_id: 'idle-thread', at: Date.now(), cwd: dir }))
    const s = session(new RoomDoc())
    const queued: string[] = []
    const b = new HooksBridge(s, { forMe: () => false, isSeen: () => false, queue: async id => { queued.push(id) } })
    b.start()
    addPresence(s, 'Kieran')
    await new Promise(r => setTimeout(r, 200))
    expect(queued).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, '.git/room-state.json'), 'utf8'))).toMatchObject({ company: true, others: ["Kieran's agent"] })
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

describe('workers-room bridge', () => {
  it('a bridge with writeState:false never deletes the lead\'s state file on stop', async () => {
    const { HooksBridge } = await import('../src/hooks-bridge.js')
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'room-hooks-')); mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'room-state.json'), '{}')
    const { RoomDoc } = await import('@room/shared')
    const room = new RoomDoc()
    const fake = { room, dir, me: { name: 'rohanz', kind: 'agent' } } as unknown as import('../src/session.js').Session
    const b = new HooksBridge(fake, { forMe: () => false, isSeen: () => false, writeState: false })
    b.start(); b.stop()
    expect(existsSync(join(dir, '.git', 'room-state.json'))).toBe(true)
  })
})
