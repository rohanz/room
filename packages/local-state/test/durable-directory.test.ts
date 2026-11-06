import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { writeAtomic } from '../src/leases.js'

const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const setup = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-durable-')); dirs.push(dir); return dir }

it.each(['EPERM', 'EACCES', 'EBUSY'])('retries a Windows atomic replacement after injected %s failures on every platform', code => {
  const dir = setup(), file = path.join(dir, 'record.json'), rename = fs.renameSync.bind(fs)
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  fs.writeFileSync(file, '{}')
  const wait = vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, delay) => {
    expect(delay).toBeGreaterThan(0)
    expect(delay).toBeLessThanOrEqual(110)
    expect(fs.readFileSync(file, 'utf8')).toBe('{}')
    expect(fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))).toHaveLength(1)
    return 'timed-out'
  })
  let attempts = 0
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    Object.defineProperty(process, 'platform', { value: 'win32' }) // only the rename runs as Windows
    if (++attempts <= 2) throw Object.assign(new Error('destination temporarily busy'), { code })
    rename(from, to)
  })
  try {
    writeAtomic(file, { complete: true })
    expect(attempts).toBe(3)
    expect(wait).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ complete: true })
    expect(fs.readdirSync(dir)).toEqual(['record.json'])
  } finally { Object.defineProperty(process, 'platform', platform) }
}, 30_000)

it.each([{ platform: 'win32', code: 'ENOENT' }, { platform: 'linux', code: 'EPERM' }])('does not retry $code on $platform', ({ platform, code }) => {
  const dir = setup(), file = path.join(dir, 'record.json'), descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const failure = Object.assign(new Error('permanent rename failure'), { code })
  const wait = vi.spyOn(Atomics, 'wait')
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    Object.defineProperty(process, 'platform', { value: platform })
    throw failure
  })
  try {
    expect(() => writeAtomic(file, {})).toThrow(failure)
    expect(rename).toHaveBeenCalledTimes(1)
    expect(wait).not.toHaveBeenCalled()
    expect(fs.readdirSync(dir)).toEqual([])
  } finally { Object.defineProperty(process, 'platform', descriptor) }
}, 30_000)

it('bounds Windows rename retries to two seconds and removes the failed temp', () => {
  const dir = setup(), file = path.join(dir, 'record.json'), platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  // Preserve an existing record through an exhausted replacement.
  fs.writeFileSync(file, '{"original":true}')
  vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
  const clock = vi.spyOn(performance, 'now')
  const failure = Object.assign(new Error('destination stays busy'), { code: 'EBUSY' })
  let elapsed = 0
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    clock.mockImplementation(() => elapsed += 1000)
    throw failure
  })
  // The first clock read belongs to renameAtomic; set later reads from the injected rename.
  clock.mockReturnValue(0)
  try {
    expect(() => writeAtomic(file, {})).toThrow(failure)
    expect(rename).toHaveBeenCalledTimes(2)
    expect(Atomics.wait).toHaveBeenCalledTimes(1)
    expect(fs.readFileSync(file, 'utf8')).toBe('{"original":true}')
    expect(fs.readdirSync(dir)).toEqual(['record.json'])
  } finally { Object.defineProperty(process, 'platform', platform) }
}, 30_000)

it('writes below an existing root that rejects mkdir with Windows EPERM', () => {
  const dir = setup(), root = path.parse(dir).root
  const mkdir = fs.mkdirSync.bind(fs)
  vi.spyOn(fs, 'mkdirSync').mockImplementation((target, options) => {
    if (String(target) === root) throw Object.assign(new Error('Windows root mkdir'), { code: 'EPERM' })
    return mkdir(target, options)
  })
  const file = path.join(dir, 'new', 'nested', 'record.json')
  writeAtomic(file, { value: 1 })
  writeAtomic(file, { value: 2 })
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ value: 2 })
}, process.platform === 'win32' ? 30_000 : undefined) // one leaf ACL check plus process identity inspection on slow Windows runners

// The private leaf uses native Windows creation; real Windows races and denials are tested below.
it.skipIf(process.platform === 'win32')('still syncs an existing ancestor when another writer wins mkdir', () => {
  const dir = setup(), raced = path.join(dir, 'raced')
  const mkdir = fs.mkdirSync.bind(fs)
  let racedOnce = false
  vi.spyOn(fs, 'mkdirSync').mockImplementation((target, options) => {
    if (String(target) === raced && !racedOnce) { racedOnce = true; mkdir(target, options) }
    return mkdir(target, options)
  })
  const open = vi.spyOn(fs, 'openSync')
  const sync = vi.spyOn(fs, 'fsyncSync')
  const file = path.join(raced, 'record.json')
  writeAtomic(file, { value: 1 })
  const parentOpen = open.mock.calls.findIndex(([target]) => String(target) === dir)
  expect(racedOnce).toBe(true)
  expect(parentOpen).toBeGreaterThanOrEqual(0)
  const opened = open.mock.results[parentOpen]
  if (opened.type === 'return') expect(sync).toHaveBeenCalledWith(opened.value)
  else expect(['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM']).toContain(opened.value.code)
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ value: 1 })
})

it.skipIf(process.platform === 'win32')('does not suppress permission errors below the root', () => {
  const dir = setup(), denied = path.join(dir, 'denied'), mkdir = fs.mkdirSync.bind(fs)
  vi.spyOn(fs, 'mkdirSync').mockImplementation((target, options) => {
    if (String(target) === denied) throw Object.assign(new Error('denied'), { code: 'EPERM' })
    return mkdir(target, options)
  })
  expect(() => writeAtomic(path.join(denied, 'record.json'), {})).toThrow('denied')
})

it('refuses a file in the directory path', () => {
  const dir = setup(), file = path.join(dir, 'file')
  fs.writeFileSync(file, 'keep')
  expect(() => writeAtomic(path.join(file, 'record.json'), {})).toThrow()
  expect(fs.readFileSync(file, 'utf8')).toBe('keep')
})

const psEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
function windowsAcl(target: string): { user: string; grants: string[] } {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $u=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $a=Get-Acl -LiteralPath $env:ROOM_TEST_PATH; @{user=$u;grants=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.AccessControlType -eq 'Allow'} | ForEach-Object {$_.IdentityReference.Value})} | ConvertTo-Json -Compress"],
  { env: { ...psEnv(), ROOM_TEST_PATH: target }, encoding: 'utf8', timeout: 20_000 }).trim())
}

it.runIf(process.platform === 'win32').each(['room', 'config'])('racing Windows writers create a private nested %s directory', async kind => {
  const dir = setup(), barrier = path.join(dir, 'go')
  const file = path.join(dir, kind, 'new', 'nested', 'record.json')
  const leases = new URL('../src/leases.ts', import.meta.url).href
  const script = `import fs from 'node:fs';
    import { writeAtomic } from ${JSON.stringify(leases)};
    process.send({ready: true});
    const until = Date.now() + 15000;
    while (!fs.existsSync(process.env.ROOM_TEST_BARRIER)) {
      if (Date.now() > until) throw Error('barrier timed out');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    writeAtomic(process.env.ROOM_TEST_FILE, {writer: process.env.ROOM_TEST_WRITER});`
  const children = ['one', 'two'].map(writer => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, '--input-type=module', '-e', script], {
      env: { ...process.env, ROOM_TEST_BARRIER: barrier, ROOM_TEST_FILE: file, ROOM_TEST_WRITER: writer },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], timeout: 40_000,
    })
    let stderr = ''
    child.stderr!.on('data', chunk => { stderr += chunk })
    const ready = new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve())
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`writer exited before barrier (${code}): ${stderr}`)))
    })
    const done = new Promise<{ code: number | null; signal: string | null; stderr: string }>(resolve => {
      child.once('close', (code, signal) => resolve({ code, signal, stderr }))
    })
    return { child, ready, done }
  })
  try {
    await Promise.all(children.map(child => child.ready))
    fs.writeFileSync(barrier, '')
    for (const result of await Promise.all(children.map(child => child.done))) expect(result, result.stderr).toMatchObject({ code: 0, signal: null })
    expect(['one', 'two']).toContain(JSON.parse(fs.readFileSync(file, 'utf8')).writer)
    for (const target of [path.dirname(file), file]) {
      const acl = windowsAcl(target)
      expect(acl.grants.length).toBeGreaterThan(0)
      expect(acl.grants.filter(sid => ![acl.user, 'S-1-5-18', 'S-1-5-32-544'].includes(sid))).toEqual([])
    }
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill()
    await Promise.all(children.map(child => child.done))
  }
}, 90_000) // two bounded ACL inspections after children finish, in addition to cold native writer startup

it.runIf(process.platform === 'win32')('surfaces Windows create denial below an existing root', () => {
  const dir = setup(), parent = path.join(dir, 'denied')
  fs.mkdirSync(parent)
  const { user } = windowsAcl(parent)
  // WD creates files; AD creates subdirectories. Deny only this parent so cleanup can remove the ACE.
  execFileSync('icacls', [parent, '/deny', `*${user}:(WD,AD)`], { stdio: 'pipe' })
  try {
    expect(() => writeAtomic(path.join(parent, 'new', 'nested', 'record.json'), {})).toThrow()
    expect(fs.existsSync(path.join(parent, 'new'))).toBe(false)
  } finally { execFileSync('icacls', [parent, '/remove:d', `*${user}`], { stdio: 'pipe' }) }
}, 30_000)

// Observe actual fsync calls without replacing their durability effect.
function syncedDirectories(): string[] {
  const opened = new Map<number, string>(), synced: string[] = []
  const open = fs.openSync.bind(fs), sync = fs.fsyncSync.bind(fs), close = fs.closeSync.bind(fs)
  vi.spyOn(fs, 'openSync').mockImplementation((target, flags, mode) => {
    const fd = open(target, flags, mode)
    if (fs.fstatSync(fd).isDirectory()) opened.set(fd, String(target))
    return fd
  })
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { if (opened.has(fd)) synced.push(opened.get(fd)!); sync(fd) })
  vi.spyOn(fs, 'closeSync').mockImplementation(fd => { opened.delete(fd); close(fd) })
  return synced
}

// Native Windows rejects opening directories for fsync; POSIX tests assert the actual calls.
it.skipIf(process.platform === 'win32').each(['replace-ancestor', 'replace-root', 'reinsert', 'inode-reuse'])('syncs the current namespace after %s', mutation => {
  const dir = setup(), state = path.join(dir, 'room'), ancestor = path.join(state, 'a'), leaf = path.join(ancestor, 'b'), file = path.join(leaf, 'record.json')
  writeAtomic(file, { n: 1 })
  const original = fs.statSync(leaf, { bigint: true })
  if (mutation === 'replace-ancestor') {
    fs.renameSync(ancestor, path.join(dir, 'old-a'))
    fs.mkdirSync(ancestor)
    fs.renameSync(path.join(dir, 'old-a', 'b'), leaf)
    expect(fs.statSync(leaf, { bigint: true }).ino).toBe(original.ino)
  } else if (mutation === 'replace-root') {
    fs.renameSync(state, path.join(dir, 'old-room'))
    fs.mkdirSync(state)
    fs.renameSync(path.join(dir, 'old-room', 'a'), ancestor)
    expect(fs.statSync(leaf, { bigint: true }).ino).toBe(original.ino)
  } else if (mutation === 'reinsert') {
    fs.renameSync(leaf, path.join(dir, 'aside'))
    fs.renameSync(path.join(dir, 'aside'), leaf)
    expect(fs.statSync(leaf, { bigint: true }).ino).toBe(original.ino)
  } else {
    fs.rmSync(ancestor, { recursive: true })
    fs.mkdirSync(leaf, { recursive: true })
    // Deterministic inode reuse: a leaf-identity cache must not bless these new namespace entries.
    const stat = fs.statSync.bind(fs)
    vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, options: any) =>
      String(target) === leaf && options?.bigint ? original : stat(target, options)) as typeof fs.statSync)
  }
  const synced = syncedDirectories()
  writeAtomic(file, { n: 2 })
  expect(synced).toContain(dir) // room's entry
  expect(synced).toContain(state) // a's entry
  expect(synced).not.toContain(path.dirname(dir)) // repository location is outside Room ownership
  expect(synced).toContain(ancestor) // b's entry
  expect(synced).toContain(leaf) // record's entry
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ n: 2 })
  synced.length = 0
  writeAtomic(file, { n: 3 })
  // Even unchanged leaf identity cannot exclude namespace mutation by another process.
  expect(synced).toContain(dir)
  expect(synced).toContain(state)
  expect(synced).not.toContain(path.dirname(dir))
  expect(synced).toContain(ancestor)
})
