import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { git, gitStream, withGitReadDeadline } from '../src/git.js'

it.skipIf(process.env.TEST_SCALE !== '1').each(['git', 'gitStream'] as const)('kills a cancelled shadow %s read even when its child ignores SIGTERM', async kind => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rev35-cancel-'))
  const pidfile = path.join(root, 'pid')
  const originalPath = process.env.PATH
  let pid: number | undefined
  fs.writeFileSync(path.join(root, 'git'), `#!/usr/bin/env node\nprocess.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidfile)}, String(process.pid)); setInterval(() => {}, 100);\n`, { mode: 0o755 })
  process.env.PATH = root + path.delimiter + originalPath
  const controller = new AbortController()
  const pending = withGitReadDeadline(performance.now() + 3000, async () => kind === 'git' ? git(root, ['--version']) : gitStream(root, ['--version'], '', { timeoutMs: 3000, maxBytes: 1024 }), controller.signal)
  const outcome = pending.then(() => 'resolved', () => 'rejected')
  try {
    await expect.poll(() => fs.existsSync(pidfile), { timeout: 2000 }).toBe(true)
    pid = Number(fs.readFileSync(pidfile, 'utf8'))
    controller.abort()
    // Allow the ordinary two-second hard-kill grace used by gitStream, plus margin.
    await new Promise(resolve => setTimeout(resolve, 3400))
    let alive = true
    try { process.kill(pid, 0) } catch { alive = false }
    expect(alive, 'cancelled private Git child is still alive').toBe(false)
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ } }
    await outcome
    process.env.PATH = originalPath
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it.skipIf(process.env.TEST_SCALE !== '1').each(['git', 'gitStream'] as const)('hard-kills a deadline-expired %s child that ignores SIGTERM', async kind => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-expiry-')), pidfile = path.join(root, 'pid')
  const originalPath = process.env.PATH
  let pid: number | undefined
  fs.writeFileSync(path.join(root, 'git'), `#!/usr/bin/env node\nprocess.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidfile)}, String(process.pid)); setInterval(() => {}, 100);\n`, { mode: 0o755 })
  process.env.PATH = root + path.delimiter + originalPath
  const outcome = withGitReadDeadline(performance.now() + 1200, () => kind === 'git' ? git(root, ['--version']) : gitStream(root, ['--version'], '', { timeoutMs: 3000, maxBytes: 1024 })).then(() => 'resolved', () => 'rejected')
  try {
    await expect.poll(() => fs.existsSync(pidfile), { timeout: 1000 }).toBe(true)
    pid = Number(fs.readFileSync(pidfile, 'utf8'))
    expect(await outcome).toBe('rejected')
    await expect.poll(() => { try { process.kill(pid!, 0); return false } catch { return true } }, { timeout: 2000 }).toBe(true)
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ } }
    await outcome; process.env.PATH = originalPath; fs.rmSync(root, { recursive: true, force: true })
  }
})
