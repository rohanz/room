import { describe, expect, it } from 'vitest'
import { processGroupAlive, readProcessGroupTable } from '../src/preview-cache.js'

describe('process group liveness treats zombies as gone', () => {
  const table = (rows: { pgid: number; stat: string }[]) => () => rows
  it('a group whose only members are zombies is not alive', () => {
    expect(processGroupAlive(4242, table([{ pgid: 4242, stat: 'Z+' }, { pgid: 4242, stat: 'Z' }, { pgid: 1, stat: 'Ss' }]))).toBe(false)
  })
  it('a group with one running member is alive, whatever its other members', () => {
    expect(processGroupAlive(4242, table([{ pgid: 4242, stat: 'Z' }, { pgid: 4242, stat: 'S+' }]))).toBe(true)
  })
  it('an absent group is not alive', () => {
    expect(processGroupAlive(4242, table([{ pgid: 1, stat: 'Ss' }]))).toBe(false)
  })
  it('falls back to the signal probe when the process table cannot be read', async () => {
    const { spawn } = await import('node:child_process')
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    try {
      const unreadable = () => { throw new Error('ps unavailable') }
      expect(processGroupAlive(child.pid!, unreadable)).toBe(true)
      child.kill('SIGKILL'); await exited
      expect(processGroupAlive(child.pid!, unreadable)).toBe(false)
    } finally { child.kill('SIGKILL') }
  })
  it.runIf(process.platform !== 'win32')('reads the real process table and sees this process group', () => {
    const rows = readProcessGroupTable()
    expect(rows.length).toBeGreaterThan(0)
    expect(processGroupAlive(process.pid)).toBe((() => { try { process.kill(-process.pid, 0); return true } catch { return false } })())
  })
})
