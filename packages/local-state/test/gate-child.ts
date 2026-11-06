/** Subprocess fixture for gate-process.test.ts; only that test owns and kills these exact pids. */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { openStorageGate } from '../src/gate.js'
import { createExclusive } from '../src/leases.js'
import { probeOwnProcess } from '../src/process.js'
import { STORAGE_PATHS, StorageRefused } from '../src/protocol.js'

const [mode, dir, ...rest] = process.argv.slice(2)
const own = probeOwnProcess()
const instance = { pid: process.pid, startTime: own?.startTime ?? '', executable: own?.executable ?? '', sessionId: `child:${process.pid}`, nonce: randomBytes(16).toString('hex') }
const gate = openStorageGate(dir)
const send = (value: object) => new Promise<void>(resolve => process.send!(value, () => resolve()))
const waitFor = async (file: string) => { while (!fs.existsSync(file)) await new Promise(resolve => setTimeout(resolve, 2)) }

if (mode === 'init') {
  await waitFor(rest[0])
  const registration = await gate.register({ instance, kind: 'mcp', release: 'child' })
  const record = JSON.parse(fs.readFileSync(path.join(gate.commonDir, STORAGE_PATHS.gate), 'utf8'))
  await send({ generation: registration.generation, cloneId: record.cloneId })
  process.disconnect()
} else if (mode === 'owner') {
  const [token, publish] = rest
  if (!createExclusive(path.join(gate.commonDir, STORAGE_PATHS.migrationLock), instance)) throw new Error('lock held')
  await gate.register({ instance, kind: 'maintenance', release: 'child' })
  const progress = publish === 'publish' ? await gate.drain({ instance, token }) : undefined
  await send({ ready: true, instance, generation: progress?.generation })
  setInterval(() => {}, 1000) // held until the test kills or resumes this process
} else if (mode === 'admitter') {
  const stop = rest[0]
  const registration = await gate.register({ instance, kind: 'mcp', release: 'child' })
  const admitted: number[] = [], refused: string[] = []
  await send({ ready: true })
  while (!fs.existsSync(stop)) {
    try { const ticket = await gate.admit(registration, 'collect'); admitted.push(ticket.generation); await gate.finish(ticket) }
    catch (error) { if (!(error instanceof StorageRefused)) throw error; refused.push(error.reason); await new Promise(resolve => setTimeout(resolve, 1)) }
  }
  await send({ admitted, refused })
  process.disconnect()
} else throw new Error(`unknown mode ${mode}`)
