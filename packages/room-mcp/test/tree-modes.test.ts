import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { gitTreeModes } from '../src/tools/files.js'

it('round-trips a tracked filename containing a tab through NUL-framed tree modes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-tree-modes-'))
  const name = 'a\tb.txt'
  try {
    execFileSync('git', ['init', '-q', dir])
    fs.writeFileSync(path.join(dir, name), 'contents')
    execFileSync('git', ['-C', dir, 'add', '--', name])
    execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'])
    expect((await gitTreeModes(dir, 'HEAD')).get(name)).toBe(0o644)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
