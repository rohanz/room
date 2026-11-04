import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sessionDirectory } from '../src/session.js'

const HOOKS = resolve(__dirname, '../../../plugins/room/hooks')
const SID = 'port-shell-session'
let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-port-hooks-'))
  execFileSync('git', ['init', '-q', dir])
  mkdirSync(join(dir, 'api'))
  writeFileSync(join(dir, 'api/tax.py'), 'x = 1\n')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
})
afterAll(() => rmSync(dir, { force: true, recursive: true }))
beforeEach(() => {
  const stateDir = sessionDirectory(join(dir, '.git'), SID)
  rmSync(join(dir, '.git/room'), { force: true, recursive: true })
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ at: Date.now(), company: true, claims: [], ownClaims: [], near: [{ by: 'Kieran', path: 'api/tax.py', reason: 'changed' }] }))
  writeFileSync(join(stateDir, 'hook.json'), JSON.stringify({ companyTold: true }))
})
function run(command: string, tool_name: string, session_id = SID): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('node', [join(HOOKS, 'before-edit.mjs')], { cwd: HOOKS }, (error, stdout) => error ? reject(error) : resolve(stdout))
    child.stdin!.end(JSON.stringify({ cwd: dir, session_id, tool_name, tool_input: { command } }))
  })
}

describe('0.16.38 shell write classifier in the redesign hook', () => {
  it.each([
    ['Bash', 'grep -n "^def test" api/tax.py', false],
    ['Bash', 'grep ">" api/tax.py', false],
    ['Bash', "grep '>>' api/tax.py", false],
    ['Bash', 'cat api/tax.py', false],
    ['Bash', 'head -5 api/tax.py', false],
    ['Bash', 'tail api/tax.py', false],
    ['Bash', 'less api/tax.py', false],
    ['Bash', 'wc -l api/tax.py', false],
    ['Bash', 'ls api/', false],
    ['Bash', 'npm test', false],
    ['Bash', 'git diff api/tax.py', false],
    ['Bash', 'git log -- api/tax.py', false],
    ['Bash', 'git show HEAD:api/tax.py', false],
    ['Bash', 'git commit -m "fix api/tax.py"', false],
    ['Bash', 'git push', false],
    ['Bash', 'git pull --ff-only --autostash', false],
    ['Bash', 'pytest api/tax.py 2>&1 | tail -20', false],
    ['Bash', 'sed -n "1,4p" api/tax.py', false],
    ['Bash', 'rg x api/tax.py | head', false],
    ['Bash', 'pytest api/tax.py; git add api/tax.py && git commit -m "tax"', false],
    ['Bash', 'cd api && uv run pytest tax.py', false],
    ['Bash', 'A=1 python -m pytest api/tax.py', false],
    ['Bash', 'npx vitest api/tax.py || git status', false],
    ['Bash', 'find api/tax.py -type f', false],
    ['Bash', 'mystery api/tax.py', false],
    ['Bash', 'python3 -c "pass" api/tax.py', false],
    ['Bash', 'node -e "0" api/tax.py', false],
    ['Bash', 'sed -i "s/x/y/" api/tax.py', true],
    ['Bash', 'sed -i.bak "s/x/y/" api/tax.py', true],
    ['Bash', 'sed --in-place "s/x/y/" api/tax.py', true],
    ['Bash', 'sed --in-place=.bak "s/x/y/" api/tax.py', true],
    ['Bash', 'cd api && sed -i "s/x/y/" tax.py', true],
    ['Bash', 'touch app.py api/tax.py', true],
    ['Bash', 'find api/tax.py -delete', true],
    ['Bash', 'perl -pi -e "s/x/y/" api/tax.py', true],
    ['Bash', 'echo x > api/tax.py', true],
    ['Bash', 'echo x >> api/tax.py', true],
    ['Bash', 'echo x > /dev/null 2>&1', false],
    ['Bash', 'cat api/tax.py | tee api/tax.py', true],
    ['Bash', 'cp app.py api/tax.py', true],
    ['Bash', 'mv api/tax.py old.py', true],
    ['Bash', 'git mv api/tax.py old.py', true],
    ['Bash', 'git rm api/tax.py', true],
    ['Bash', 'git rm --dry-run api/tax.py', false],
    ['Bash', 'git rm -n -- api/tax.py', false],
    ['Bash', 'git rm --cached api/tax.py', false],
    ['Bash', 'patch api/tax.py fix.diff', true],
    ['Bash', 'patch api/tax.py < fix.diff', true],
    ['Bash', 'patch --dry-run api/tax.py < fix.diff', false],
    ['Bash', 'patch --check api/tax.py < fix.diff', false],
    ['Bash', 'patch -C api/tax.py < fix.diff', false],
    ['Bash', 'patch -p1 < fix.diff', false],
    ['Bash', 'git apply fix.diff', false],
    ['Bash', 'rm api/tax.py', true],
    ['Bash', 'truncate -s 0 api/tax.py', true],
    ['Bash', 'touch api/tax.py', true],
    ['Bash', 'git checkout -- api/tax.py', true],
    ['Bash', 'git restore api/tax.py', true],
    ['Bash', 'dd if=app.py of=api/tax.py', true],
    ['PowerShell', 'Get-Content api/tax.py | Select-String x', false],
    ['PowerShell', 'Set-Content -LiteralPath api/tax.py -Value x', true],
    ['PowerShell', 'Copy-Item app.py api/tax.py', true],
    ['PowerShell', 'Get-Content app.py > api/tax.py', true],
    ['PowerShell', 'git restore api/tax.py', true],
    ['PowerShell', 'git checkout -- api/tax.py', true],
    ['PowerShell', 'git rm api/tax.py', true],
    ['PowerShell', 'git rm --dry-run api/tax.py', false],
    ['PowerShell', 'git rm -n -- api/tax.py', false],
    ['PowerShell', 'git rm --cached api/tax.py', false],
    ['PowerShell', 'rm api/tax.py', true],
    ['PowerShell', 'sed -i.bak "s/x/y/" api/tax.py', true],
    ['PowerShell', 'sed --in-place "s/x/y/" api/tax.py', true],
    ['PowerShell', 'sed --in-place=.bak "s/x/y/" api/tax.py', true],
    ['PowerShell', 'patch api/tax.py < fix.diff', true],
    ['PowerShell', 'patch --dry-run api/tax.py < fix.diff', false],
    ['PowerShell', 'patch --check api/tax.py < fix.diff', false],
    ['PowerShell', 'patch -C api/tax.py < fix.diff', false],
    ['PowerShell', 'patch -p1 < fix.diff', false],
  ] as const)('classifies target writes: %s %s', async (tool_name, command, warn) => {
    const { pathsOf } = await import(join(HOOKS, 'common.mjs'))
    expect(pathsOf(tool_name, { command }, dir).includes('api/tax.py'), command).toBe(warn)
  })

  it.each(['cp app.py api/tax.py >/dev/null', 'git checkout HEAD api/tax.py', 'git checkout main api/tax.py', 'git checkout api/tax.py', 'cd api && git checkout tax.py'])('names the file operand: %s', async command => {
    const { pathsOf } = await import(join(HOOKS, 'common.mjs'))
    expect(pathsOf('Bash', { command }, dir)).toContain('api/tax.py')
  })

  it.each([
    'cp app.py api/tax.py >/dev/null', 'cp app.py api/tax.py >run.log',
    'mv app.py api/tax.py 2>/dev/null', 'rm api/tax.py &>run.log',
    'touch api/tax.py >>run.log', 'tee api/tax.py <app.py',
    'sed -i "s/x/y/" api/tax.py >run.log', 'perl -pi -e "s/x/y/" api/tax.py 2>&1',
    'truncate -s 0 api/tax.py >run.log', 'git mv app.py api/tax.py >run.log',
    'git rm api/tax.py 2>/dev/null', 'git restore api/tax.py >run.log',
  ])('classifies redirected file operands: %s', async command => {
    const { pathsOf } = await import(join(HOOKS, 'common.mjs'))
    expect(pathsOf('Bash', { command }, dir), command).toContain('api/tax.py')
  })

  it.each(['git checkout main', 'git checkout feature/x', 'git checkout -b x', 'git switch api/tax.py'])('ignores a branch checkout: %s', async command => {
    const { pathsOf } = await import(join(HOOKS, 'common.mjs'))
    expect(pathsOf('Bash', { command }, dir)).toEqual([])
  })

  it.each([
    ['Bash', 'sed -i "s/x/y/" api/tax.py app.py'],
    ['Bash', "sed -i '' -e 's/x/y/' api/tax.py app.py"],
    ['Bash', "sed -i.bak -f changes.sed api/tax.py app.py"],
    ['Bash', "perl -pi -e 's/x/y/' api/tax.py app.py"],
    ['Bash', 'git restore --source=HEAD api/tax.py app.py'],
    ['Bash', 'git restore -s HEAD --staged --worktree api/tax.py app.py'],
    ['Bash', 'git checkout -- api/tax.py app.py'],
    ['Bash', 'git stash -- api/tax.py app.py'],
    ['PowerShell', 'Move-Item api/tax.py old.py'],
    ['PowerShell', 'Rename-Item -Path api/tax.py -NewName old.py'],
    ['Bash', "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: api/tax.py\n@@\n-x = 1\n+x = 2\n*** End Patch\nEOF"],
  ] as const)('classifies the first file operand: %s %s', async (tool_name, command) => {
    const { pathsOf } = await import(join(HOOKS, 'common.mjs'))
    expect(pathsOf(tool_name, { command }, dir), command).toContain('api/tax.py')
  })
})

describe('shell classifier integration', () => {
  it.each([['Bash', 'cp app.py api/tax.py >/dev/null'], ['PowerShell', 'Set-Content -Path api/tax.py -Value x']])('warns on %s writes', async (tool, command) => {
    expect(await run(command, tool)).toContain('Kieran changed api/tax.py')
  })
})

describe('before-edit receipts under the redesign local-state directory', () => {
  const common = () => join(dir, '.git/room')
  const receiptsDir = () => join(common(), 'hook-receipts')
  it('keeps independent receipts from eight simultaneous host sessions', async () => {
    const { hookReceiptFile } = await import(join(HOOKS, 'common.mjs'))
    const ids = Array.from({ length: 8 }, (_, i) => `concurrent-${i}`)
    await Promise.all(ids.map(id => run('git status', 'Bash', id)))
    for (const id of ids) expect(JSON.parse(readFileSync(hookReceiptFile(common(), id), 'utf8'))).toMatchObject({ sessionId: id })
    expect(fs.readdirSync(receiptsDir()).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('writes no receipt or activity for oversized and control-character session ids', async () => {
    const { writeHookReceipt, receiptSessionId } = await import(join(HOOKS, 'common.mjs'))
    expect(receiptSessionId('x'.repeat(256))).toBe('x'.repeat(256))
    for (const bad of ['x'.repeat(257), 'a\nb', 'a\u0000b', '', 42]) expect(writeHookReceipt(common(), bad, Date.now())).toBe(false)
    await run('git status', 'Bash', 'x'.repeat(257))
    expect(fs.existsSync(receiptsDir())).toBe(false)
    expect(fs.existsSync(join(sessionDirectory(join(dir, '.git'), 'x'.repeat(257)), 'hook-activity.json'))).toBe(false)
  })

  it('replaces oversized activity evidence with a bounded current record', async () => {
    const activity = join(sessionDirectory(join(dir, '.git'), SID), 'hook-activity.json')
    writeFileSync(activity, JSON.stringify({ session_id: SID, at: Date.now(), padding: 'x'.repeat(5000) }))
    await run('git status', 'Bash')
    expect(JSON.parse(readFileSync(activity, 'utf8'))).toMatchObject({ session_id: SID, event: 'PreToolUse' })
    expect(fs.statSync(activity).size).toBeLessThan(4096)
    writeFileSync(activity, JSON.stringify({ session_id: 'other', event: 'PreToolUse', at: Date.now() }))
    await run('git status', 'Bash')
    expect(JSON.parse(readFileSync(activity, 'utf8')).session_id).toBe(SID)
  })

  it('caps receipt reads at 4 KB and advances pruning past 500 fresh names', async () => {
    const { readReceipt, pruneHookReceipts } = await import(join(HOOKS, 'common.mjs'))
    mkdirSync(receiptsDir(), { recursive: true })
    const large = join(receiptsDir(), 'large.json')
    writeFileSync(large, JSON.stringify({ at: 1, padding: 'x'.repeat(5000) }))
    expect(readReceipt(large)).toBeUndefined()
    const now = Date.now(), old = new Date(now - 8 * 86400_000)
    for (let i = 0; i < 500; i++) writeFileSync(join(receiptsDir(), `a-${String(i).padStart(3, '0')}.json`), '{}')
    const stale = join(receiptsDir(), 'z-stale.json')
    writeFileSync(stale, '{}'); fs.utimesSync(stale, old, old)
    pruneHookReceipts(receiptsDir(), now)
    expect(fs.existsSync(stale)).toBe(true)
    fs.utimesSync(join(receiptsDir(), '.pruned'), old, old)
    pruneHookReceipts(receiptsDir(), now)
    expect(fs.existsSync(stale)).toBe(false)
  })

  it('preserves a refreshed receipt while pruning renames an old path', async () => {
    const { pruneHookReceipts } = await import(join(HOOKS, 'common.mjs'))
    mkdirSync(receiptsDir(), { recursive: true })
    const now = Date.now(), file = join(receiptsDir(), 'old.json')
    writeFileSync(file, '{"at":1}')
    const old = new Date(now - 8 * 86400_000)
    fs.utimesSync(file, old, old)
    const rename = fs.renameSync.bind(fs)
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from) === file && String(to).includes('.pruning.')) writeFileSync(file, '{"at":2}')
      return rename(from, to)
    })
    try { pruneHookReceipts(receiptsDir(), now) } finally { spy.mockRestore() }
    expect(readFileSync(file, 'utf8')).toBe('{"at":2}')
  })

  it.each(['EPERM', 'EEXIST', 'COPY_EEXIST'])('cleans a fresh tombstone when restore encounters %s', async code => {
    const { pruneHookReceipts } = await import(join(HOOKS, 'common.mjs'))
    mkdirSync(receiptsDir(), { recursive: true })
    const now = Date.now(), file = join(receiptsDir(), 'old.json')
    writeFileSync(file, '{"at":1}')
    const old = new Date(now - 8 * 86400_000)
    fs.utimesSync(file, old, old)
    const rename = fs.renameSync.bind(fs)
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to)
      if (String(from) === file && String(to).includes('.pruning.')) fs.utimesSync(to, new Date(now), new Date(now))
    })
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((_from, to) => {
      if (String(to) === file) {
        if (code === 'EEXIST') writeFileSync(file, '{"at":2}')
        const errorCode = code === 'EEXIST' ? 'EEXIST' : 'EPERM'
        throw Object.assign(new Error(errorCode), { code: errorCode })
      }
      throw new Error('unexpected link')
    })
    const copy = fs.copyFileSync.bind(fs)
    const copySpy = vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, flags) => {
      expect(flags).toBe(fs.constants.COPYFILE_EXCL)
      if (code === 'COPY_EEXIST') {
        writeFileSync(file, '{"at":2}')
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
      }
      return copy(from, to, flags)
    })
    try { expect(() => pruneHookReceipts(receiptsDir(), now)).not.toThrow() }
    finally { copySpy.mockRestore(); linkSpy.mockRestore(); renameSpy.mockRestore() }
    expect(readFileSync(file, 'utf8')).toBe(code === 'EPERM' ? '{"at":1}' : '{"at":2}')
    expect(fs.readdirSync(receiptsDir()).filter(name => name.includes('.pruning.'))).toEqual([])
  })
})

describe('bounded hook reads, replies and temp files', () => {
  const stateDir = () => sessionDirectory(join(dir, '.git'), SID)
  const quietStderr = () => vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

  it('removes its own temp file when an atomic JSON write fails', async () => {
    const { writeJsonAtomic } = await import(join(HOOKS, 'common.mjs'))
    const file = join(stateDir(), 'hook.json')
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }) })
    try { expect(() => writeJsonAtomic(file, { a: 1 })).not.toThrow() } finally { spy.mockRestore() }
    expect(fs.readdirSync(stateDir()).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ companyTold: true })
  })

  it('ignores a JSON state file over its cap with a diagnostic', async () => {
    const { readJson, readBoundedText } = await import(join(HOOKS, 'common.mjs'))
    const file = join(stateDir(), 'big.json')
    writeFileSync(file, JSON.stringify({ padding: 'x'.repeat(200) }))
    const stderr = quietStderr()
    try {
      expect(readJson(file, 'fallback', 100)).toBe('fallback')
      expect(stderr.mock.calls.join('')).toContain('big.json is over 100 bytes')
    } finally { stderr.mockRestore() }
    expect(readBoundedText(file, 100)).toEqual({ oversized: true })
    expect(readJson(file, 'fallback', 1000)).toMatchObject({ padding: expect.any(String) })
    expect(readJson(join(stateDir(), 'absent.json'), 'fallback')).toBe('fallback')
  })

  it('reads stdin under a byte cap and a deadline', async () => {
    const { readStdinJson, inputIncomplete } = await import(join(HOOKS, 'common.mjs'))
    const { PassThrough } = await import('node:stream')
    const valid = new PassThrough()
    const payload = { tool_input: { content: 'y'.repeat(100_000) } }
    const parsed = readStdinJson(valid, { maxBytes: 200_000, deadlineMs: 5000 })
    valid.end(JSON.stringify(payload))
    expect(await parsed).toEqual(payload)
    const stderr = quietStderr()
    try {
      const big = new PassThrough()
      const over = readStdinJson(big, { maxBytes: 1000, deadlineMs: 5000 })
      big.write('x'.repeat(1001))
      const overValue = await over
      expect(overValue).toEqual({})
      expect(inputIncomplete(overValue)).toBe('input over 1000 bytes')
      // Over the cap, the complete routing fields of the prefix survive; the content does not.
      const write = new PassThrough()
      const routed = readStdinJson(write, { maxBytes: 1000, deadlineMs: 5000 })
      write.write(JSON.stringify({ session_id: 's', tool_name: 'Write', effort: { level: 'high' }, tool_input: { file_path: 'api/tax.py', content: 'y'.repeat(5000) } }))
      const routedValue = await routed
      expect(routedValue).toEqual({ session_id: 's', tool_name: 'Write', effort: { level: 'high' }, tool_input: { file_path: 'api/tax.py' } })
      expect(big.destroyed && write.destroyed).toBe(true)
      const stuck = new PassThrough()
      const stuckValue = await readStdinJson(stuck, { maxBytes: 1000, deadlineMs: 20 })
      expect(stuckValue).toEqual({})
      expect(inputIncomplete(stuckValue)).toBe('input not complete within 20 ms')
      // All bytes arrived but the stream never ended: the whole event, not a partial one.
      const open = new PassThrough()
      const openValue = readStdinJson(open, { maxBytes: 1000, deadlineMs: 20 })
      open.write(JSON.stringify({ session_id: 's' }))
      expect(inputIncomplete(await openValue)).toBeUndefined()
      const text = stderr.mock.calls.join('')
      expect(text).toContain('hook input over 1000 bytes')
      expect(text).toContain('not complete within 20 ms')
    } finally { stderr.mockRestore() }
  })

  it('keeps only complete fields from a cut-off input prefix', async () => {
    const { prefixFields } = await import(join(HOOKS, 'common.mjs'))
    const full = JSON.stringify({ a: 'x', n: 12, b: true, z: null, list: ['p', { q: 1 }], deep: { inner: { v: 'w' } }, tool_input: { file_path: 'f "q".py', old_string: 'o\\"' } })
    expect(prefixFields(full)).toEqual({ a: 'x', n: 12, b: true, z: null, deep: {}, tool_input: { file_path: 'f "q".py', old_string: 'o\\"' } })
    for (let cut = 0; cut < full.length; cut++) {
      const got = prefixFields(full.slice(0, cut))
      // Every value returned at any cut equals the full value or is a prefix-free subset of it.
      for (const [key, value] of Object.entries(got)) {
        if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) expect(JSON.parse(full)[key][k]).toEqual(v)
        else expect(JSON.parse(full)[key]).toEqual(value)
      }
    }
    expect(prefixFields(JSON.stringify({ tool_input: { command: 'c'.repeat(5000) } }))).toEqual({ tool_input: {} })
    expect(prefixFields('not json')).toEqual({})
  })

  function runHook(input: (stdin: NodeJS.WritableStream) => void, cwd = HOOKS): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = execFile('node', [join(HOOKS, 'before-edit.mjs')], { cwd, env: { ...process.env, PWD: cwd }, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))
      child.stdin!.on('error', () => { /* the hook stops reading at the cap or deadline */ })
      input(child.stdin!)
    })
  }
  const context = (stdout: string) => JSON.parse(stdout).hookSpecificOutput.additionalContext as string

  it('routes a Write over the stdin cap by its path and says the rest was not read', async () => {
    const { STDIN_MAX_BYTES } = await import(join(HOOKS, 'common.mjs'))
    const { stdout, stderr } = await runHook(stdin => stdin.end(JSON.stringify({ cwd: dir, session_id: SID, tool_name: 'Write', tool_input: { file_path: 'api/tax.py', content: 'x'.repeat(STDIN_MAX_BYTES) } })))
    expect(context(stdout)).toContain(`Room read only the start of this tool call (input over ${STDIN_MAX_BYTES} bytes): claims and nearby work were checked for api/tax.py only`)
    expect(context(stdout)).toContain('Claim before editing: Kieran changed api/tax.py.')
    expect(stderr).toContain('hook input over')
  })

  it('says coordination is unavailable for a shell command over the cap', async () => {
    const { STDIN_MAX_BYTES } = await import(join(HOOKS, 'common.mjs'))
    const { stdout } = await runHook(stdin => stdin.end(JSON.stringify({ cwd: dir, session_id: SID, tool_name: 'Bash', tool_input: { command: `echo ${'x'.repeat(STDIN_MAX_BYTES)} > api/tax.py` } })))
    expect(context(stdout)).toContain('Room could not read this whole tool call (input over')
    expect(context(stdout)).not.toContain('Claim before editing')
  })

  it('routes a valid input that finishes after the stdin deadline', async () => {
    const event = JSON.stringify({ cwd: dir, session_id: SID, tool_name: 'Edit', tool_input: { file_path: 'api/tax.py', old_string: 'x', new_string: 'y' } })
    const cut = event.indexOf('"old_string"')
    const { stdout } = await runHook(stdin => { stdin.write(event.slice(0, cut)); setTimeout(() => stdin.end(event.slice(cut)), 2600) })
    expect(context(stdout)).toContain('Room read only the start of this tool call (input not complete within 2000 ms): claims and nearby work were checked for api/tax.py only')
    expect(context(stdout)).toContain('Claim before editing: Kieran changed api/tax.py.')
  })

  it('says coordination is unavailable when no input arrives before the deadline', async () => {
    const { stdout } = await runHook(stdin => { setTimeout(() => stdin.end('{}'), 2600) }, dir)
    expect(context(stdout)).toContain('Room could not read this whole tool call (input not complete within 2000 ms)')
  })

  it('settles requests when the MCP endpoint sends an oversized or malformed reply', async () => {
    const net = await import('node:net')
    const { openMcp, selectReply } = await import(join(HOOKS, 'common.mjs'))
    const replies: ((socket: import('node:net').Socket) => void)[] = [
      socket => socket.write('x'.repeat(5000)),
      socket => socket.write('not json\n'),
    ]
    const stderr = quietStderr()
    try {
      for (const reply of replies) {
        const server = net.createServer(socket => socket.once('data', () => reply(socket)))
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
        writeFileSync(join(stateDir(), 'mcp.json'), JSON.stringify({ port: (server.address() as import('node:net').AddressInfo).port, key: 'k' }))
        const mcp = await openMcp(stateDir(), 2000, 1000)
        expect(await mcp.request({ op: 'select' })).toBeUndefined()
        expect(await mcp.request({ op: 'select' })).toBeUndefined()
        mcp.close()
        await new Promise(r => server.close(r))
      }
    } finally { stderr.mockRestore() }
    expect(selectReply({ ok: true, batch: 'b', items: 'x', notices: [] })).toBeUndefined()
    expect(selectReply({ ok: true, batch: 'b', items: [{}], notices: [] })).toBeUndefined()
    expect(selectReply({ ok: true, batch: 'b', items: [], notices: [1] })).toBeUndefined()
    expect(selectReply({ ok: true, items: [], notices: [] })).toBeUndefined()
    const good = { ok: true, batch: 'b', items: [{ line: 'hi' }], notices: [], more: 0 }
    expect(selectReply(good)).toBe(good)
  })

  it('never confirms a select reply of the wrong shape, so its items stay owed', async () => {
    const net = await import('node:net')
    const ops: string[] = []
    const server = net.createServer(socket => {
      let buffered = ''
      socket.on('data', chunk => {
        buffered += chunk
        for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
          const req = JSON.parse(buffered.slice(0, nl)); buffered = buffered.slice(nl + 1)
          ops.push(req.op)
          socket.write(JSON.stringify(req.op === 'select' ? { ok: true, batch: 'b1', items: 'not an array', notices: [] } : { ok: true }) + '\n')
        }
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    try {
      writeFileSync(join(stateDir(), 'mcp.json'), JSON.stringify({ port: (server.address() as import('node:net').AddressInfo).port, key: 'k' }))
      writeFileSync(join(stateDir(), 'state.json'), JSON.stringify({ at: Date.now(), company: false, owedCount: 2, claims: [] }))
      const out = await run('git status', 'Bash')
      expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain('2 messages pending')
      expect(ops).toEqual(['select'])
    } finally { await new Promise(r => server.close(r)) }
  })

  it('reads a bounded directory batch and a bounded cursor when pruning', async () => {
    const { pruneHookReceipts } = await import(join(HOOKS, 'common.mjs'))
    const receipts = join(dir, '.git/room/hook-receipts')
    mkdirSync(receipts, { recursive: true })
    const now = Date.now(), old = new Date(now - 8 * 86400_000)
    for (let i = 0; i < 40; i++) {
      const file = join(receipts, `r-${String(i).padStart(2, '0')}.json`)
      writeFileSync(file, '{}'); fs.utimesSync(file, old, old)
    }
    writeFileSync(join(receipts, '.prune-cursor'), 'z'.repeat(300))
    pruneHookReceipts(receipts, now, 10)
    const left = fs.readdirSync(receipts).filter(name => name.endsWith('.json')).length
    expect(left).toBeLessThan(40)
    expect(left).toBeGreaterThanOrEqual(30)
    for (let pass = 0; pass < 10 && fs.readdirSync(receipts).some(name => name.endsWith('.json')); pass++) {
      fs.utimesSync(join(receipts, '.pruned'), old, old)
      pruneHookReceipts(receipts, now, 10)
    }
    expect(fs.readdirSync(receipts).filter(name => name.endsWith('.json'))).toEqual([])
  })
})
