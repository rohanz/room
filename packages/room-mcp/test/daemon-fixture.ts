import fs from 'node:fs'
import path from 'node:path'
import * as relay from '@room/relay'
import { readRelayInfo, stopLocalDaemon } from '@room/relay'
import { liveness } from '@room/relay/leases'
import { pidAlive } from '@room/relay/process'
import { beforeEach, vi } from 'vitest'

const started = new Map<string, string>()
const canonical = (common: string) => fs.realpathSync.native(common)

/** Call only at a fixture's known child launch, before another client can replace its daemon. */
export function recordTestDaemon(common: string): void {
  const record = readRelayInfo(common)
  if (record?.runtime === 'daemon' && record.nonce && record.pid !== process.pid) started.set(canonical(common), record.nonce)
}

// Calls from session/preview code stay real; record a start, never adoption of an existing instance.
const ensure = relay.ensureLocalDaemon
beforeEach(() => {
  vi.spyOn(relay, 'ensureLocalDaemon').mockImplementation(async (...args) => {
    const daemon = await ensure(...args)
    const after = readRelayInfo(args[0])
    if (daemon.launched && after?.runtime === 'daemon' && after.nonce && after.pid === daemon.pid && after.pid !== process.pid) {
      started.set(canonical(args[0]), after.nonce)
    }
    return daemon
  })
})

/** Test-owned clones only. Maintenance verifies identity, saves and waits for process exit. */
export async function stopTestDaemon(common: string): Promise<boolean> {
  const record = readRelayInfo(common)
  if (record?.runtime !== 'daemon') return true
  const nonce = started.get(canonical(common))
  const exited = () => !pidAlive(record.pid) || !!record.lead && record.lead !== true && liveness(record.lead) === 'dead'
  if (exited()) { started.delete(canonical(common)); return true }
  if (!nonce || record.nonce !== nonce || record.pid === process.pid) return false
  // A test closes its MCP clients just before cleanup; the daemon sees those sockets close a moment later and
  // rightly refuses to stop while writers remain. Wait (bounded) for the test's own disconnects to land.
  const until = Date.now() + 10_000
  for (;;) {
    try { if (await stopLocalDaemon(common, undefined, nonce) === 'different daemon instance') return false; break }
    catch (error) {
      if (exited()) break // Another fixture cleanup may have just stopped it.
      if (!/active writers/.test(String(error)) || Date.now() >= until) throw error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  started.delete(canonical(common))
  return true
}

/** Find every independent clone under a fixture's owned root; never follow links outside it. */
export async function stopTestDaemons(root: string): Promise<boolean> {
  const pending = [root]
  let safe = true
  while (pending.length) {
    const dir = pending.pop()!
    let entries: fs.Dirent[]
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === '.git') { if (!await stopTestDaemon(path.join(dir, entry.name))) safe = false }
      else if (entry.name !== 'node_modules') pending.push(path.join(dir, entry.name))
    }
  }
  return safe
}
