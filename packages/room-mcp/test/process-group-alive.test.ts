import { describe, expect, it, vi } from 'vitest'
import { processAlive, processGroupAlive, readProcessGroupTable } from '../src/preview-cache.js'
import { windowsChildRunning } from '../src/worker-process.js'

describe('process group liveness treats zombies as gone', () => {
  const table = (rows: { pgid: number; stat: string }[]) => async () => rows
  it('a group whose only members are zombies is not alive', async () => {
    expect(await processGroupAlive(4242, table([{ pgid: 4242, stat: 'Z+' }, { pgid: 4242, stat: 'Z' }, { pgid: 1, stat: 'Ss' }]))).toBe(false)
  })
  it('a group with one running member is alive, whatever its other members', async () => {
    expect(await processGroupAlive(4242, table([{ pgid: 4242, stat: 'Z' }, { pgid: 4242, stat: 'S+' }]))).toBe(true)
  })
  it('an absent group is not alive', async () => {
    expect(await processGroupAlive(4242, table([{ pgid: 1, stat: 'Ss' }]))).toBe(false)
  })
  it('falls back to the signal probe when the process table cannot be read', async () => {
    const { spawn } = await import('node:child_process')
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    try {
      const unreadable = async () => { throw new Error('ps unavailable') }
      expect(await processGroupAlive(child.pid!, unreadable)).toBe(true)
      child.kill('SIGKILL'); await exited
      expect(await processGroupAlive(child.pid!, unreadable)).toBe(false)
    } finally { child.kill('SIGKILL') }
  })
  it('a single process that is a zombie is not alive; a running one is', async () => {
    expect(await processAlive(99, async () => [{ pid: 99, stat: 'Z' }])).toBe(false)
    expect(await processAlive(99, async () => [{ pid: 99, stat: 'R+' }])).toBe(true)
    expect(await processAlive(99, async () => [])).toBe(false)
  })
  it.runIf(process.platform !== 'win32')('reads the real process table and sees this process group', async () => {
    const rows = await readProcessGroupTable()
    expect(rows.length).toBeGreaterThan(0)
    expect(await processGroupAlive(process.pid)).toBe((() => { try { process.kill(-process.pid, 0); return true } catch { return false } })())
  })
})

it.each(['EINVAL', 'EPERM', 'EIO', 'ESRCH'])('only ESRCH proves death when ps fails: %s', async code => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(code), { code }) })
  const table = async () => { throw new Error('unreadable') }
  try {
    expect(await processAlive(123, table)).toBe(code !== 'ESRCH')
    expect(await processGroupAlive(123, table)).toBe(code !== 'ESRCH')
  } finally { kill.mockRestore() }
})
it('does not probe malformed process or group IDs', async () => {
  const table = vi.fn(async () => [])
  const kill = vi.spyOn(process, 'kill')
  try {
    for (const pid of [0, -1, 1.5, 2147483648]) {
      expect(await processAlive(pid, table)).toBe(true)
      expect(await processGroupAlive(pid, table)).toBe(true)
    }
    expect(table).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  } finally { kill.mockRestore() }
})

describe('windowsChildRunning', () => {
  const live = { pid: 4242, exitCode: null, signalCode: null }
  const fails = (code: string) => () => { throw Object.assign(new Error(code), { code }) }
  it('treats only ESRCH as exited; EPERM and other probe errors leave the child running', () => {
    expect(windowsChildRunning(live, fails('ESRCH'))).toBe(false)
    expect(windowsChildRunning(live, fails('EPERM'))).toBe(true)
    expect(windowsChildRunning(live, fails('EINVAL'))).toBe(true)
    expect(windowsChildRunning(live, () => true)).toBe(true)
  })
  it('reports an observed exit without probing, and never probes a missing or invalid pid', () => {
    const probe = vi.fn()
    expect(windowsChildRunning({ ...live, exitCode: 0 }, probe)).toBe(false)
    expect(windowsChildRunning({ ...live, signalCode: 'SIGTERM' }, probe)).toBe(false)
    expect(windowsChildRunning({ pid: undefined, exitCode: null, signalCode: null }, probe)).toBe(true)
    expect(windowsChildRunning({ pid: -1, exitCode: null, signalCode: null }, probe)).toBe(true)
    expect(probe).not.toHaveBeenCalled()
  })
})
