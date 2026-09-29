import type { Liveness, ProcessIdentity } from '../../src/leases.js'

// Synthetic worker handles have no OS process. Registry snapshots and projectors must see
// the same facts as a tool's process probe, regardless of PID reuse on the test host.
const processes = new Map<number, { identity: ProcessIdentity; live: boolean }>()
let serial = 0

export function spawnFixtureProcess(pid: number, executable = 'node'): ProcessIdentity {
  return fixtureProcess(pid, `fixture:spawn:${++serial}`, executable)
}

export function fixtureProcess(pid: number, startTime: string, executable: string, live = true): ProcessIdentity {
  const identity = { pid, startTime, executable }
  processes.set(pid, { identity, live })
  return identity
}

export function finishFixtureProcess(pid: number): void {
  const process = processes.get(pid)
  if (process) process.live = false
}

export function clearFixtureProcesses(): void { processes.clear(); serial = 0 }

export function fixtureProbe(pid: number): { startTime: string; executable: string } | undefined {
  const process = processes.get(pid)
  return process?.live ? { startTime: process.identity.startTime, executable: process.identity.executable } : undefined
}

export function fixtureLiveness(identity: ProcessIdentity, actual: (identity: ProcessIdentity) => Liveness): Liveness {
  // The test runner itself cannot exit while these assertions run. A host process probe
  // (ps on macOS) can fail under concurrent suites, which must not turn the registry's
  // launcher into a dead process. Synthetic identities at this PID still use the map.
  if (identity.pid === process.pid && !identity.startTime.startsWith('fixture:')) return 'alive'
  const observed = processes.get(identity.pid)
  if (!observed && !identity.startTime.startsWith('fixture:')) return actual(identity)
  return observed?.live && observed.identity.startTime === identity.startTime && observed.identity.executable === identity.executable
    ? 'alive' : 'dead'
}
