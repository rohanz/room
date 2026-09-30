import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { materializeGitTree } from '../src/tools/files.js'

it('materializes tracked checkout contents, modes and links without a registration', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-checkout-'))
  const repo = path.join(root, 'repo'), destination = path.join(root, 'out')
  fs.mkdirSync(repo); fs.mkdirSync(destination)
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  try {
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
    fs.mkdirSync(path.join(repo, 'tests'))
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'tests/regression.test export-ignore\nsubst.txt export-subst\n')
    fs.writeFileSync(path.join(repo, 'tests', 'regression.test'), 'FAIL')
    fs.writeFileSync(path.join(repo, 'subst.txt'), '$Format:%H$')
    fs.writeFileSync(path.join(repo, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    fs.symlinkSync('run.sh', path.join(repo, 'script-link'))
    git('add', '.'); git('commit', '-qm', 'checkout fixture')
    const ref = git('rev-parse', 'HEAD')
    await materializeGitTree(repo, ref, destination)
    expect(fs.readFileSync(path.join(destination, 'tests', 'regression.test'), 'utf8')).toBe('FAIL')
    expect(fs.readFileSync(path.join(destination, 'subst.txt'), 'utf8')).toBe('$Format:%H$')
    expect(fs.statSync(path.join(destination, 'run.sh')).mode & 0o111).toBe(0o111)
    expect(fs.lstatSync(path.join(destination, 'script-link')).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(path.join(destination, 'script-link'))).toBe('run.sh')
    expect(fs.readdirSync(destination).some(name => name.startsWith('.room-preview-index-'))).toBe(false)
    expect(git('worktree', 'list', '--porcelain')).not.toContain(destination)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}, 30_000)

it('rejects a missing ancestor and removes its temporary index', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-checkout-'))
  const repo = path.join(root, 'repo'), destination = path.join(root, 'out')
  fs.mkdirSync(repo); fs.mkdirSync(destination)
  try {
    execFileSync('git', ['init', '-q', repo])
    await expect(materializeGitTree(repo, '0'.repeat(40), destination)).rejects.toThrow(/could not materialize/)
    expect(fs.readdirSync(destination)).toEqual([])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}, 30_000)
