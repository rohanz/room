import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { materializeGitTree } from '../src/tools/files.js'

const pipeFault = vi.hoisted(() => ({ code: '' }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args)
      if (args[0] === 'tar' && pipeFault.code) {
        const code = pipeFault.code
        process.nextTick(() => child.stdin?.emit('error', Object.assign(new Error('injected pipe disconnect'), { code })))
      }
      return child
    },
  }
})

it.each([0, 1])('decides an ENOTCONN pipe error by tar exit %i', async tarCode => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-archive-enotconn-'))
  const bin = path.join(dir, 'bin'), repo = path.join(dir, 'repo'), destination = path.join(dir, 'out')
  fs.mkdirSync(bin); fs.mkdirSync(repo); fs.mkdirSync(destination)
  fs.writeFileSync(path.join(bin, 'tar'), `#!/bin/sh\nsleep 0.05\nexit ${tarCode}\n`, { mode: 0o755 })
  execFileSync('git', ['init', '-q', repo])
  fs.writeFileSync(path.join(repo, 'file.txt'), 'content')
  execFileSync('git', ['-C', repo, 'add', 'file.txt'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'])
  const ref = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  pipeFault.code = 'ENOTCONN'
  try {
    if (tarCode === 0) await expect(materializeGitTree(repo, ref, destination)).resolves.toBeUndefined()
    else await expect(materializeGitTree(repo, ref, destination)).rejects.toThrow(/could not materialize/)
  } finally {
    pipeFault.code = ''
    vi.unstubAllEnvs()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

it('contains an early tar exit while git archive is piping', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-archive-signal-'))
  const bin = path.join(dir, 'bin'), repo = path.join(dir, 'repo'), destination = path.join(dir, 'out')
  fs.mkdirSync(bin); fs.mkdirSync(repo); fs.mkdirSync(destination)
  fs.writeFileSync(path.join(bin, 'tar'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  execFileSync('git', ['init', '-q', repo])
  fs.writeFileSync(path.join(repo, 'large.txt'), 'x'.repeat(1024 * 1024))
  execFileSync('git', ['-C', repo, 'add', 'large.txt'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'])
  const ref = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  try { await expect(materializeGitTree(repo, ref, destination)).rejects.toThrow() }
  finally { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }) }
})

it('accepts a successful consumer that closes the archive pipe early', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-archive-early-success-'))
  const bin = path.join(dir, 'bin'), repo = path.join(dir, 'repo'), destination = path.join(dir, 'out')
  fs.mkdirSync(bin); fs.mkdirSync(repo); fs.mkdirSync(destination)
  fs.writeFileSync(path.join(bin, 'tar'), '#!/bin/sh\ndd bs=1024 count=1 of=/dev/null 2>/dev/null\nexit 0\n', { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nif [ "$3" = archive ]; then /usr/bin/git "$@" || :; exit 0; fi\nexec /usr/bin/git "$@"\n', { mode: 0o755 })
  execFileSync('git', ['init', '-q', repo])
  fs.writeFileSync(path.join(repo, 'large.txt'), 'x'.repeat(1024 * 1024))
  execFileSync('git', ['-C', repo, 'add', 'large.txt'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'])
  const ref = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  try { await expect(materializeGitTree(repo, ref, destination)).resolves.toBeUndefined() }
  finally { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }) }
})

it('reports tar exit without waiting for a descendant holding its stderr open', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-archive-held-stderr-'))
  const bin = path.join(dir, 'bin'), repo = path.join(dir, 'repo'), destination = path.join(dir, 'out')
  const childPidFile = path.join(dir, 'sleep.pid')
  fs.mkdirSync(bin); fs.mkdirSync(repo); fs.mkdirSync(destination)
  fs.writeFileSync(path.join(bin, 'tar'), `#!/bin/sh\nsleep 30 >&2 &\necho $! > '${childPidFile}'\nexit 1\n`, { mode: 0o755 })
  execFileSync('git', ['init', '-q', repo])
  fs.writeFileSync(path.join(repo, 'file.txt'), 'content')
  execFileSync('git', ['-C', repo, 'add', 'file.txt'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'])
  const ref = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await expect(Promise.race([
      materializeGitTree(repo, ref, destination),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('waited for inherited stderr')), 10_000) }),
    ])).rejects.toThrow(/could not materialize/)
  } finally {
    if (deadline) clearTimeout(deadline)
    if (fs.existsSync(childPidFile)) {
      const pid = Number(fs.readFileSync(childPidFile, 'utf8').trim())
      try { process.kill(pid, 'SIGTERM') } catch { /* child already exited */ }
      // The exited tar shell cannot wait for its orphan; wait for the OS to reap it.
      for (let i = 0; i < 50; i++) {
        let state: string
        try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim() }
        catch { break }
        if (!state || state.startsWith('Z')) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true })
  }
})

it('drains git when tar exits before the first archive write', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-archive-exit-first-'))
  const bin = path.join(dir, 'bin'), repo = path.join(dir, 'repo'), destination = path.join(dir, 'out')
  fs.mkdirSync(bin); fs.mkdirSync(repo); fs.mkdirSync(destination)
  fs.writeFileSync(path.join(bin, 'tar'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nif [ "$3" = archive ]; then sleep 0.2; dd if=/dev/zero bs=65536 count=32 2>/dev/null; exit 0; fi\nexec /usr/bin/git "$@"\n', { mode: 0o755 })
  execFileSync('git', ['init', '-q', repo])
  fs.writeFileSync(path.join(repo, 'file.txt'), 'content')
  execFileSync('git', ['-C', repo, 'add', 'file.txt'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'])
  const ref = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await expect(Promise.race([
      materializeGitTree(repo, ref, destination),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('archive pipe stayed paused')), 10_000) }),
    ])).rejects.toThrow(/could not materialize/)
  } finally {
    if (deadline) clearTimeout(deadline)
    vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true })
  }
})
