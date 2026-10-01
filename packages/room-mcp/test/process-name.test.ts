import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { linuxProcessName, type ProcessReaders } from '@room/relay/process'
import { probeProcess, workerProcessOwnership } from '../src/worker-process.js'
import { boundSession, writeSessionRecord } from '../src/session.js'

const HOOKS = path.resolve(__dirname, '../../../plugins/room/hooks')
const BOOT = 'boot-1'
const stat = (pid: number, ppid: number, start: number) => `${pid} (x) S ${ppid} ${Array(17).fill('0').join(' ')} ${start} 0`

interface Proc { ppid: number; start: number; comm?: string; cmdline?: string[]; exe?: string }
/** A Linux /proc for injected readers: a missing field throws like an unreadable file. */
function fixture(procs: Record<number, Proc>): ProcessReaders & { readDir(dir: string): string[] } {
  const field = (file: string) => {
    if (file === '/proc/sys/kernel/random/boot_id') return `${BOOT}\n`
    const m = /^\/proc\/(\d+)\/(stat|comm|cmdline|exe)$/.exec(file)
    const p = m && procs[Number(m[1])]
    if (!p) throw Object.assign(new Error(`ENOENT ${file}`), { code: 'ENOENT' })
    const value = m[2] === 'stat' ? stat(Number(m[1]), p.ppid, p.start)
      : m[2] === 'comm' ? (p.comm === undefined ? undefined : `${p.comm}\n`)
        : m[2] === 'cmdline' ? (p.cmdline === undefined ? undefined : p.cmdline.map(a => `${a}\0`).join(''))
          : p.exe
    if (value === undefined) throw Object.assign(new Error(`EACCES ${file}`), { code: 'EACCES' })
    return value
  }
  return {
    platform: 'linux',
    readFile: field,
    readLink: field,
    readDir: () => ['self', ...Object.keys(procs)],
    exec: () => { throw new Error('no exec on Linux') },
  }
}

// The native installer links ~/.local/bin/claude to ~/.local/share/claude/versions/<version>.
const nativeClaude: Proc = { ppid: 1, start: 500, comm: 'claude', cmdline: ['claude', '--print', 'hi'], exe: '/home/u/.local/share/claude/versions/2.1.286' }
const cases: Array<[string, Proc, string | undefined]> = [
  ['native Claude, invoked through its symlink', nativeClaude, 'claude'],
  ['native Claude after an update deleted its version file', { ...nativeClaude, exe: `${nativeClaude.exe} (deleted)` }, 'claude'],
  ['native Claude started by its version path', { ...nativeClaude, comm: '2.1.286', cmdline: [nativeClaude.exe!] }, 'claude'],
  ['native Claude with comm unreadable', { ...nativeClaude, comm: undefined }, 'claude'],
  ['native Claude with only the executable readable', { ...nativeClaude, comm: undefined, cmdline: undefined }, 'claude'],
  ['a node-hosted script', { ppid: 1, start: 1, comm: 'node', cmdline: ['node', '/opt/room/server/index.js'], exe: '/usr/local/bin/node' }, 'node'],
  ['a node script run through #!/usr/bin/env node', { ppid: 1, start: 1, comm: 'node', cmdline: ['node', '/usr/lib/node_modules/@openai/codex/bin/codex.js'], exe: '/usr/bin/node' }, 'node'],
  ['native Codex', { ppid: 1, start: 1, comm: 'codex', cmdline: ['/usr/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/codex/codex', 'exec'], exe: '/usr/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/codex/codex' }, 'codex'],
  ['a name the kernel truncated to 15 characters', { ppid: 1, start: 1, comm: 'codex-x86_64-un', cmdline: ['/opt/codex-x86_64-unknown-linux-musl', 'exec'], exe: '/opt/codex-x86_64-unknown-linux-musl' }, 'codex-x86_64-unknown-linux-musl'],
  ['a 15-character name whose argv[0] is unrelated', { ppid: 1, start: 1, comm: 'abcdefghijklmno', cmdline: ['renamed'], exe: '/bin/abcdefghijklmnop' }, 'abcdefghijklmno'],
  ['an unrelated version-named executable', { ppid: 1, start: 1, comm: '1.2.3', cmdline: ['./1.2.3'], exe: '/opt/tool/versions/1.2.3' }, '1.2.3'],
  ['nothing readable', { ppid: 1, start: 1 }, undefined],
]

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe('Linux process naming (relay probeProcess and hooks processChain share one rule)', () => {
  it.each(cases)('names %s', async (_label, proc, expected) => {
    const readers = fixture({ 42: proc })
    const relay = probeProcess(42, readers)
    const hook = await import(path.join(HOOKS, 'common.mjs'))
    const chain = hook.processChain(42, 1, readers)
    expect(relay).toEqual({ startTime: `linux:${BOOT}:${proc.start}`, executable: expected })
    expect(chain).toEqual([{ pid: 42, startTime: `linux:${BOOT}:${proc.start}`, executable: expected }])
  })

  it('keeps the hook copy of the rule identical to the relay one', async () => {
    const hook = await import(path.join(HOOKS, 'common.mjs'))
    for (const [label, proc] of cases) {
      const read = (value: string | undefined) => () => { if (value === undefined) throw new Error('unreadable'); return value }
      const files = { comm: read(proc.comm === undefined ? undefined : `${proc.comm}\n`), cmdline: read(proc.cmdline?.map(a => `${a}\0`).join('')), exe: read(proc.exe) }
      expect(hook.linuxProcessName(files), label).toBe(linuxProcessName(files))
    }
  })

  it('walks the hook chain by parent pid with the same names', async () => {
    const readers = fixture({
      300: { ppid: 200, start: 3, comm: 'node', cmdline: ['node', '/plugins/room/hooks/session-start.mjs'], exe: '/usr/bin/node' },
      200: { ppid: 100, start: 2, comm: 'claude', cmdline: ['claude'], exe: '/home/u/.local/share/claude/versions/2.1.286' },
      100: { ppid: 1, start: 1, comm: 'bash', cmdline: ['-bash'], exe: '/usr/bin/bash' },
    })
    const hook = await import(path.join(HOOKS, 'common.mjs'))
    expect(hook.processChain(200, 8, readers)).toEqual([
      { pid: 200, startTime: `linux:${BOOT}:2`, executable: 'claude' },
      { pid: 100, startTime: `linux:${BOOT}:1`, executable: 'bash' },
    ])
  })

  it('treats a live native Linux Claude worker as ours', () => {
    const readers = fixture({ 42: nativeClaude })
    const rec = { host: 'claude' as const, processStartTime: `linux:${BOOT}:500` }
    expect(workerProcessOwnership(42, rec, pid => probeProcess(pid, readers))).toBe('ours')
    expect(workerProcessOwnership(42, { ...rec, host: 'codex' }, pid => probeProcess(pid, readers))).toBe('not-ours')
  })

  it('binds the MCP to the session the hook recorded for a native Linux Claude', async () => {
    const readers = fixture({ 42: nativeClaude })
    const hook = await import(path.join(HOOKS, 'common.mjs'))
    const commonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-process-name-')); dirs.push(commonDir)
    writeSessionRecord(commonDir, { session_id: 'native-claude', host: 'claude', cwd: commonDir, at: 1, chain: hook.processChain(42, 8, readers), hostPid: 42 })
    // No host hint: the parent's name alone must say Claude, and its identity must match the hook's record.
    const { startTime, executable } = probeProcess(42, readers)!
    expect(boundSession({ commonDir, parent: { pid: 42, startTime: startTime!, executable: executable! }, env: {} })).toEqual({ id: 'native-claude', host: 'claude' })
  })
})
