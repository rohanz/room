/** Explicit legacy maintenance owner. Runtime preflight belongs to the executable entry wrapper. */
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { openStorageGate, FileStorageGate, canonicalCommonDir } from '@room/local-state/gate'
import { compareAndRelease, createExclusive, recover, type InstanceToken } from '@room/local-state/leases'
import { GATE_LIMITS, STORAGE_PATHS, StorageRefused, type GateOwner, type StorageGate } from '@room/local-state/protocol'
import { storageInstance } from '../storage-admission.js'
import { importBudget, importLegacyWorkers, legacyImportRequired, legacyImportRemedy, preRegistryImportRequired, type LegacySource } from './legacy-import.js'
import manifest from '../../../../plugins/room/.claude-plugin/plugin.json' with { type: 'json' }

const pause = () => new Promise<void>(resolve => setTimeout(resolve, 25))
export async function legacyStatus(commonDir: string) {
  const gate = openStorageGate(commonDir), status = await gate.status()
  const required = legacyImportRequired(gate.commonDir, status.legacyImport, status.gate)
  return { ...status, maintenanceRequired: status.maintenanceRequired || required,
    ...(status.refusal ? { remedy: status.refusal.remedy ?? status.refusal.detail } : required ? { remedy: legacyImportRemedy(gate.commonDir) } : {}) }
}

/** Keep migration ownership through final reopen; timeout intentionally leaves a draining gate. */
export async function withMaintenance<T>(commonDir: string, fn: (gate: StorageGate, owner: GateOwner) => Promise<T>): Promise<T> {
  const gate = openStorageGate(commonDir), instance: InstanceToken = storageInstance()
  const lock = path.join(gate.commonDir, STORAGE_PATHS.migrationLock)
  const deadline = performance.now() + GATE_LIMITS.migrationLockWaitMs
  let acquired = false
  while (performance.now() < deadline) {
    try {
      if (createExclusive(lock, instance)) { acquired = true; break }
      if (recover(lock, () => true)) continue
    } catch (error) { if (!(error instanceof Error && error.message.startsWith('lease guard busy: '))) throw error }
    await pause()
  }
  if (!acquired) throw new StorageRefused('maintenance', 'migration ownership wait exceeded 30 s; existing owner retained')
  let registration
  try {
    const before = await gate.status()
    const preRegistryImport = before.gate?.preRegistryImport ?? (preRegistryImportRequired(gate.commonDir) ? 'required' : 'not-needed')
    registration = await gate.register({ instance, kind: 'maintenance', release: manifest.version, preRegistryImport })
    const owner = { instance, token: randomBytes(16).toString('hex') }
    const status = await gate.status()
    if (status.gate?.phase === 'draining') await gate.takeOver(owner)
    else await gate.drain(owner)
    try { return await fn(gate, owner) }
    catch (error) {
      const latest = await gate.status()
      if (latest.gate?.phase === 'draining') throw new StorageRefused('maintenance',
        `gate remains draining at generation ${latest.gate.generation}; ${error instanceof StorageRefused ? error.detail : 'maintenance failed'}`.slice(0, 512),
        'after this process exits, run import-legacy (or reopen) from a new room-state.mjs process')
      throw error
    }
  } finally {
    if (registration) await gate.unregister(registration)
    const releaseDeadline = performance.now() + GATE_LIMITS.migrationLockWaitMs
    for (;;) {
      try { compareAndRelease(lock, instance); break }
      catch (error) {
        if (!(error instanceof Error && error.message.startsWith('lease guard busy: ')) || performance.now() >= releaseDeadline) throw error
        await pause()
      }
    }
  }
}

export async function runLegacyImport(commonDir: string, options: { sources?: (commonDir: string) => LegacySource[]; now?: () => number; mono?: () => number } = {}): Promise<void> {
  const budget = importBudget(options.mono)
  await withMaintenance(commonDir, async (gate, owner) => {
    const deadline = performance.now() + GATE_LIMITS.drainMs
    for (;;) {
      budget.check()
      const progress = await gate.drain(owner)
      if (progress.complete) break
      if (performance.now() >= deadline) throw new StorageRefused('maintenance', 'drain timed out; gate remains draining; reconcile outstanding tickets before retrying')
      await pause()
    }
    await importLegacyWorkers(gate.commonDir, owner.instance, { ...options, budget, verify: async () => {
      if (!(await gate.drain(owner)).complete) throw new StorageRefused('maintenance', 'legacy import requires a complete drain')
    } })
    budget.check()
    await gate.reopen(owner, { notAfter: budget.notAfter })
  })
}

export async function main(argv: string[]): Promise<number> {
  try {
    const [command, ...args] = argv
    const allowed = new Set(['--common-dir', ...(command === 'status' ? ['--json'] : []), ...(command === 'repair-location' ? ['--confirm-moved', '--confirm-copied'] : []), ...(command === 'resolve-ticket' ? ['--ticket', '--note'] : [])])
    const flags = new Map<string, string>()
    for (let i = 0; i < args.length; i++) {
      const key = args[i]
      if (!allowed.has(key) || flags.has(key)) throw new Error('invalid or repeated option')
      if (['--json', '--confirm-moved', '--confirm-copied'].includes(key)) flags.set(key, 'true')
      else { const value = args[++i]; if (!value || value.startsWith('--')) throw new Error('missing option value'); flags.set(key, value) }
    }
    const common = flags.get('--common-dir')
    if (!common || !['status', 'import-legacy', 'resolve-ticket', 'reopen', 'repair-location'].includes(command))
      throw new Error('usage: room-state.mjs status|import-legacy|resolve-ticket|reopen|repair-location --common-dir <dir>')
    if (command === 'repair-location') {
      if (flags.has('--confirm-moved') === flags.has('--confirm-copied')) throw new StorageRefused('unavailable', 'repair-location requires exactly one of --confirm-moved or --confirm-copied')
      await new FileStorageGate(canonicalCommonDir(common), {}).repairLocation(flags.has('--confirm-copied') ? 'copied' : 'moved')
      return 0
    }
    if (command === 'status') {
      const inspected = await legacyStatus(common)
      const status = { ...inspected, ticketListing: inspected.refusal && inspected.refusal.reason !== 'maintenance'
        ? { tickets: [], truncated: inspected.tickets > 0 } : await openStorageGate(common).listTickets() }
      process.stdout.write(flags.has('--json') ? `${JSON.stringify(status)}\n`
        : `storage: ${status.gate?.phase ?? status.state}; generation ${status.gate?.generation ?? 0}; registrations ${status.registrations}; tickets ${status.tickets}; legacy import ${status.legacyImport}; maintenance ${status.maintenanceRequired ? 'required' : 'not required'}${status.refusal && status.refusal.detail !== status.remedy ? `\nrefusal: ${status.refusal.detail}` : ''}${status.locationUpdate ? '\nlocation: same directory; canonical path update pending next registration' : ''}${status.remedy ? `\nremedy: ${status.remedy}` : ''}\n${status.ticketListing.tickets.map(ticket => `ticket ${ticket.id}: ${ticket.kind}; generation ${ticket.generation}; pid ${ticket.pid}; ${ticket.holderState}`).join('\n')}${status.ticketListing.truncated ? '\nticket listing truncated' : ''}\n`)
      return status.maintenanceRequired ? 1 : 0
    }
    if (command === 'import-legacy') await runLegacyImport(common)
    else {
      const ticket = flags.get('--ticket'), note = flags.get('--note')
      if (command === 'resolve-ticket' && (!ticket || !note)) throw new Error('resolve-ticket requires --ticket <id> --note <text>')
      await withMaintenance(common, async (gate, owner) => {
        if (command === 'resolve-ticket') await gate.resolveDead(owner, ticket!, note!)
        else {
          const status = await gate.status()
          if (legacyImportRequired(gate.commonDir, status.legacyImport, status.gate))
            throw new StorageRefused('maintenance', 'offline legacy import still required', legacyImportRemedy(gate.commonDir))
          await gate.reopen(owner)
        }
      })
    }
    process.stdout.write(command === 'resolve-ticket' ? 'ticket resolved; gate remains draining\n' : 'storage reopened in legacy mode\n')
    return 0
  } catch (error) {
    const message = error instanceof StorageRefused ? error.message : error instanceof Error && error.message.startsWith('usage:') ? error.message : 'storage maintenance failed; inspect gate status and ownership'
    process.stderr.write(`${message.replace(/[\r\n]/g, ' ').slice(0, 2048)}\n`)
    return 1
  }
}
