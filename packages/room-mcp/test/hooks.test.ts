import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { execFileSync, execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { RoomDoc } from '@room/shared'
import { consumeHookDisclosure, consumeHookNotice, createWriteIntentReader, HooksBridge, hookHealthNote, syncHookSeen, writePendingHookContext } from '../src/hooks-bridge.js'
import type { Session } from '../src/session.js'
import { hasCompany } from '../src/company.js'
import { AGENT_INSTRUCTIONS } from '../src/prompt.js'
import type { Worker } from '@room/shared'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

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
  vi.stubEnv('ROOM_HOST', '')
  vi.stubEnv('ROOM_WORKER_HOST', '')
  rmSync(join(dir, '.git/room-hook-activity.json'), { force: true })
  rmSync(join(dir, '.git/room-hook-session-activity.json'), { force: true })
  rmSync(join(dir, '.git/room-session.json'), { force: true })
  rmSync(join(dir, '.git/room-state.json'), { force: true })
  rmSync(join(dir, '.git/room-hook-seen.json'), { force: true })
})

function runHook(script: string, input: object, args: string[] = [], nodeArgs: string[] = []): Promise<string> {
  return new Promise((res, rej) => {
    const p = execFile('node', [...nodeArgs, join(HOOKS, script), ...args], { cwd: HOOKS }, (err, out) => err ? rej(err) : res(out))
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
    expect(hasCompany(alone)).toMatchObject({ company: true, others: ['Kieran'] })
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
    expect(hasCompany(stale)).toEqual({ company: true, others: ['Kieran'] })
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
  const state = (extra = {}) => writeFileSync(join(dir, '.git/room-state.json'), JSON.stringify({ company: true, claims: [claim], ...extra }))

  it('records session-specific write intents with company, including new edit files', async () => {
    state()
    await runHook('session-start.mjs', { session_id: 'intent-lead', cwd: dir })
    const lead = createWriteIntentReader(dir)
    expect(lead('app.py')).toBeUndefined()
    await runHook('before-edit.mjs', { session_id: 'intent-lead', cwd: dir, tool_name: 'Bash', tool_input: { cmd: 'cat app.py' } })
    expect(lead('app.py')).toBe(false)
    await runHook('session-start.mjs', { session_id: 'intent-peer', cwd: dir })
    const peer = createWriteIntentReader(dir)
    await runHook('before-edit.mjs', { session_id: 'intent-peer', cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, 'new.py') } })
    expect(peer('new.py')).toBe(true)
    expect(lead('new.py')).toBe(false)
    await runHook('before-edit.mjs', { session_id: 'intent-lead', cwd: dir, tool_name: 'Bash', tool_input: { cmd: 'echo x > app.py' } })
    expect(lead('app.py')).toBe(true)
    expect(peer('app.py')).toBe(false)
  })

  it('bounds intents to 200 entries, expires at two minutes, and drops ten-minute history', async () => {
    const { recordWriteIntents } = await import(join(HOOKS, 'common.mjs'))
    let clock = 1_000_000
    await runHook('session-start.mjs', { session_id: 'intent-bounds', cwd: dir })
    const read = createWriteIntentReader(dir, () => clock)
    recordWriteIntents(join(dir, '.git'), 'intent-bounds', dir, Array.from({ length: 201 }, (_, i) => `f${i}`), clock)
    expect(read('f0')).toBe(false)
    expect(read('f200')).toBe(true)
    clock += 120_000
    expect(read('f200')).toBe(false)
    clock += 600_000
    recordWriteIntents(join(dir, '.git'), 'intent-bounds', dir, ['fresh'], clock)
    expect(read('fresh')).toBe(true)
    expect(read('f200')).toBe(false)
  })

  it('shows directory claims for descendant writes only', async () => {
    state({ claims: [{ ...claim, path: 'api/' }] })
    expect(await runHook('before-edit.mjs', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: 'api/tax.py' } })).toContain("holds api/")
    expect(await runHook('before-edit.mjs', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: 'api-other/tax.py' } })).toBe('')
  })

  it('announces unchanged conflicting claim evidence once', async () => {
    state({ company: true, others: ['Kieran'] })
    const input = { cwd: dir, tool_name: 'Edit', tool_input: { file_path: 'api/tax.py' } }
    expect(await runHook('before-edit.mjs', input)).toContain("Kieran's agent holds api/tax.py:1-1")
    expect(await runHook('before-edit.mjs', input)).toBe('')
  })

  it.each(shellNames)('%s matches Codex hooks and announces company only once', async tool_name => {
    const manifest = JSON.parse(readFileSync(join(HOOKS, '../hooks.json'), 'utf8'))
    expect(new RegExp(manifest.hooks.PreToolUse[0].matcher).test(tool_name)).toBe(true)
    state({ company: true, others: ['Kieran'] })
    const input = { tool_name, cwd: dir, tool_input: { command: 'git status' } }
    expect(JSON.parse(await runHook('before-edit.mjs', input)).hookSpecificOutput.additionalContext).toContain('[room] Kieran is here.')
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
    writeFileSync(join(dir, '.git/room-hook-seen.json'), JSON.stringify({ seen: [], companyTold: true }))
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
    expect(out.hookSpecificOutput.additionalContext).toContain('[room] Kieran is here.')
    expect(out.hookSpecificOutput.additionalContext).not.toContain('[room claims')
  })
})

describe('hooks bridge + plugin hook scripts', () => {
  it('never imports another participant\'s hook receipts, including broadcast ids', () => {
    const s = session(new RoomDoc())
    const other = s.room.post({ name: 'Kieran', kind: 'agent' }, { type: 'question', to: 'Other', text: 'private' })
    const mine = s.room.post({ name: 'Kieran', kind: 'agent' }, { type: 'question', to: s.me.name, text: 'mine' })
    const broadcast = s.room.post({ name: 'Kieran', kind: 'agent' }, { type: 'note', text: 'broadcast', priority: 'notify' })
    const file = join(dir, '.git/room-hook-seen.json')
    writeFileSync(file, JSON.stringify({ seen: [other.id, mine.id, broadcast.id], shown: { [broadcast.id]: 'Other' } }))
    syncHookSeen(s)
    expect(s.room.seen(s.me.name).has(other.id)).toBe(false)
    expect(s.room.seen(s.me.name).has(broadcast.id)).toBe(false)
    expect(s.room.seen(s.me.name).has(mine.id)).toBe(true)
    writeFileSync(file, JSON.stringify({ seen: [broadcast.id], shown: { [broadcast.id]: s.me.name } }))
    syncHookSeen(s)
    expect(s.room.seen(s.me.name).has(broadcast.id)).toBe(true)
    s.awareness.destroy()
  })

  it('imports hook receipts into the document before any later wake', async () => {
    await runHook('session-start.mjs', { session_id: 'receipt-thread', cwd: dir })
    const s = session(new RoomDoc()), queue = vi.fn(async () => {})
    const b = new HooksBridge(s, { forMe: m => m.to === s.me.name, isSeen: () => false, queue })
    addPresence(s, 'Kieran')
    const msg = s.room.post({ name: 'Kieran', kind: 'agent' }, { type: 'question', to: s.me.name, text: 'hook first?' })
    b.write()
    const out = await runHook('before-edit.mjs', { cwd: dir, tool_name: 'Bash', tool_input: { cmd: 'git status' } })
    expect(out).toContain('hook first?')
    syncHookSeen(s)
    expect(s.room.seen(s.me.name).has(msg.id)).toBe(true)
    await b.maybeWake(msg)
    expect(queue).not.toHaveBeenCalled()
    b.write()
    expect(JSON.parse(readFileSync(b.stateFile(), 'utf8')).unread).toEqual([])
    b.stop(); s.awareness.destroy()
  })

  it('successful wake marks document receipts and prevents hook replay; failure stays unread', async () => {
    await runHook('session-start.mjs', { session_id: 'queue-first', cwd: dir })
    const s = session(new RoomDoc())
    let fail = false
    const b = new HooksBridge(s, { forMe: () => true, isSeen: () => false, retryDelaysMs: [], queue: async () => { if (fail) throw Error('down') } })
    const msg = s.room.post({ name: 'Kieran', kind: 'agent' }, { type: 'question', to: s.me.name, text: 'queue first?' })
    b.write()
    await b.maybeWake(msg)
    expect(s.room.seen(s.me.name).has(msg.id)).toBe(true)
    expect(await runHook('before-edit.mjs', { cwd: dir, tool_name: 'Bash', tool_input: { cmd: 'git status' } })).toBe('')
    fail = true
    const pending = s.room.post({ name: 'Kieran', kind: 'agent' }, { type: 'question', to: s.me.name, text: 'retry later?' })
    await b.maybeWake(pending)
    expect(s.room.seen(s.me.name).has(pending.id)).toBe(false)
    b.write()
    expect(JSON.parse(readFileSync(b.stateFile(), 'utf8')).unread.map((m: { id: string }) => m.id)).toEqual([pending.id])
    b.stop(); s.awareness.destroy()
  })

  it('document receipts remove stale hook snapshots synchronously', () => {
    const s = session(new RoomDoc())
    const b = new HooksBridge(s, { forMe: () => true, isSeen: () => false })
    const msg = s.room.post({ name: 'Kieran', kind: 'agent' }, { type: 'note', to: s.me.name, text: 'channel first', priority: 'fyi' })
    b.start(); b.write()
    expect(JSON.parse(readFileSync(b.stateFile(), 'utf8')).unread).toHaveLength(1)
    s.room.markSeen(s.me.name, [msg.id])
    expect(JSON.parse(readFileSync(b.stateFile(), 'utf8')).unread).toEqual([])
    b.stop(); s.awareness.destroy()
  })

  it('SessionStart is silent without company and prints one line with company', async () => {
    expect(await runHook('session-start.mjs', { session_id: 'quiet', cwd: dir })).toBe('')
    writeFileSync(join(dir, '.git/room-state.json'), JSON.stringify({ company: false, others: [] }))
    expect(await runHook('session-start.mjs', { session_id: 'alone', cwd: dir })).toBe('')
    writeFileSync(join(dir, '.git/room-state.json'), JSON.stringify({ room: 'r', sessionId: 'shared', at: Date.now(), company: true, others: ['Kieran'] }))
    const out = JSON.parse(await runHook('session-start.mjs', { session_id: 'shared', cwd: dir }))
    expect(out.hookSpecificOutput.additionalContext).toBe("[room] Kieran is here.")
  })

  it('SessionStart ignores stale or foreign company snapshots', async () => {
    const state = join(dir, '.git/room-state.json')
    writeFileSync(state, JSON.stringify({ room: 'r', sessionId: 'old-session', at: Date.now() - 24 * 60 * 60_000, company: true, others: ['Kieran'] }))
    expect(await runHook('session-start.mjs', { session_id: 'new-session', cwd: dir })).toBe('')
    writeFileSync(state, JSON.stringify({ room: 'r', sessionId: 'other-session', at: Date.now(), company: true, others: ['Kieran'] }))
    expect(await runHook('session-start.mjs', { session_id: 'new-session', cwd: dir })).toBe('')
  })

  it.each(['session-start.mjs', 'before-edit.mjs'])('%s delivers a pending solo notice once', async script => {
    const sessionId = `solo-${script}`
    writeFileSync(join(dir, '.git/room-state.json'), JSON.stringify({
      room: 'repo/main', sessionId, at: Date.now(), company: false, others: [], unread: [], claims: [], near: [],
      pendingDisclosure: 'note for your human: this clone now shares only your plans, no file text',
    }))
    const input = script === 'session-start.mjs'
      ? { session_id: sessionId, cwd: dir }
      : { session_id: sessionId, cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, 'app.py') } }
    const first = JSON.parse(await runHook(script, input)).hookSpecificOutput.additionalContext
    expect(first).toContain('note for your human: this clone now shares only your plans, no file text')
    expect(await runHook(script, input)).toBe('')
  })

  it('delivers an automatic connection failure through hooks without a room tool', async () => {
    await runHook('session-start.mjs', { session_id: 'failed-startup', cwd: dir })
    const notice = 'Room is not connected: not logged in; use room_login.'
    writePendingHookContext(dir, 'pendingNotice', notice)
    const input = { session_id: 'failed-startup', cwd: dir, tool_name: 'Read' }
    expect(await runHook('before-edit.mjs', input)).toContain(notice)
    expect(consumeHookNotice(dir, notice)).toBe('hook')
    expect(await runHook('before-edit.mjs', input)).toBe('')
  })

  it('arbitrates pending sharing disclosure once across hook and tool paths', async () => {
    const s = session(new RoomDoc())
    await runHook('session-start.mjs', { session_id: 'disclosure-race', cwd: dir })
    const input = { session_id: 'disclosure-race', cwd: dir, tool_name: 'Read' }
    const toolFirst = 'note for your human: tool first'
    writePendingHookContext(dir, 'pendingDisclosure', toolFirst, s.roomName)
    expect(consumeHookDisclosure(s, toolFirst)).toBe('tool')
    expect(await runHook('before-edit.mjs', input)).toBe('')

    const hookFirst = 'note for your human: hook first'
    writePendingHookContext(dir, 'pendingDisclosure', hookFirst, s.roomName)
    expect(await runHook('before-edit.mjs', input)).toContain(hookFirst)
    expect(consumeHookDisclosure(s, hookFirst)).toBe('hook')
    s.awareness.destroy(); s.room.doc.destroy()
  })

  it('SessionStart resets company delivery for a new session without forgetting seen inbox ids', async () => {
    const seenFile = join(dir, '.git/room-hook-seen.json')
    writeFileSync(seenFile, JSON.stringify({ seen: ['old'], companyTold: true }))
    writeFileSync(join(dir, '.git/room-state.json'), JSON.stringify({
      room: 'r', sessionId: 'new-session', at: Date.now(), company: true, others: ['Kieran'],
      unread: [{ id: 'old', priority: 'notify', line: 'old message' }], claims: [],
    }))
    await runHook('session-start.mjs', { session_id: 'new-session', cwd: dir })
    expect(JSON.parse(readFileSync(seenFile, 'utf8'))).toEqual({ seen: ['old'], companyTold: true })
    const input = { tool_name: 'Write', cwd: dir, tool_input: { file_path: join(dir, 'app.py') } }
    expect(await runHook('before-edit.mjs', input)).toBe('')
    expect(JSON.parse(readFileSync(seenFile, 'utf8'))).toEqual({ seen: ['old'], companyTold: true })
    expect(await runHook('before-edit.mjs', input)).toBe('')
  })

  it('PreToolUse announces company once even after company leaves and returns', async () => {
    const state = join(dir, '.git/room-state.json')
    writeFileSync(state, JSON.stringify({ company: true, others: ['Kieran'], unread: [], claims: [] }))
    const input = { tool_name: 'Write', cwd: dir, tool_input: { file_path: join(dir, 'app.py') } }
    expect(JSON.parse(await runHook('before-edit.mjs', input)).hookSpecificOutput.additionalContext).toContain('[room] Kieran is here.')
    expect(await runHook('before-edit.mjs', input)).toBe('')
    writeFileSync(state, JSON.stringify({ company: true, others: [], unread: [], claims: [] }))
    expect(await runHook('before-edit.mjs', input)).toBe('')
    writeFileSync(state, JSON.stringify({ company: true, others: ['Kieran'], unread: [], claims: [] }))
    expect(await runHook('before-edit.mjs', input)).toBe('')
  })

  it.each([
    { others: ['Kieran', 'Rohan+tests'], text: 'Kieran, Rohan+tests are here.' },
    { others: [], text: 'Someone is here.' },
    { others: undefined, text: 'Someone is here.' },
  ])('PreToolUse describes current company: $text', async ({ others, text }) => {
    writeFileSync(join(dir, '.git/room-state.json'), JSON.stringify({ company: true, others, unread: [], claims: [] }))
    const out = JSON.parse(await runHook('before-edit.mjs', { tool_name: 'Write', cwd: dir, tool_input: { file_path: join(dir, 'app.py') } }))
    expect(out.hookSpecificOutput.additionalContext).toContain(`[room] ${text}`)
  })

  it('reads the old array-form seen file and migrates it on the next delivery', async () => {
    writeFileSync(join(dir, '.git/room-hook-seen.json'), JSON.stringify(['old']))
    writeFileSync(join(dir, '.git/room-state.json'), JSON.stringify({ company: true, others: [], unread: [
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
    const b = new HooksBridge(s, { forMe: m => m.to === 'Rohan' || m.type === 'conflict' || m.type === 'base', isSeen: () => false, queue: async (id, text) => { queued.push(`${id}: ${text}`) } })
    b.start()
    const peer = addPresence(s, 'Kieran')
    addPresence(s, 'Kieran')
    addPresence(s, 'Kieran')
    const k = { name: 'Kieran', kind: 'agent' as const }
    // remote inserts: apply from another doc so transaction.local is false
    const other = new RoomDoc(); other.doc.on('update', (u: Uint8Array) => Y.applyUpdate(room.doc, u))
    other.post(k, { type: 'note', text: 'fyi only' } as never) // broadcast; an addressed note wakes (nested-lead test 1)
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
    expect(queued[2]).toContain("handle Git's actual result")
    expect(queued[2]).not.toContain('offer to commit and push')
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
    expect(JSON.parse(readFileSync(join(dir, '.git/room-state.json'), 'utf8'))).toMatchObject({ company: true, others: ['Kieran'] })
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
    addPresence(s, 'Kieran')
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
    // second edit: unchanged inbox and ownership evidence stay quiet
    const out2 = await runHook('before-edit.mjs', { tool_name: 'Write', cwd: dir, tool_input: { file_path: join(dir, 'app.py') } })
    expect(out2).toBe('')
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
    const fake = { room, dir, awareness: new Awareness(room.doc), me: { name: 'rohanz', kind: 'agent' } } as unknown as import('../src/session.js').Session
    const b = new HooksBridge(fake, { forMe: () => false, isSeen: () => false, writeState: false })
    b.start(); b.stop()
    expect(existsSync(join(dir, '.git', 'room-state.json'))).toBe(true)
  })
})

it.each([[' gpt-6-astra ', 'gpt-6-astra'], ['x'.repeat(100), 'x'.repeat(80)], [undefined, undefined], [42, undefined], ['', undefined], ['  ', undefined]])('SessionStart records only a nonempty string model (%s)', async (model, expected) => {
  await runHook('session-start.mjs', { session_id: 'model-session', cwd: dir, model })
  const hint = JSON.parse(readFileSync(join(dir, '.git/room-session.json'), 'utf8'))
  expect(hint.model).toBe(expected)
  expect(Object.hasOwn(hint, 'model')).toBe(expected !== undefined)
})


it.each([['codex', []], ['claude', ['--host', 'claude']]])('SessionStart chooses %s from the hook definition despite shared stdin fields', async (host, args) => {
  await runHook('session-start.mjs', { session_id: 'shared-fields', cwd: dir, hook_event_name: 'SessionStart', transcript_path: '/tmp/transcript.jsonl' }, args as string[])
  const state = JSON.parse(readFileSync(join(dir, '.git/room-session.json'), 'utf8'))
  expect(state.host).toBe(host)
  expect(state.transcript_path).toBe(host === 'claude' ? '/tmp/transcript.jsonl' : undefined)
})

it.each([['codex', 'claude'], ['claude', 'codex']])('ROOM_HOST=%s overrides a stale %s session hint when waking', async (host, stale) => {
  vi.stubEnv('ROOM_HOST', host)
  writeFileSync(join(dir, '.git/room-session.json'), JSON.stringify({ session_id: 'correct-thread', at: Date.now(), cwd: dir, host: stale }))
  const spawner = vi.mocked(execFile)
  spawner.mockClear()
  if (host === 'codex') spawner.mockImplementationOnce(((_cmd: unknown, _args: unknown, _opts: unknown, callback: Function) => { callback(null, '', ''); return {} }) as typeof execFile)
  const room = new RoomDoc()
  const s = session(room)
  const logs: string[] = []
  const b = new HooksBridge(s, { forMe: () => true, isSeen: () => false, log: l => logs.push(l), retryDelaysMs: [] })
  try {
    const msg = room.post({ name: 'Kieran', kind: 'agent' }, { type: 'question', to: 'Rohan', text: 'wake up' })
    await b.maybeWake(msg)
    if (host === 'codex') expect(spawner).toHaveBeenCalledWith('codex', ['queue', '--thread', 'correct-thread', '--message', expect.any(String)], { timeout: 10_000 }, expect.any(Function))
    else {
      expect(spawner).not.toHaveBeenCalled()
      expect(logs.some(l => l.includes('via channel'))).toBe(true)
    }
  } finally { b.stop(); s.awareness.destroy(); room.doc.destroy() }
})

const modelLine = (model: unknown) => JSON.stringify({ type: 'assistant', message: { model } }) + '\n'
function transcriptSession(host = 'claude', model?: string) {
  writeFileSync(join(dir, '.git/room-state.json'), JSON.stringify({ company: true, others: [] }))
  writeFileSync(join(dir, '.git/room-hook-seen.json'), JSON.stringify({ seen: [], companyTold: true }))
  const file = join(dir, '.git/room-session.json')
  const hint = { session_id: 'claude-thread', host, at: 123, cwd: dir, extra: 'preserved', ...(model ? { model } : {}) }
  writeFileSync(file, JSON.stringify(hint))
  const transcript = join(dir, 'transcript.jsonl')
  return { file, hint, transcript, input: { cwd: dir, tool_name: 'Read', transcript_path: transcript } }
}

it.each([undefined, 'claude-old'])('refreshes missing or changed Claude model (%s) from the newest valid transcript line', async old => {
  const { file, hint, transcript, input } = transcriptSession('claude', old)
  writeFileSync(transcript, modelLine('claude-older') + modelLine('claude-new') + modelLine('<synthetic>') + modelLine(42) + '{partial')
  await runHook('before-edit.mjs', input)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...hint, model: 'claude-new' })
})

it('ignores synthetic models and never reads Claude models into Codex sessions', async () => {
  for (const [host, content] of [['claude', modelLine('<synthetic>')], ['codex', modelLine('claude-wrong')]]) {
    const { file, hint, transcript, input } = transcriptSession(host, 'keep-model')
    writeFileSync(transcript, content)
    await runHook('before-edit.mjs', input)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(hint)
  }
})

it('skips opening an unchanged transcript across hook processes and preserves the cache on inbox delivery', async () => {
  const { file, transcript, input } = transcriptSession()
  const marker = join(dir, 'transcript-opens')
  rmSync(marker, { force: true })
  const preload = join(dir, 'trace-transcript.mjs')
  writeFileSync(preload, "import fs from 'node:fs'; const open = fs.openSync; fs.openSync = function(p, ...args) { if (p === " + JSON.stringify(transcript) + ") fs.appendFileSync(" + JSON.stringify(marker) + ", 'open\\n'); return open.call(this, p, ...args) }")
  writeFileSync(transcript, modelLine('claude-first'))
  await runHook('before-edit.mjs', input, [], ['--import', preload])
  const seenFile = join(dir, '.git/room-hook-seen.json')
  const cached = JSON.parse(readFileSync(seenFile, 'utf8')).transcript
  writeFileSync(join(dir, '.git/room-state.json'), JSON.stringify({ company: true, others: ['Ada'], unread: [{ id: 'new', priority: 'notify', line: 'hello' }] }))
  await runHook('before-edit.mjs', input, [], ['--import', preload])
  expect(readFileSync(marker, 'utf8')).toBe('open\n')
  expect(JSON.parse(readFileSync(seenFile, 'utf8'))).toEqual({ seen: ['new'], companyTold: true, transcript: cached })
  writeFileSync(transcript, modelLine('claude-first') + modelLine('claude-second'))
  await runHook('before-edit.mjs', input, [], ['--import', preload])
  expect(readFileSync(marker, 'utf8')).toBe('open\nopen\n')
  expect(JSON.parse(readFileSync(file, 'utf8')).model).toBe('claude-second')
})

it('limits transcript model lookup to the last 64 KiB of a 5 MiB file', async () => {
  const { file, hint, transcript, input } = transcriptSession()
  const first = modelLine('claude-outside-tail')
  writeFileSync(transcript, first + ' '.repeat(5 * 1024 * 1024 - first.length))
  await runHook('before-edit.mjs', input)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(hint)
  writeFileSync(transcript, first + ' '.repeat(5 * 1024 * 1024) + '\n' + modelLine('claude-in-tail'))
  await runHook('before-edit.mjs', input)
  expect(JSON.parse(readFileSync(file, 'utf8')).model).toBe('claude-in-tail')
})

it.each(['lead', 'worker'])('resolves %s hook identity by session while cwd is in the other worktree', async who => {
  const workerRoot = join(dir, 'worker')
  const mainGit = join(dir, '.git')
  const workerGit = join(mainGit, 'worktrees', 'identity-worker')
  mkdirSync(workerRoot, { recursive: true })
  mkdirSync(workerGit, { recursive: true })
  writeFileSync(join(workerRoot, '.git'), `gitdir: ${workerGit}\n`)
  writeFileSync(join(workerGit, 'commondir'), '../..\n')
  try {
    for (const [name, git, cwd] of [['lead', mainGit, dir], ['worker', workerGit, workerRoot]]) {
      writeFileSync(join(git, 'room-session.json'), JSON.stringify({ session_id: name, cwd }))
      writeFileSync(join(git, 'room-state.json'), JSON.stringify({ company: true, others: [name + '-peer'], unread: [] }))
    }
    const target = who === 'lead' ? mainGit : workerGit
    const other = who === 'lead' ? workerGit : mainGit
    rmSync(join(mainGit, 'room-hook-activity.json'), { force: true })
    const out = JSON.parse(await runHook('before-edit.mjs', { session_id: who, cwd: who === 'lead' ? workerRoot : dir, tool_name: 'Read' })).hookSpecificOutput.additionalContext
    expect(out).toContain(who + '-peer')
    expect(JSON.parse(readFileSync(join(target, 'room-hook-activity.json'), 'utf8')).session_id).toBe(who)
    expect(existsSync(join(other, 'room-hook-activity.json'))).toBe(false)
    expect(existsSync(join(target, 'room-hook-seen.json'))).toBe(true)
    expect(existsSync(join(other, 'room-hook-seen.json'))).toBe(false)
  } finally {
    rmSync(workerRoot, { recursive: true, force: true })
    rmSync(workerGit, { recursive: true, force: true })
  }
})

it('records activity with company, throttles writes, and falls back for unknown sessions', async () => {
  writeFileSync(join(dir, '.git/room-state.json'), JSON.stringify({ company: true }))
  const file = join(dir, '.git/room-hook-activity.json')
  const input = { session_id: 'unknown-session', cwd: dir, tool_name: 'Read' }
  rmSync(file, { force: true })
  await runHook('before-edit.mjs', input)
  const first = readFileSync(file, 'utf8')
  expect(JSON.parse(first)).toMatchObject({ session_id: 'unknown-session', at: expect.any(Number) })
  await runHook('before-edit.mjs', { ...input, tool_name: 'Bash', tool_input: { command: 'npm test' } })
  expect(readFileSync(file, 'utf8')).toBe(first)
  writeFileSync(file, JSON.stringify({ session_id: input.session_id, at: Date.now() - 6000 }))
  await runHook('before-edit.mjs', input)
  expect(JSON.parse(readFileSync(file, 'utf8')).at).toBeGreaterThan(JSON.parse(first).at)
})

it('does no activity, intent or transcript work without state or company', async () => {
  const activity = join(dir, '.git/room-hook-activity.json')
  rmSync(activity, { force: true })
  const input = { cwd: dir, session_id: 'silent', tool_name: 'Write', tool_input: { file_path: 'app.py' }, transcript_path: '/nonexistent' }
  expect(await runHook('before-edit.mjs', input)).toBe('')
  expect(existsSync(activity)).toBe(false)
  writeFileSync(join(dir, '.git/room-state.json'), JSON.stringify({ company: false, unread: [], claims: [] }))
  expect(await runHook('before-edit.mjs', input)).toBe('')
  expect(existsSync(activity)).toBe(false)
})

it('tracks SessionStart and PreToolUse receipts separately', async () => {
  await runHook('session-start.mjs', { session_id: 'separate', cwd: dir })
  expect(JSON.parse(readFileSync(join(dir, '.git/room-hook-session-activity.json'), 'utf8'))).toMatchObject({ session_id: 'separate', event: 'SessionStart' })
  expect(existsSync(join(dir, '.git/room-hook-activity.json'))).toBe(false)
  writeFileSync(join(dir, '.git/room-state.json'), JSON.stringify({ sessionId: 'separate', company: true }))
  await runHook('before-edit.mjs', { session_id: 'separate', cwd: dir, tool_name: 'Read' })
  expect(JSON.parse(readFileSync(join(dir, '.git/room-hook-activity.json'), 'utf8'))).toMatchObject({ session_id: 'separate', event: 'PreToolUse' })
})

it('reports unverified pre-edit coverage on team join and first scope only', () => {
  vi.stubEnv('ROOM_HOST', 'codex')
  const s = session(new RoomDoc())
  const now = Date.now()
  expect(hookHealthNote(s, false, now, 'room_join')).toBe('')
  expect(hookHealthNote(s, true, now + 1, 'room_join')).toContain('approve them once in an interactive Codex session')
  expect(hookHealthNote(s, true, now + 2, 'room_join')).toBe('')
  expect(hookHealthNote(s, true, now + 3, 'room_scope')).toContain('approve them once in an interactive Codex session')
  expect(hookHealthNote(s, true, now + 4, 'room_scope')).toBe('')
  expect(hookHealthNote(s, true, now + 60_000, 'room_state')).toBe('')

  // Claude Code has no hook-trust step that can silently skip hooks, and its before-edit hook is silent while alone:
  // nothing is said up front, and the later diagnostic never asks the agent to judge from a silent hook.
  vi.stubEnv('ROOM_HOST', 'claude')
  const claude = session(new RoomDoc())
  expect(hookHealthNote(claude, true, now + 1, 'room_join')).toBe('')
  expect(hookHealthNote(claude, true, now + 2, 'room_scope')).toBe('')
  expect(hookHealthNote(claude, true, now + 3, 'room_state')).toBe('')
  const late = hookHealthNote(claude, true, now + 60_000, 'room_state')
  expect(late).toContain('has not seen its before-edit hook run')
  expect(late).not.toContain('if your next edit')
  expect(hookHealthNote(claude, true, now + 120_000, 'room_state')).toBe('')
  claude.awareness.destroy()
  vi.stubEnv('ROOM_HOST', 'codex')

  const sessionOnly = session(new RoomDoc())
  writeFileSync(join(dir, '.git/room-session.json'), JSON.stringify({ session_id: 'session-only' }))
  writeFileSync(join(dir, '.git/room-hook-activity.json'), JSON.stringify({ session_id: 'session-only', event: 'SessionStart', at: now + 1 }))
  expect(hookHealthNote(sessionOnly, true, now + 2, 'room_join')).toContain('Pre-edit coordination is not confirmed yet')

  const healthy = session(new RoomDoc())
  writeFileSync(join(dir, '.git/room-session.json'), JSON.stringify({ session_id: 'healthy' }))
  writeFileSync(join(dir, '.git/room-hook-activity.json'), JSON.stringify({ session_id: 'healthy', event: 'PreToolUse', at: now - 60_000 }))
  expect(hookHealthNote(healthy, true, now + 2, 'room_join')).toBe('')
  expect(hookHealthNote(healthy, true, now + 3, 'room_scope')).toBe('')
  s.awareness.destroy(); sessionOnly.awareness.destroy(); healthy.awareness.destroy()
})

it('uses the detected host in missing-hook guidance', () => {
  vi.stubEnv('ROOM_HOST', 'claude')
  const s = session(new RoomDoc())
  const now = Date.now()
  expect(hookHealthNote(s, true, now, 'room_join')).toBe('') // nothing up front: see the coverage test
  hookHealthNote(s, true, now + 1, 'room_state')
  const note = hookHealthNote(s, true, now + 60_000, 'room_state')
  expect(note).toContain("plugin's hooks may not be running")
  expect(note).toContain('reinstall or re-enable the plugin')
  expect(note).not.toContain('Codex')
  s.awareness.destroy()
})

it('tells agents to claim the files they will edit, not an overbroad directory', () => {
  expect(AGENT_INSTRUCTIONS()).toContain('claim the files you will edit')
  expect(AGENT_INSTRUCTIONS()).not.toContain('prefer one directory claim')
})

it('company includes who and their scope; nearby claims are needed only for overlapping writes', async () => {
  const s = session(new RoomDoc())
  const peer = addPresence(s, 'Ada')
  s.room.setScope({ by: 'Ada', byKind: 'agent', area: 'orders', summary: 'pricing', paths: ['api/'], at: Date.now() })
  s.room.setOverlay('Bea', 'other.py', 'changed')
  const b = new HooksBridge(s, { forMe: () => false, isSeen: () => false })
  writeFileSync(join(dir, '.git/room-session.json'), JSON.stringify({ session_id: 'near', at: Date.now(), cwd: dir }))
  b.write()
  const announce = await runHook('session-start.mjs', { cwd: dir, session_id: 'near' })
  expect(announce).toContain('Ada is here, on orders: api/')
  const edit = (file_path: string) => runHook('before-edit.mjs', { cwd: dir, session_id: 'near', tool_name: 'Write', tool_input: { file_path } })
  expect(await edit('api/tax.py')).toContain('Claim before editing: Ada has scope on api/')
  expect(await edit('other.py')).toContain('Bea has changed on other.py')
  expect(await edit('api-other/new.py')).toBe('')
  b.stop(); peer.destroy(); s.awareness.destroy()
})

it('announces unchanged near evidence once and stays silent with an adequate own claim', async () => {
  const s = session(new RoomDoc())
  const peer = addPresence(s, 'Ada')
  s.room.setScope({ by: 'Ada', byKind: 'agent', area: 'orders', summary: 'pricing', paths: ['api/'], at: Date.now() })
  const b = new HooksBridge(s, { forMe: () => false, isSeen: () => false })
  b.write()
  const input = { cwd: dir, session_id: 'near-once', tool_name: 'Write', tool_input: { file_path: 'api/tax.py' } }
  expect(await runHook('before-edit.mjs', input)).toContain('Claim before editing: Ada has scope on api/')
  expect(await runHook('before-edit.mjs', input)).toBe('')
  s.room.addClaim({ path: 'api/tax.py', from: 1, to: 1, by: s.me.name, byKind: 'agent', intent: 'tax rules' })
  b.write()
  expect(await runHook('before-edit.mjs', input)).toBe('')
  b.stop(); peer.destroy(); s.awareness.destroy()
})

it('publishes known unavailable Claude wake capability', () => {
  vi.stubEnv('ROOM_HOST', 'claude')
  vi.stubEnv('ROOM_CLAUDE_CHANNEL', '')
  vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', undefined)
  const s = session(new RoomDoc())
  const b = new HooksBridge(s, { forMe: () => false, isSeen: () => false })
  b.start()
  expect(s.awareness.getLocalState()).toMatchObject({ wakeUnavailable: true })
  b.stop(); s.awareness.destroy()
})

it('publishes socket wake capability and honors ROOM_WAKE=off', () => {
  vi.stubEnv('ROOM_HOST', 'claude')
  vi.stubEnv('ROOM_CLAUDE_CHANNEL', '')
  vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', '/tmp/claude-inbox.sock')
  const s = session(new RoomDoc())
  const b = new HooksBridge(s, { forMe: () => false, isSeen: () => false })
  b.start()
  expect(s.awareness.getLocalState()).toMatchObject({ wakeUnavailable: false })
  b.stop(); s.awareness.destroy()
  vi.stubEnv('ROOM_WAKE', 'off')
  const off = session(new RoomDoc())
  const offBridge = new HooksBridge(off, { forMe: () => false, isSeen: () => false })
  offBridge.start()
  expect(off.awareness.getLocalState()).toMatchObject({ wakeUnavailable: true })
  offBridge.stop(); off.awareness.destroy()
})

it('matches the shared overlap rule on exact files, directory boundaries and normalized paths', async () => {
  const shared = await import('@room/shared')
  // The shared export lands with the lean worker; run this check on the combined tree.
  const covers = (shared as unknown as { coversPath: (a: string, b: string) => boolean }).coversPath
  expect(covers).toBeTypeOf('function')
  const hook = await import(join(HOOKS, 'common.mjs'))
  for (const [a, b] of [
    ['api/tax.py', 'api/tax.py'], ['api/', 'api/tax.py'], ['api/tax.py', 'api/'],
    ['api', 'api-other/a'], ['./api/tax.py', 'api/'], ['api\\tax.py', 'api'],
    ['.', 'api/tax.py'], ['./', 'api/tax.py'], ['', 'api/tax.py'], ['api///', 'api/a'],
    ['src/a', 'src/b'], ['././src/a', 'src/a'], ['src/../api', 'api/a'],
  ]) expect(hook.coversPath(a, b), `${a} vs ${b}`).toBe(covers(a, b))
})
