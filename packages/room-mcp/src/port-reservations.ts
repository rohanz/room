import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquireOwnedFile } from './owned-file.js'
import { allocateWorkerPort, WORKER_PORT_END, WORKER_PORT_START, type SpawnedProcess } from './workers.js'

export interface PortReservation { port: number; release(): void }

/** Reserve a dev-server port across every Room MCP process on this machine. */
export function reserveWorkerPort(workerId: string, used: Iterable<number> = [], configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), preferredPort?: number): PortReservation {
  const directory = path.join(configHome, 'room', 'ports')
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const occupied = new Set(used)
  const preferred = preferredPort !== undefined && Number.isInteger(preferredPort) && preferredPort >= WORKER_PORT_START && preferredPort <= WORKER_PORT_END && !occupied.has(preferredPort)
    ? preferredPort : undefined
  while (true) {
    const port = preferred !== undefined && !occupied.has(preferred) ? preferred : allocateWorkerPort(occupied)
    occupied.add(port)
    const release = acquireOwnedFile(path.join(directory, String(port)), { pid: process.pid, workerId, startedAt: Date.now() })
    if (release) return { port, release }
  }
}

const processReservations = new WeakMap<SpawnedProcess, () => void>()

/** Keep the reservation until the worker process exits, including a failed start. */
export function bindWorkerPortReservation(proc: SpawnedProcess, reservation: PortReservation): void {
  let released = false
  const release = () => {
    if (released) return
    released = true
    processReservations.delete(proc)
    reservation.release()
  }
  processReservations.set(proc, release)
  const onExit = proc.onExit.bind(proc)
  proc.onExit = cb => onExit(code => { release(); cb(code) })
  if (proc.onError) {
    const onError = proc.onError.bind(proc)
    proc.onError = cb => onError(error => { release(); cb(error) })
  }
}

/** Used when a worker is already gone before a collect, discard or stop observes it. */
export function releaseWorkerProcessPort(proc: SpawnedProcess): void { processReservations.get(proc)?.() }
