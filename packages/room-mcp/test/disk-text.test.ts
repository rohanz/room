import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { setGitObserver } from '@room/roomd/git'
import { DISK_TEXT_LIMIT, readBoundedCheckoutText, readBoundedDiskText, readBoundedHistoricalText } from '../src/tools/disk-text.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

it('reads at the publication ceiling and rejects a larger local file before decoding it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-disk-text-'))
  dirs.push(dir)
  const file = path.join(dir, 'large.txt')
  fs.writeFileSync(file, 'x'.repeat(DISK_TEXT_LIMIT))
  expect(await readBoundedDiskText(file)).toBe('x'.repeat(DISK_TEXT_LIMIT))
  fs.appendFileSync(file, 'y')
  await expect(readBoundedDiskText(file)).rejects.toThrow('file too large for Room read')
})

it('rejects an ancestor swapped outside the captured root during open', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-disk-race-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'room-disk-outside-'))
  dirs.push(dir, outside)
  fs.mkdirSync(path.join(dir, 'nested'))
  fs.writeFileSync(path.join(dir, 'nested/data.txt'), 'inside')
  fs.writeFileSync(path.join(outside, 'data.txt'), 'outside')
  const file = path.join(dir, 'nested/data.txt')
  const open = fs.promises.open.bind(fs.promises)
  const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    fs.renameSync(path.join(dir, 'nested'), path.join(dir, 'old'))
    fs.symlinkSync(outside, path.join(dir, 'nested'))
    return open(...args)
  })
  try { await expect(readBoundedDiskText(file, 'utf8', { root: dir, path: file })).rejects.toThrow('unsafe') }
  finally { spy.mockRestore() }
})

it('checks historical blob metadata before reading or filtering an oversized old version', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-old-text-'))
  dirs.push(dir)
  const run = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  run('init', '-q'); run('config', 'user.email', 't@t'); run('config', 'user.name', 't')
  fs.writeFileSync(path.join(dir, 'large.txt'), 'x'.repeat(DISK_TEXT_LIMIT + 1))
  run('add', 'large.txt'); run('commit', '-qm', 'base')
  const head = run('rev-parse', 'HEAD')
  const commands: string[] = []
  setGitObserver(args => commands.push(args.join(' ')))
  try {
    await expect(readBoundedHistoricalText(dir, head, 'large.txt')).rejects.toThrow('historical text exceeds')
    await expect(readBoundedCheckoutText(dir, `${head}:large.txt`, 'large.txt')).rejects.toThrow('historical text exceeds')
    expect(commands).toContain('cat-file --batch-check -Z')
    expect(commands).not.toContain('cat-file --batch')
  } finally { setGitObserver(undefined) }
})
