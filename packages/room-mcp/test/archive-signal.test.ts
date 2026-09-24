import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { materializeGitTree } from '../src/tools/files.js'

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
  fs.mkdirSync(bin); fs.mkdirSync(repo); fs.mkdirSync(destination)
  fs.writeFileSync(path.join(bin, 'tar'), '#!/bin/sh\nsleep 3 >&2 &\nexit 1\n', { mode: 0o755 })
  execFileSync('git', ['init', '-q', repo])
  fs.writeFileSync(path.join(repo, 'file.txt'), 'content')
  execFileSync('git', ['-C', repo, 'add', 'file.txt'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'])
  const ref = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  try {
    await expect(Promise.race([
      materializeGitTree(repo, ref, destination),
      new Promise((_, reject) => setTimeout(() => reject(new Error('waited for inherited stderr')), 1000)),
    ])).rejects.toThrow(/could not materialize/)
  } finally { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }) }
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
  try {
    await expect(Promise.race([
      materializeGitTree(repo, ref, destination),
      new Promise((_, reject) => setTimeout(() => reject(new Error('archive pipe stayed paused')), 1000)),
    ])).rejects.toThrow(/could not materialize/)
  } finally { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }) }
})
