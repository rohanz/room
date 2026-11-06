import { describe, expect, it, vi } from 'vitest'
import { processAlive, processGroupAlive, readProcessGroupTable } from '../src/preview-cache.js'

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

it('treats only ESRCH as absence when the process table is unreadable', async () => {
  const unreadable = async () => { throw new Error('ps unavailable') }
  const kill = vi.spyOn(process, 'kill')
  try {
    for (const [code, alive] of [['EPERM', true], ['EINVAL', true], ['ESRCH', false]] as const) {
      kill.mockImplementation(() => { throw Object.assign(new Error(code), { code }) })
      expect(await processGroupAlive(424242, unreadable)).toBe(alive)
      expect(await processAlive(424242, unreadable)).toBe(alive)
    }
  } finally { kill.mockRestore() }
})
