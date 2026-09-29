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
  ] as const)('warns only for target writes: %s %s', async (tool_name, command, warn) => {
    const out = await run(command, tool_name)
    expect(out.includes('Claim before editing'), command).toBe(warn)
    if (warn) expect(out).toContain('Kieran changed api/tax.py')
  })

  it.each(['cp app.py api/tax.py >/dev/null', 'git checkout HEAD api/tax.py', 'git checkout main api/tax.py', 'git checkout api/tax.py', 'cd api && git checkout tax.py'])('names the file operand: %s', async command => {
    expect(await run(command, 'Bash')).toContain('Kieran changed api/tax.py')
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
