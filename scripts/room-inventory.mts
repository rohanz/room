/** Operator pre-flight: inspect stored updates without loading or changing source documents. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { LeveldbPersistence } from 'y-leveldb'
import { safeRoomRegistry } from '../packages/server/src/migrate.js'
import { takeInventory, formatInventory } from '../packages/server/src/inventory.js'
import { isLevelProvider, levelDbOf, levelStoredSize } from '../packages/server/src/stored.js'
import type { OpenRepo } from '../packages/server/src/store.js'

const usage = 'Usage: npx tsx scripts/room-inventory.mts <YPERSISTENCE dir> [--registry <rooms.json>] [--budget-mb 32] [--json] [--scratch <path>]'
let scratch: string | undefined
let persistence: LeveldbPersistence | undefined
// Also clean up on an operator interrupt; source files are never removed.
const cleanup = async () => {
  if (persistence) { await persistence.destroy(); persistence = undefined }
  if (scratch) { await fs.rm(scratch, { recursive: true, force: true }); scratch = undefined }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
})

try {
  const args = process.argv.slice(2)
  const sourceArg = args.shift()
  if (!sourceArg || sourceArg.startsWith('--')) throw new Error(usage)
  const source = await fs.realpath(sourceArg)
  let registryFile = path.join(source, 'rooms.json'), budgetMB = 32, json = false
  let scratchArg: string | undefined
  while (args.length) {
    const flag = args.shift()
    if (flag === '--json') { json = true; continue }
    if (!['--registry', '--budget-mb', '--scratch'].includes(flag!)) throw new Error(usage)
    const value = args.shift()
    if (!value || value.startsWith('--')) throw new Error(usage)
    if (flag === '--registry') registryFile = value
    if (flag === '--budget-mb') budgetMB = Number(value)
    if (flag === '--scratch') scratchArg = path.resolve(value)
  }
  if (!Number.isFinite(budgetMB) || budgetMB <= 0 || !Number.isSafeInteger(budgetMB * 1048576))
    throw new Error('--budget-mb must be positive and specify a safe integer number of bytes')
  const raw: unknown = JSON.parse(await fs.readFile(registryFile, 'utf8'))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Registry must be a JSON object keyed by repository')
  const normalized: Record<string, OpenRepo> = {}
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Invalid registry entry: ${name}`)
    const value = entry as OpenRepo
    for (const list of [value.branches, value.legacy, value.plan?.sources])
      if (list !== undefined && (!Array.isArray(list) || list.some(item => typeof item !== 'string')))
        throw new Error(`Invalid registry source list: ${name}`)
    normalized[name] = { ...value, at: value.at ?? 0, branches: value.branches ?? [] }
  }
  const registry = safeRoomRegistry(normalized, line => console.error(line))
  const files = (await fs.readdir(source)).filter(name => /^(CURRENT|LOCK|LOG(?:\.old)?|MANIFEST-\d+|\d+\.(?:log|ldb|sst))$/.test(name))
  if (!files.includes('CURRENT') || !files.includes('LOCK')) throw new Error('Not an existing LevelDB directory (CURRENT and LOCK required)')
  if (scratchArg) {
    if (scratchArg === source || scratchArg.startsWith(`${source}${path.sep}`)) throw new Error('--scratch must be outside the source directory')
    await fs.mkdir(scratchArg) // Never reuse or remove an existing operator directory.
    scratch = scratchArg
  } else scratch = await fs.mkdtemp(`${source}.room-inventory-`)
  console.error('Inventory copies LevelDB files to disposable scratch; requires free space equal to the database. Source document data is unchanged.')
  try { await fs.link(path.join(source, 'LOCK'), path.join(scratch, 'LOCK')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    console.error('WARNING: scratch is on another filesystem; LOCK could not be checked. Ensure the server is stopped or use a pre-upgrade snapshot copy.')
  }
  for (const file of files) if (file !== 'LOCK') await fs.copyFile(path.join(source, file), path.join(scratch, file))
  persistence = new LeveldbPersistence(scratch, { levelOptions: { createIfMissing: false } })
  if (!isLevelProvider(persistence)) throw new Error('Unsupported y-leveldb provider: transaction handle unavailable')
  const db = await levelDbOf(persistence)
  // LevelUP's constructor emits open failures; a second open() can wait forever on failure.
  const opened = db as typeof db & { open(): Promise<void>; on(event: string, listener: (error: Error) => void): void }
  const failed = new Promise<never>((_resolve, reject) => opened.on('error', reject))
  // Explicit open propagates errors: y-leveldb _transact otherwise catches and hides them.
  try { await Promise.race([opened.open(), failed]) }
  catch (error) {
    persistence = undefined // A failed LevelUP open has no handle to close (close() would wait forever).
    if (/lock/i.test(String(error))) throw new Error('LevelDB LOCK is held: run against a stopped server’s directory or the pre-upgrade snapshot copy.')
    throw error
  }
  const names = await persistence.getAllDocNames()
  if (!Array.isArray(names)) throw new Error('Could not list LevelDB documents')
  const inventory = await takeInventory(names, registry, (name, limit) => levelStoredSize(db, name, limit), budgetMB * 1048576)
  console.log(json ? JSON.stringify(inventory, null, 2) : formatInventory(inventory))
  process.exitCode = inventory.docs.some(doc => doc.over || doc.kind === 'never-served' || doc.kind === 'unregistered') ? 2 : 0
} catch (error) {
  console.error(`room-inventory: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
} finally { await cleanup() }
