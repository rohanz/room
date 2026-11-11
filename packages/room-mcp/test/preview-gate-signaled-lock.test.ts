import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const helper = vi.hoisted(() => ({ die: undefined as undefined | (() => void) }))
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    if (!['lockf', 'flock'].includes(String(args[0]))) return actual.spawn(...args)
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(),
      exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    })
    // Node keeps exitCode null when a child exits because of a signal, including
    // after close. Deliver the complete lifecycle before release is called.
    helper.die = () => {
      child.signalCode = 'SIGKILL'
      child.stdin.destroy(); child.stdout.destroy()
      child.emit('exit', null, 'SIGKILL')
      child.emit('close', null, 'SIGKILL')
    }
    setImmediate(() => child.stdout.write('READY'))
    return child
  } }
})
import { tryPreviewLock } from '../src/preview-cache.js'

it.skipIf(!['darwin', 'linux'].includes(process.platform))('release settles after a signaled lock helper has already closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'room-review-signaled-lock-'))
  let deadline: NodeJS.Timeout | undefined
  try {
    const unlock = await tryPreviewLock(path.join(root, 'entry'))
    expect(unlock).toBeDefined()
    helper.die!()
    expect(() => unlock!.assertOwned()).toThrow('ownership lost')
    const outcome = await Promise.race([
      unlock!().then(() => 'released'),
      new Promise<string>(resolve => { deadline = setTimeout(() => resolve('still waiting for an already delivered close'), 100) }),
    ])
    expect(outcome).toBe('released')
  } finally { clearTimeout(deadline); await rm(root, { recursive: true, force: true }) }
})
