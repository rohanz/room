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
