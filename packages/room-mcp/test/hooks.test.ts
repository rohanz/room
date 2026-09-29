import { deleteFixture, publishFixture } from './fixtures/manifest.js'
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { execFileSync, execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { RoomDoc, type NoteMsg, type QuestionMsg } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { createWriteIntentReader, HooksBridge, hookHealthNote, type HooksBridgeOptions } from '../src/hooks-bridge.js'
import { sessionDirectory, type Session } from '../src/session.js'
import { testPolicyStore } from './policy-fixture.js'
import { hasCompany } from '../src/company.js'
import { AGENT_INSTRUCTIONS } from '../src/prompt.js'
import { createTools, type Tools } from '../src/tools.js'
import { startArbitration, type Arbitration } from '../src/arbitration.js'
import type { SessionBinding } from '../src/binding.js'
import { Ledger } from '../src/ledger.js'
import { WakeReconciler } from '../src/wake-reconciler.js'
import type { SendWake } from '../src/wake-path.js'
import type { LocalWorker } from '../src/worker-status.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { registerWorkers } from './registry-fixture.js'
import { hubSeam } from './fixtures/hub.js'
import { visiblePeer } from './fixtures/visible.js'

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks() })

const HOOKS = resolve(__dirname, '../../../plugins/room/hooks')
const SID = 'hook-session'
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
  vi.stubEnv('ROOM_WORKER_ID', undefined)
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', undefined)
  vi.stubEnv('ROOM_WAKE', undefined)
  vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', undefined)
  vi.stubEnv('CLAUDE_CODE_MESSAGING_TOKEN', undefined)
  rmSync(join(dir, '.git/room'), { recursive: true, force: true })
})

/** room/sessions/<sid>/ in the clone's common git directory. */
const sdir = (id = SID) => sessionDirectory(join(dir, '.git'), id)
const readSession = (name: string, id = SID) => JSON.parse(readFileSync(join(sdir(id), name), 'utf8'))
function writeSessionFile(name: string, value: object, id = SID) {
  mkdirSync(sdir(id), { recursive: true })
  writeFileSync(join(sdir(id), name), JSON.stringify(value))
}

/** Runs a hook script; the event carries this test's session unless it names one. */
function runHook(script: string, input: object, args: string[] = [], nodeArgs: string[] = []): Promise<string> {
  return new Promise((res, rej) => {
    const p = execFile('node', [...nodeArgs, join(HOOKS, script), ...args], { cwd: HOOKS }, (err, out) => err ? rej(err) : res(out))
    p.stdin!.end(JSON.stringify({ session_id: SID, ...input }))
  })
}
const context = (out: string) => out ? JSON.parse(out).hookSpecificOutput.additionalContext as string : ''

function session(room: RoomDoc): Session {
  const awareness = new Awareness(room.doc)
  visiblePeer(room, 'Rohan', 'agent', SID)
  const setScope = room.setScope.bind(room), addClaim = room.addClaim.bind(room)
  room.setScope = (...args) => { visiblePeer(room, args[0].by, args[0].byKind ?? 'agent'); return setScope(...args) }
  room.addClaim = (...args) => { visiblePeer(room, args[0].by, args[0].byKind ?? 'agent'); return addClaim(...args) }
  return { room, awareness, me: { name: 'Rohan', kind: 'agent' }, dir, roomUrl: 'ws://x/r', roomName: 'r', browserUrl: '', shareMax: 'full', shareRequested: 'full', ...hubSeam(room), policyStore: testPolicyStore(), provider: { synced: true } as never, daemon: { touch() {}, async stop() {} } as never }
}

function addPresence(s: Session, name: string, kind: 'agent' | 'human' = 'agent', status = 'idle') {
  const sessionId = visiblePeer(s.room, name, kind)
  const peer = new Awareness(new Y.Doc())
  peer.setLocalState({ user: { name, kind, color: '#111' }, sessionId, status, lastActive: Date.now() })
  applyAwarenessUpdate(s.awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
  return peer
}

/** A bridge bound to this test's session directory. */
function bridge(s: Session, o: Partial<HooksBridgeOptions> = {}, id = SID) {
  return new HooksBridge(s, { owedCount: () => 0, fenced: () => true, sessionDir: () => sdir(id), ...o })
}

/** Wakes for a bound Codex session, attached to `s`. */
function wakes(s: Session, send: SendWake = async () => 'queue', ownWorkers: ReadonlySet<string> = new Set()) {
  const ledger = new Ledger({ sessionId: () => SID, route: () => ({}) })
  const w = new WakeReconciler({ ledger, bound: () => ({ id: SID, host: 'codex' }), sessionDir: () => sdir(), send, ownWorkers: () => ownWorkers, windowMs: 0 })
  ledger.bind(s); w.attach(s)
  return w
}

/** A bound session with a live Room MCP: tools, ledger and the hooks' arbitration endpoint. */
async function liveMcp(id = SID, me = { name: 'Rohan', kind: 'agent' as const }, room = new RoomDoc(), hookLeaseMs = 10_000) {
  const s = { ...session(room), me }
  const binding: SessionBinding = { bound: () => ({ id, host: 'codex' }), id: () => id, dir: () => sdir(id), commonDir: () => join(dir, '.git') }
  const tools: Tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir, binding, hookLeaseMs })
  tools.attachHooks(s)
  const arbitration: Arbitration = await startArbitration({ binding, ledger: tools.ledger, select: () => tools.hookSelect(), hookLeaseMs })
  return { s, tools, arbitration, async close() { await arbitration.close(); await tools.shutdown(); s.awareness.destroy() } }
}
/** Let the bridge's debounced state.json write land. */
const settle = () => new Promise(r => setTimeout(r, 250))
/** A preload that kills the hook before its stdout write (`before`) or before its confirm (`after`). */
function dies(when: 'before' | 'after') {
  const file = join(dir, `die-${when}.mjs`)
  writeFileSync(file, when === 'before'
    ? 'process.stdout.write = () => { process.exit(0) }'
    : 'const write = process.stdout.write.bind(process.stdout); process.stdout.write = (chunk) => { write(chunk); process.exit(0) }')
  return ['--import', file]
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
    visiblePeer(stale.room, 'Kieran')
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
    const worker = { name: 'Rohan+tests', status: 'running' } as LocalWorker
    visiblePeer(s.room, worker.name)
    expect(hasCompany(s, [worker])).toMatchObject({ company: true, others: ['Rohan+tests'] })
  })

  it('does not count a foreign overlay alone', () => {
    const s = session(new RoomDoc())
    publishFixture(s.room, 'Kieran', 'app.py', 'x = 2\n')
    expect(hasCompany(s)).toEqual({ company: false, others: [] })
  })

  it('does not count a foreign deleted mark alone', () => {
    const s = session(new RoomDoc())
    deleteFixture(s.room, 'Kieran', 'app.py')
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
  const state = (extra = {}, id = SID) => writeSessionFile('state.json', { at: Date.now(), company: true, claims: [claim], ...extra }, id)
  const intents = (id: string, now?: () => number) => createWriteIntentReader(dir, () => sdir(id), now)

  it('records session-specific write intents with company, including new edit files', async () => {
    state({}, 'intent-lead'); state({}, 'intent-peer')
    const lead = intents('intent-lead')
    expect(lead('app.py')).toBeUndefined()
    await runHook('before-edit.mjs', { session_id: 'intent-lead', cwd: dir, tool_name: 'Bash', tool_input: { cmd: 'cat app.py' } })
    await runHook('before-edit.mjs', { session_id: 'intent-lead', cwd: dir, tool_name: 'Bash', tool_input: { cmd: 'echo x > api/tax.py' } })
    expect(lead('app.py')).toBe(false)
    const peer = intents('intent-peer')
    await runHook('before-edit.mjs', { session_id: 'intent-peer', cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, 'new.py') } })
    expect(peer('new.py')).toBe(true)
    expect(lead('new.py')).toBe(false)
    await runHook('before-edit.mjs', { session_id: 'intent-lead', cwd: dir, tool_name: 'Bash', tool_input: { cmd: 'echo x > app.py' } })
    expect(lead('app.py')).toBe(true)
    expect(peer('app.py')).toBe(false)
  })

  it('records PowerShell write targets but not read-only commands', async () => {
    state()
    const read = intents(SID)
    await runHook('before-edit.mjs', { cwd: dir, tool_name: 'PowerShell', tool_input: { command: 'Set-Content -LiteralPath app.py -Value "x = 3"' } })
    await runHook('before-edit.mjs', { cwd: dir, tool_name: 'PowerShell', tool_input: { command: 'Get-Content -LiteralPath api/tax.py', description: 'Read tax rules' } })
    expect(read('api/tax.py')).toBe(false)
    await runHook('before-edit.mjs', { cwd: dir, tool_name: 'PowerShell', tool_input: { command: 'sEt-CoNtEnT -LiteralPath api\\tax.py -Value "x = 2"', description: 'Edit tax rules' } })
    expect(read('api/tax.py')).toBe(true)
  })

  it('finds PowerShell write destinations, including aliases and parameter paths', async () => {
    const { pathsOf, shellLooksLikeWrite } = await import(join(HOOKS, 'common.mjs'))
    const commands = [
      'Add-Content -Path api/tax.py -Value x', 'Out-File -FilePath api/tax.py',
      'New-Item -Path api/tax.py', 'Remove-Item -LiteralPath api/tax.py',
      'Move-Item -Path app.py -Destination api/tax.py',
      'Copy-Item -Path app.py -Destination api/tax.py',
      'Rename-Item -Path app.py -NewName api/tax.py',
      'sc api/tax.py x', 'ac api/tax.py x', 'ni api/tax.py',
      'ri api/tax.py', 'del api/tax.py', 'mv app.py api/tax.py',
      'CP app.py api/tax.py', 'ReN app.py api/tax.py',
    ]
    for (const command of commands) {
      expect(shellLooksLikeWrite({ command }), command).toBe(true)
      expect(pathsOf('PowerShell', { command }, dir), command).toContain('api/tax.py')
    }
    for (const command of ['Get-Content api/tax.py', 'Select-String sc api/tax.py', 'Get-ChildItem api']) {
      expect(shellLooksLikeWrite({ command }), command).toBe(false)
    }
    expect(pathsOf('PowerShell', { command: 'Set-Content -Path C:\\repo\\api\\tax.py -Value x' }, 'C:\\repo')).toEqual(['api/tax.py'])
    expect(pathsOf('PowerShell', { command: 'Copy-Item -Path app.py -Destination "api/new tax.py"' }, dir)).toContain('api/new tax.py')
  })

  it('bounds intents to 200 entries, expires at two minutes, and drops ten-minute history', async () => {
    const { recordWriteIntents } = await import(join(HOOKS, 'common.mjs'))
    let clock = 1_000_000
    const read = intents(SID, () => clock)
    recordWriteIntents(sdir(), dir, Array.from({ length: 201 }, (_, i) => `f${i}`), clock)
    expect(read('f0')).toBe(false)
    expect(read('f200')).toBe(true)
    clock += 120_000
    expect(read('f200')).toBe(false)
    clock += 600_000
    recordWriteIntents(sdir(), dir, ['fresh'], clock)
    expect(read('fresh')).toBe(true)
    expect(read('f200')).toBe(false)
  })

  it('shows directory claims for descendant writes only', async () => {
    state({ claims: [{ ...claim, path: 'api/' }] })
    expect(await runHook('before-edit.mjs', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: 'api/tax.py' } })).toContain("holds api/")
    writeSessionFile('hook.json', { companyTold: true })
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
    expect(context(await runHook('before-edit.mjs', input))).toContain('[room] Kieran is here.')
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
    expect(context(await runHook('before-edit.mjs', { tool_name: 'exec', cwd: dir, tool_input: { cmd } }))).toContain("Kieran's agent holds api/tax.py:1-1")
  })

  it.each(['cat', 'ls', 'grep x', 'git status', 'git diff', 'git log', 'pytest', 'npm test'])('does not warn on claims for %s', async command => {
    state()
    writeSessionFile('hook.json', { companyTold: true })
    expect(await runHook('before-edit.mjs', { tool_name: 'Bash', cwd: dir, tool_input: { command: command + ' api/tax.py' } })).toBe('')
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
    const out = context(await runHook('before-edit.mjs', { tool_name: 'exec', cwd: dir, tool_input }))
    expect(out).toContain('[room] Kieran is here.')
    expect(out).not.toContain('[room claims')
  })
})

describe('live arbitration through the MCP endpoint (ledger test 8)', () => {
  const quinn = { name: 'Quinn', kind: 'agent' as const }
  const edit = { tool_name: 'Write', tool_input: { file_path: 'app.py' }, get cwd() { return dir } }

  it('the hook prints what the MCP selected and confirms; the receipt says via hook', async () => {
    const mcp = await liveMcp()
    try {
      const peer = addPresence(mcp.s, 'Quinn')
      const m = hubAppend<QuestionMsg>(mcp.s.room, quinn, { type: 'question', to: 'Rohan', text: 'touching app.py?' })
      await settle()
      const out = context(await runHook('before-edit.mjs', edit))
      expect(out).toContain('[room inbox 1]')
      expect(out).toContain('touching app.py?')
      expect(mcp.s.room.seen('Rohan').get(m.id)).toMatchObject({ s: SID, via: 'hook' })
      expect(context(await runHook('before-edit.mjs', edit))).not.toContain('touching app.py?')
      expect(await mcp.tools.call('room_state', {})).not.toContain('[inbox')
      peer.destroy()
    } finally { await mcp.close() }
  })

  it('a hook that dies after printing and before its confirm: no receipt; M is offered again after the lease', async () => {
    const mcp = await liveMcp(SID, undefined, undefined, 200)
    try {
      const peer = addPresence(mcp.s, 'Quinn')
      const m = hubAppend<NoteMsg>(mcp.s.room, quinn, { type: 'note', to: 'Rohan', text: 'please rebase' })
      await settle()
      expect(context(await runHook('before-edit.mjs', edit, [], dies('after')))).toContain('please rebase')
      expect(mcp.s.room.seen('Rohan').has(m.id)).toBe(false)
      // Within the lease another path does not show it twice.
      expect(context(await runHook('before-edit.mjs', edit))).not.toContain('please rebase')
      await new Promise(r => setTimeout(r, 250))
      expect(context(await runHook('before-edit.mjs', edit))).toContain('please rebase')
      expect(mcp.s.room.seen('Rohan').get(m.id)).toMatchObject({ via: 'hook' })
      peer.destroy()
    } finally { await mcp.close() }
  })

  it('MCP unreachable: only the content-free pending line, and nothing is suppressed later', async () => {
    writeSessionFile('state.json', { at: Date.now(), company: true, owedCount: 2, claims: [] })
    writeSessionFile('hook.json', { companyTold: true })
    const out = context(await runHook('before-edit.mjs', edit))
    expect(out).toBe('[room] 2 messages pending; Room is reconnecting.')
    const mcp = await liveMcp()
    try {
      const peer = addPresence(mcp.s, 'Quinn')
      hubAppend<NoteMsg>(mcp.s.room, quinn, { type: 'note', to: 'Rohan', text: 'first' })
      hubAppend<NoteMsg>(mcp.s.room, quinn, { type: 'note', to: 'Rohan', text: 'second' })
      await settle()
      const later = context(await runHook('before-edit.mjs', edit))
      expect(later).toContain('first')
      expect(later).toContain('second')
      peer.destroy()
    } finally { await mcp.close() }
  })

  it('another session\'s hook gets nothing from this MCP', async () => {
    const mcp = await liveMcp()
    try {
      const peer = addPresence(mcp.s, 'Quinn')
      hubAppend<NoteMsg>(mcp.s.room, quinn, { type: 'note', to: 'Rohan', text: 'for this session only' })
      await settle()
      mkdirSync(sdir('other-session'), { recursive: true })
      writeFileSync(join(sdir('other-session'), 'mcp.json'), readFileSync(join(sdir(), 'mcp.json')))
      writeSessionFile('state.json', { at: Date.now(), company: true, owedCount: 1, claims: [] }, 'other-session')
      expect(context(await runHook('before-edit.mjs', { ...edit, session_id: 'other-session' }))).not.toContain('for this session only')
      peer.destroy()
    } finally { await mcp.close() }
  })
})

describe('local notices are items (ledger test 9)', () => {
  const read = { tool_name: 'Bash', tool_input: { command: 'git status' }, get cwd() { return dir } }

  it('the disclosure claimant dies before stdout: the notice is shown later, then never again', async () => {
    const mcp = await liveMcp(SID, undefined, undefined, 200)
    try {
      mcp.tools.ledger.notice('sharing', 'note for your human: this clone now shares only your plans')
      await settle()
      expect(await runHook('before-edit.mjs', read, [], dies('before'))).toBe('')
      await new Promise(r => setTimeout(r, 250))
      expect(context(await runHook('before-edit.mjs', read))).toContain('note for your human: this clone now shares only your plans')
      expect(await runHook('before-edit.mjs', read)).toBe('')
      expect(await mcp.tools.call('room_state', {})).not.toContain('note for your human')
    } finally { await mcp.close() }
  })

  it('two racing hooks: the notice is shown once', async () => {
    const mcp = await liveMcp()
    try {
      mcp.tools.ledger.notice('startup', 'Room is not connected: not logged in; use room_login.')
      await settle()
      const outs = await Promise.all([runHook('before-edit.mjs', read), runHook('before-edit.mjs', read)])
      expect(outs.filter(o => o.includes('Room is not connected'))).toHaveLength(1)
    } finally { await mcp.close() }
  })

  it('a tool reply and a hook: whichever selects first shows it, once', async () => {
    const mcp = await liveMcp()
    try {
      mcp.tools.ledger.notice('sharing', 'note for your human: tool first')
      expect(await mcp.tools.call('room_state', {})).toContain('note for your human: tool first')
      await settle()
      expect(await runHook('before-edit.mjs', read)).toBe('')
      mcp.tools.ledger.notice('sharing', 'note for your human: hook first')
      await settle()
      expect(context(await runHook('before-edit.mjs', read))).toContain('hook first')
      expect(await mcp.tools.call('room_state', {})).not.toContain('hook first')
      const receipts = readSession('notices.json')
      expect(Object.values(receipts).map(r => (r as { via: string }).via).sort()).toEqual(['hook', 'reply'])
    } finally { await mcp.close() }
  })
})

describe('hooks bridge state file', () => {
  it('writes counts and coordination, never message content, only while fenced', async () => {
    const room = new RoomDoc()
    const s = session(room)
    let fenced = true
    const b = bridge(s, { owedCount: () => 1, fenced: () => fenced })
    addPresence(s, 'Kieran')
    hubAppend(room, { name: 'Kieran', kind: 'agent' }, { type: 'question', to: 'Rohan', text: 'touching app.py?' } as never)
    room.addClaim({ path: 'app.py', from: 1, to: 1, by: 'Kieran', byKind: 'agent', intent: 'bump x', plans: [{ kind: 'rename', symbol: 'x', detail: 'y' }] })
    b.write()
    const text = readFileSync(join(sdir(), 'state.json'), 'utf8')
    expect(text).not.toContain('touching app.py?')
    expect(JSON.parse(text)).toMatchObject({ owedCount: 1, company: true, claims: [{ path: 'app.py', by: 'Kieran', plans: 'rename x → y' }] })
    const out = context(await runHook('before-edit.mjs', { tool_name: 'apply_patch', cwd: dir, tool_input: { input: '*** Begin Patch\n*** Update File: app.py\n@@\n-x = 1\n+x = 2\n*** End Patch\n' } }))
    expect(out).toContain("Kieran's agent holds app.py:1-1 — bump x (plans: rename x → y)")
    expect(out).toContain('[room] 1 message pending; Room is reconnecting.')
    rmSync(join(sdir(), 'state.json'))
    fenced = false
    b.write()
    expect(existsSync(join(sdir(), 'state.json'))).toBe(false)
    b.stop(); s.awareness.destroy()
  })

  it('carries the hub paused line to the hook', async () => {
    const s = session(new RoomDoc())
    const b = bridge(s, { paused: () => '[room] hub unreachable; coordination paused.' })
    addPresence(s, 'Kieran')
    b.write()
    expect(context(await runHook('before-edit.mjs', { cwd: dir, tool_name: 'Read' }))).toContain('[room] hub unreachable; coordination paused.')
    b.stop(); s.awareness.destroy()
  })

  it('does not wake an idle session merely because another participant joins', async () => {
    const s = session(new RoomDoc())
    const send = vi.fn(async () => 'queue' as const)
    const b = bridge(s)
    const w = wakes(s, send)
    b.start()
    addPresence(s, 'Kieran')
    await new Promise(r => setTimeout(r, 200))
    expect(send).not.toHaveBeenCalled()
    expect(readSession('state.json')).toMatchObject({ company: true, others: ["Kieran's agent"] })
    b.stop(); w.stop()
  })

  it('contains a scheduled hook-state write failure and logs it once', () => {
    const s = session(new RoomDoc())
    const log = vi.fn()
    const b = bridge(s, { log })
    vi.spyOn(b, 'write').mockImplementation(() => { throw new Error('ENOENT: repo disappeared') })
    vi.useFakeTimers()
    try {
      b.scheduleWrite()
      expect(() => vi.advanceTimersByTime(150)).not.toThrow()
      expect(log).toHaveBeenCalledTimes(1)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('ENOENT: repo disappeared'))
    } finally { b.stop(); s.awareness.destroy(); vi.useRealTimers() }
  })

  it('hook snapshot excludes own agent claims but retains same-name non-agent claims as nearby work', () => {
    const s = session(new RoomDoc())
    s.room.addClaim({ by: 'Rohan', byKind: 'agent', path: 'agent.py', from: 1, to: 1, intent: 'my edit' })
    s.room.addClaim({ by: 'Rohan', byKind: 'human', path: 'human.py', from: 1, to: 1, intent: 'human edit' })
    s.room.addClaim({ by: 'Rohan', byKind: undefined as never, path: 'legacy.py', from: 1, to: 1, intent: 'legacy edit' })
    const b = bridge(s)
    b.write()
    const snapshot = readSession('state.json')
    expect(snapshot.ownClaims).toEqual([{ path: 'agent.py', from: 1, to: 1 }])
    expect(snapshot.claims).toMatchObject([{ path: 'human.py', by: 'Rohan', intent: 'human edit' }, { path: 'legacy.py', by: 'Rohan', intent: 'legacy edit' }])
    expect(snapshot.near).toEqual([{ by: 'Rohan', path: 'human.py', reason: 'claim' }, { by: 'Rohan', path: 'legacy.py', reason: 'claim' }])
    b.stop(); s.awareness.destroy(); s.room.doc.destroy()
  })
})

describe('company and nearby work', () => {
  it('SessionStart is silent without company and prints one line with company', async () => {
    expect(await runHook('session-start.mjs', { session_id: 'quiet', cwd: dir })).toBe('')
    writeSessionFile('state.json', { at: Date.now(), company: false, others: [] }, 'alone')
    expect(await runHook('session-start.mjs', { session_id: 'alone', cwd: dir })).toBe('')
    writeSessionFile('state.json', { room: 'r', at: Date.now(), company: true, others: ['Kieran'] }, 'shared')
    expect(context(await runHook('session-start.mjs', { session_id: 'shared', cwd: dir }))).toBe('[room] Kieran is here.')
  })

  it('SessionStart ignores a stale company snapshot', async () => {
    writeSessionFile('state.json', { room: 'r', at: Date.now() - 24 * 60 * 60_000, company: true, others: ['Kieran'] }, 'new-session')
    expect(await runHook('session-start.mjs', { session_id: 'new-session', cwd: dir })).toBe('')
  })

  it('PreToolUse announces company once even after company leaves and returns; a new SessionStart says it again', async () => {
    const input = { tool_name: 'Write', cwd: dir, tool_input: { file_path: join(dir, 'app.py') } }
    writeSessionFile('state.json', { at: Date.now(), company: true, others: ['Kieran'], claims: [] })
    expect(context(await runHook('before-edit.mjs', input))).toContain('[room] Kieran is here.')
    expect(await runHook('before-edit.mjs', input)).toBe('')
    writeSessionFile('state.json', { at: Date.now(), company: true, others: [], claims: [] })
    expect(await runHook('before-edit.mjs', input)).toBe('')
    writeSessionFile('state.json', { at: Date.now(), company: false, others: [], claims: [] })
    await runHook('session-start.mjs', { cwd: dir })
    writeSessionFile('state.json', { at: Date.now(), company: true, others: ['Kieran'], claims: [] })
    expect(context(await runHook('before-edit.mjs', input))).toContain('[room] Kieran is here.')
  })

  it.each([
    { others: ['Kieran', 'Rohan+tests'], text: 'Kieran, Rohan+tests are here.' },
    { others: [], text: 'Someone is here.' },
    { others: undefined, text: 'Someone is here.' },
  ])('PreToolUse describes current company: $text', async ({ others, text }) => {
    writeSessionFile('state.json', { at: Date.now(), company: true, others, claims: [] })
    expect(context(await runHook('before-edit.mjs', { tool_name: 'Write', cwd: dir, tool_input: { file_path: join(dir, 'app.py') } }))).toContain(`[room] ${text}`)
  })

  it('company includes who and their scope; nearby claims are needed only for overlapping writes', async () => {
    const s = session(new RoomDoc())
    const peer = addPresence(s, 'Ada')
    const human = addPresence(s, 'Cy', 'human', 'idle')
    s.room.setScope({ by: 'Ada', byKind: 'agent', area: 'orders', summary: 'pricing', paths: ['api/'], at: Date.now() })
    publishFixture(s.room, 'Bea', 'other.py', 'changed')
    const b = bridge(s, {}, 'near')
    b.write()
    const snapshot = readSession('state.json', 'near')
    expect(snapshot.others).toEqual(["Ada's agent", 'Cy'])
    expect(snapshot.near).toEqual([{ by: 'Ada', path: 'api/', reason: 'scope' }, { by: 'Bea', path: 'other.py', reason: 'changed' }])
    const announce = await runHook('session-start.mjs', { cwd: dir, session_id: 'near' })
    expect(announce).toContain("Ada's agent is here, on orders: api/")
    expect(announce).toContain('Cy is here')
    const edit = (file_path: string) => runHook('before-edit.mjs', { cwd: dir, session_id: 'near', tool_name: 'Write', tool_input: { file_path } })
    expect(await edit('api/tax.py')).toContain('Claim before editing: Ada has scope on api/')
    expect(await edit('other.py')).toContain('Bea has changed on other.py')
    expect(await edit('api-other/new.py')).toBe('')
    b.stop(); peer.destroy(); human.destroy(); s.awareness.destroy()
  })

  it('announces unchanged near evidence once and stays silent with an adequate own claim', async () => {
    const s = session(new RoomDoc())
    const peer = addPresence(s, 'Ada')
    s.room.setScope({ by: 'Ada', byKind: 'agent', area: 'orders', summary: 'pricing', paths: ['api/'], at: Date.now() })
    const b = bridge(s, {}, 'near-once')
    b.write()
    const input = { cwd: dir, session_id: 'near-once', tool_name: 'Write', tool_input: { file_path: 'api/tax.py' } }
    expect(await runHook('before-edit.mjs', input)).toContain('Claim before editing: Ada has scope on api/')
    expect(await runHook('before-edit.mjs', input)).toBe('')
    s.room.addClaim({ path: 'api/tax.py', from: 1, to: 1, by: s.me.name, byKind: 'agent', intent: 'tax rules' })
    b.write()
    expect(await runHook('before-edit.mjs', input)).toBe('')
    b.stop(); peer.destroy(); s.awareness.destroy()
  })
})

describe('session records (registry §17, ledger SF3)', () => {
  it.each([[' gpt-6-astra ', 'gpt-6-astra'], ['x'.repeat(100), 'x'.repeat(80)], [undefined, undefined], [42, undefined], ['', undefined], ['  ', undefined]])('SessionStart records only a nonempty string model (%s)', async (model, expected) => {
    await runHook('session-start.mjs', { cwd: dir, model })
    const record = readSession('session.json')
    expect(record.model).toBe(expected)
    expect(Object.hasOwn(record, 'model')).toBe(expected !== undefined)
  })

  it.each([['codex', []], ['claude', ['--host', 'claude']]])('SessionStart records %s from the hook definition, with the ancestor chain the MCP binds by', async (host, args) => {
    await runHook('session-start.mjs', { cwd: dir, hook_event_name: 'SessionStart', source: 'startup', transcript_path: '/tmp/transcript.jsonl' }, args as string[])
    const record = readSession('session.json')
    expect(record).toMatchObject({ session_id: SID, host, cwd: dir, source: 'startup', at: expect.any(Number) })
    expect(record.transcript_path).toBe(host === 'claude' ? '/tmp/transcript.jsonl' : undefined)
    // The hook's own parent (this test runner's node) is the first link, identified like probeProcess does.
    expect(record.chain[0]).toMatchObject({ pid: process.pid, startTime: expect.stringMatching(/^(darwin|linux):/), executable: expect.any(String) })
    expect(existsSync(join(dir, '.git/room-session.json'))).toBe(false)
  })

  it('tags worker SessionStart metadata so a shared checkout can identify its owner', async () => {
    vi.stubEnv('ROOM_WORKER_ID', 'lead/worker#1')
    await runHook('session-start.mjs', { cwd: dir, model: 'actual' })
    expect(readSession('session.json')).toMatchObject({ worker_id: 'lead/worker#1', model: 'actual' })
  })

  it('resolves the session directory through the common git dir while cwd is in another worktree', async () => {
    const workerRoot = join(dir, 'worker'), workerGit = join(dir, '.git', 'worktrees', 'identity-worker')
    mkdirSync(workerRoot, { recursive: true }); mkdirSync(workerGit, { recursive: true })
    writeFileSync(join(workerRoot, '.git'), `gitdir: ${workerGit}\n`)
    writeFileSync(join(workerGit, 'commondir'), '../..\n')
    try {
      writeSessionFile('state.json', { at: Date.now(), company: true, others: ['lead-peer'] })
      expect(context(await runHook('before-edit.mjs', { cwd: workerRoot, tool_name: 'Read' }))).toContain('lead-peer')
      expect(readSession('hook-activity.json')).toMatchObject({ session_id: SID, event: 'PreToolUse' })
      expect(existsSync(join(workerGit, 'room'))).toBe(false)
    } finally { rmSync(workerRoot, { recursive: true, force: true }); rmSync(workerGit, { recursive: true, force: true }) }
  })

  it('records activity even while alone, and throttles writes', async () => {
    const input = { cwd: dir, tool_name: 'Read' }
    await runHook('before-edit.mjs', input)
    const first = readFileSync(join(sdir(), 'hook-activity.json'), 'utf8')
    expect(JSON.parse(first)).toMatchObject({ session_id: SID, event: 'PreToolUse', at: expect.any(Number) })
    await runHook('before-edit.mjs', { ...input, tool_name: 'Bash', tool_input: { command: 'npm test' } })
    expect(readFileSync(join(sdir(), 'hook-activity.json'), 'utf8')).toBe(first)
    writeSessionFile('hook-activity.json', { session_id: SID, event: 'PreToolUse', at: Date.now() - 6000 })
    await runHook('before-edit.mjs', input)
    expect(readSession('hook-activity.json').at).toBeGreaterThan(JSON.parse(first).at)
  })

  it('does no endpoint, intent or transcript work while alone with nothing owed', async () => {
    const input = { cwd: dir, tool_name: 'Write', tool_input: { file_path: 'app.py' }, transcript_path: '/nonexistent' }
    writeSessionFile('state.json', { at: Date.now(), company: false, owedCount: 0, claims: [] })
    writeSessionFile('mcp.json', { port: 1, key: 'unused' })
    expect(await runHook('before-edit.mjs', input)).toBe('')
    expect(existsSync(join(sdir(), 'write-intents.json'))).toBe(false)
  })
})

describe('runtime.json: model and effort, written only by before-edit (ledger SF3)', () => {
  const modelLine = (model: unknown) => JSON.stringify({ type: 'assistant', message: { model } }) + '\n'
  const transcript = () => join(dir, 'transcript.jsonl')
  const claudeSession = (model?: string) => writeSessionFile('session.json', { session_id: SID, host: 'claude', at: 123, cwd: dir, chain: [], hostPid: 1, ...(model ? { model } : {}) })
  const input = () => ({ cwd: dir, tool_name: 'Read', transcript_path: transcript() })

  it.each([undefined, 'claude-old'])('refreshes a missing or changed Claude model (%s) from the newest valid transcript line', async old => {
    claudeSession(old)
    writeSessionFile('runtime.json', { transcript: { path: transcript(), mtimeMs: 1, size: 1 }, at: 1 })
    writeFileSync(transcript(), modelLine('claude-older') + modelLine('claude-new') + modelLine('<synthetic>') + modelLine(42) + '{partial')
    await runHook('before-edit.mjs', input())
    expect(readSession('runtime.json').model).toBe('claude-new')
    expect(readSession('session.json').model).toBe(old)
  })

  it('ignores synthetic models and never reads Claude models into Codex sessions', async () => {
    for (const [host, content] of [['claude', modelLine('<synthetic>')], ['codex', modelLine('claude-wrong')]]) {
      writeSessionFile('session.json', { session_id: SID, host, at: 1, cwd: dir, chain: [], hostPid: 1, model: 'keep-model' })
      rmSync(join(sdir(), 'runtime.json'), { force: true })
      writeFileSync(transcript(), content)
      await runHook('before-edit.mjs', input())
      expect(existsSync(join(sdir(), 'runtime.json')) ? readSession('runtime.json').model : undefined).toBeUndefined()
    }
  })

  it('keeps the SessionStart model over the first lagging transcript read', async () => {
    await runHook('session-start.mjs', { cwd: dir, model: 'current-model', transcript_path: transcript() }, ['--host', 'claude'])
    writeFileSync(transcript(), modelLine('previous-model'))
    const edit = { cwd: dir, tool_name: 'Bash', tool_input: { command: 'cat app.py' }, transcript_path: transcript() }
    await runHook('before-edit.mjs', edit)
    expect(readSession('runtime.json').model).toBeUndefined()
    writeFileSync(transcript(), modelLine('previous-model') + modelLine('new-model'))
    await runHook('before-edit.mjs', edit)
    expect(readSession('runtime.json').model).toBe('new-model')
    expect(readSession('session.json').model).toBe('current-model')
  })

  it('skips opening an unchanged transcript across hook processes', async () => {
    claudeSession()
    const marker = join(dir, 'transcript-opens')
    rmSync(marker, { force: true })
    const preload = join(dir, 'trace-transcript.mjs')
    writeFileSync(preload, "import fs from 'node:fs'; const open = fs.openSync; fs.openSync = function(p, ...args) { if (p === " + JSON.stringify(transcript()) + ") fs.appendFileSync(" + JSON.stringify(marker) + ", 'open\\n'); return open.call(this, p, ...args) }")
    writeFileSync(transcript(), modelLine('claude-first'))
    await runHook('before-edit.mjs', input(), [], ['--import', preload])
    await runHook('before-edit.mjs', input(), [], ['--import', preload])
    expect(readFileSync(marker, 'utf8')).toBe('open\n')
    writeFileSync(transcript(), modelLine('claude-first') + modelLine('claude-second'))
    await runHook('before-edit.mjs', input(), [], ['--import', preload])
    expect(readFileSync(marker, 'utf8')).toBe('open\nopen\n')
    expect(readSession('runtime.json').model).toBe('claude-second')
  })

  it('limits transcript model lookup to the last 64 KiB of a 5 MiB file', async () => {
    claudeSession()
    const first = modelLine('claude-outside-tail')
    writeFileSync(transcript(), first + ' '.repeat(5 * 1024 * 1024 - first.length))
    await runHook('before-edit.mjs', input())
    expect(readSession('runtime.json').model).toBeUndefined()
    writeFileSync(transcript(), first + ' '.repeat(5 * 1024 * 1024) + '\n' + modelLine('claude-in-tail'))
    await runHook('before-edit.mjs', input())
    expect(readSession('runtime.json').model).toBe('claude-in-tail')
  })

  it.each([['codex', []], ['claude', ['--host', 'claude']]] as const)('%s: effort from PreToolUse lands in runtime.json while alone', async (host, args) => {
    await runHook('session-start.mjs', { cwd: dir, hook_event_name: 'SessionStart', model: 'host-model' }, [...args])
    await runHook('before-edit.mjs', { cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo x > app.py' }, effort: { level: 'high' }, ...(host === 'codex' ? { model: 'codex-model' } : {}) })
    expect(readSession('runtime.json')).toMatchObject({ effort: 'high', ...(host === 'codex' ? { model: 'codex-model' } : {}) })
    expect(readSession('session.json').effort).toBeUndefined()
  })
})

describe('hook health', () => {
  it('reports unverified pre-edit coverage on team join and first scope only', () => {
    vi.stubEnv('ROOM_HOST', 'codex')
    const s = session(new RoomDoc())
    const now = Date.now()
    expect(hookHealthNote(s, sdir(), false, now, 'room_join')).toBe('')
    expect(hookHealthNote(s, sdir(), true, now + 1, 'room_join')).toContain('approve them once in an interactive Codex session')
    expect(hookHealthNote(s, sdir(), true, now + 2, 'room_join')).toBe('')
    expect(hookHealthNote(s, sdir(), true, now + 3, 'room_scope')).toContain('approve them once in an interactive Codex session')
    expect(hookHealthNote(s, sdir(), true, now + 4, 'room_scope')).toBe('')
    expect(hookHealthNote(s, sdir(), true, now + 60_000, 'room_state')).toBe('')

    vi.stubEnv('ROOM_HOST', 'claude')
    const claude = session(new RoomDoc())
    for (const [at, tool] of [[1, 'room_join'], [2, 'room_scope'], [3, 'room_state'], [60_000, 'room_state'], [120_000, 'room_state']] as const) {
      expect(hookHealthNote(claude, sdir(), true, now + at, tool)).toBe('')
    }
    vi.stubEnv('ROOM_HOST', 'codex')

    const healthy = session(new RoomDoc())
    writeSessionFile('hook-activity.json', { session_id: SID, event: 'PreToolUse', at: now - 60_000 })
    expect(hookHealthNote(healthy, sdir(), true, now + 2, 'room_join')).toBe('')
    expect(hookHealthNote(healthy, sdir(), true, now + 3, 'room_scope')).toBe('')
    s.awareness.destroy(); claude.awareness.destroy(); healthy.awareness.destroy()
  })

  it('warns Claude once after its own tree changed without a PreToolUse receipt', () => {
    vi.stubEnv('ROOM_HOST', 'claude')
    const s = session(new RoomDoc())
    const now = Date.now()
    writeSessionFile('session.json', { session_id: SID, at: now })
    expect(hookHealthNote(s, sdir(), true, now, 'room_join')).toBe('')
    publishFixture(s.room, 'Rohan', 'app.py', 'x = 2\n')
    hookHealthNote(s, sdir(), true, now + 1, 'room_state')
    const note = hookHealthNote(s, sdir(), true, now + 60_000, 'room_state')
    expect(note).toContain("plugin's hooks may not be running")
    expect(note).not.toContain('Codex')
    expect(hookHealthNote(s, sdir(), true, now + 120_000, 'room_state')).toBe('')
    s.awareness.destroy()
  })

  it('does not warn Claude when a PreToolUse receipt follows its edit', () => {
    vi.stubEnv('ROOM_HOST', 'claude')
    const s = session(new RoomDoc())
    const now = Date.now()
    writeSessionFile('session.json', { session_id: SID, at: now })
    hookHealthNote(s, sdir(), true, now, 'room_join')
    publishFixture(s.room, 'Rohan', 'app.py', 'x = 2\n')
    writeSessionFile('hook-activity.json', { session_id: SID, event: 'PreToolUse', at: now + 1 })
    expect(hookHealthNote(s, sdir(), true, now + 60_000, 'room_state')).toBe('')
    s.awareness.destroy()
  })

  it('ignores an edit and receipt from before this Claude session started', () => {
    vi.stubEnv('ROOM_HOST', 'claude')
    const s = session(new RoomDoc())
    const now = Date.now()
    publishFixture(s.room, 'Rohan', 'app.py', 'x = 2\n')
    s.room.overlayAt.set('Rohan', now - 60_000)
    writeSessionFile('session.json', { session_id: SID, at: now })
    writeSessionFile('hook-activity.json', { session_id: SID, event: 'PreToolUse', at: now - 60_000 })
    expect(hookHealthNote(s, sdir(), true, now, 'room_join')).toBe('')
    expect(hookHealthNote(s, sdir(), true, now + 60_000, 'room_state')).toBe('')
    publishFixture(s.room, 'Rohan', 'app.py', 'x = 3\n')
    expect(hookHealthNote(s, sdir(), true, now + 61_000, 'room_state')).toContain('before-edit hook')
    s.awareness.destroy()
  })

  it('tells agents to claim the files they will edit, not an overbroad directory', () => {
    expect(AGENT_INSTRUCTIONS()).toContain('claim the files you will edit')
    expect(AGENT_INSTRUCTIONS()).not.toContain('prefer one directory claim')
  })
})

describe('wakes: capability presence and the lead\'s own workers', () => {
  it('publishes known unavailable Claude wake capability', () => {
    vi.stubEnv('ROOM_HOST', 'claude')
    vi.stubEnv('ROOM_CLAUDE_CHANNEL', '')
    const s = session(new RoomDoc())
    const w = wakes(s)
    expect(s.awareness.getLocalState()).toMatchObject({ wakeUnavailable: true })
    w.stop(); s.awareness.destroy()
  })

  it('publishes socket wake capability and honors ROOM_WAKE=off', () => {
    vi.stubEnv('ROOM_HOST', 'claude')
    vi.stubEnv('ROOM_CLAUDE_CHANNEL', '')
    vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', '/tmp/claude-inbox.sock')
    const s = session(new RoomDoc())
    const w = wakes(s)
    expect(s.awareness.getLocalState()).toMatchObject({ wakeUnavailable: false })
    w.stop(); s.awareness.destroy()
    vi.stubEnv('ROOM_WAKE', 'off')
    const off = session(new RoomDoc())
    const offWakes = wakes(off)
    expect(off.awareness.getLocalState()).toMatchObject({ wakeUnavailable: true })
    offWakes.stop(); off.awareness.destroy()
  })

  it('wakes for own worker questions and failures, but not progress notes', async () => {
    const s = session(new RoomDoc())
    visiblePeer(s.room, 'Rohan+money')
    const send = vi.fn(async () => 'queue' as const)
    const w = wakes(s, send, new Set(['Rohan+money']))
    const from = { name: 'Rohan+money', kind: 'agent' } as const
    const settled = () => new Promise(r => setTimeout(r, 30))
    try {
      hubAppend(s.room, from, { type: 'note', to: 'Rohan', text: 'halfway' })
      await settled()
      expect(send).not.toHaveBeenCalled()
      hubAppend(s.room, from, { type: 'question', to: 'Rohan', text: 'which field?' })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
      hubAppend(s.room, from, { type: 'note', priority: 'interrupt', to: 'Rohan', text: 'failed' })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    } finally { w.stop(); s.awareness.destroy(); s.room.doc.destroy() }
  })
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
  ]) {
    expect(hook.coversPath(a, b), `${a} vs ${b}`).toBe(covers(a, b))
    expect(hook.containsPath(a, b), `${a} contains ${b}`).toBe(shared.containsPath(a, b))
    expect(hook.normalizeCoordinationPath(a)).toBe(shared.normalizeCoordinationPath(a))
  }
  for (const parent of ['', '  ', '/', '/..', 'C:\\..', '.', './']) {
    expect(hook.containsPath(parent, 'src/a.ts')).toBe(shared.containsPath(parent, 'src/a.ts'))
  }
  const evidence = [
    { by: 'Ada', path: 'api/', reason: 'scope' as const },
    { by: 'Bea', path: 'src/a.ts', reason: 'changed' as const },
    { by: 'Cy', path: 'api/tax.py', reason: 'claim' as const },
  ]
  for (const path of ['api/tax.py', './api/new.py', 'api-other/tax.py', 'src/a.ts']) {
    expect(shared.nearPath(path, evidence)).toEqual(evidence.filter(entry => hook.coversPath(path, entry.path)))
  }
})
