// Real Windows OS + owned Node child only: no authenticated Claude/model calls.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { probeProcessNow } from '@room/relay/process'
import { defaultSpawner, quiesceWorktreeProcesses, signalWorker, stopWorkerWithEscalation, terminateWorktreeProcesses } from '../src/worker-process.js'
import { captureOwnedWorkerIdentity } from '../src/worker-launch.js'

describe.skipIf(process.platform !== 'win32')('native Windows process identity and owned child stop', () => {
  it('records birth/executable and hook ancestors; refuses reused identity and stops its retained child', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-win-process-'))
    const child = defaultSpawner({ cmd: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: dir, env: {}, logFile: path.join(dir, 'child.log') })
    let exited = false
    const closed = new Promise<void>(resolve => child.onExit(() => { exited = true; resolve() }))
    const waitClosed = () => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('owned child did not close within five seconds')), 5000)
      closed.then(() => { clearTimeout(timer); resolve() }, error => { clearTimeout(timer); reject(error) })
    })
    try {
      await child.started
      let attempts = 0
      const started = Date.now()
      const info = await captureOwnedWorkerIdentity(child, () => !exited, pid => { attempts++; return probeProcessNow(pid) })
      console.info(`owned Windows identity: ${attempts} attempt(s), ${Date.now() - started} ms`)
      expect(info).toBeDefined()
      if (!info) throw new Error('owned Windows process identity remained unreadable')
      expect(info.executable).toBe('node')
      expect(info.startTime).toMatch(/^windows:/)
      const { processChain } = await import(/* @vite-ignore */ pathToFileURL(path.resolve(__dirname, '../../../plugins/room/hooks/common.mjs')).href)
      expect(processChain(child.pid)[0]).toEqual({ pid: child.pid, ...info })
      expect(signalWorker(child.pid, 'SIGTERM', undefined, undefined, { host: 'codex', processStartTime: `${info.startTime}:reused` })).toBe(false)
      expect(await quiesceWorktreeProcesses(dir)).toBe(false)
      await expect(terminateWorktreeProcesses(dir)).rejects.toThrow('worktree process inspection is unsupported on win32')
      expect(await stopWorkerWithEscalation({ terminate: () => child.kill(), force: () => child.killForce!(), exited: () => exited })).toBe(true)
      await waitClosed()
      expect(probeProcessNow(child.pid)).toBeUndefined()
    } finally {
      child.killForce?.()
      await waitClosed()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
