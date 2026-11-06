/** Low-level store tests model one admitted caller per opened registry. Tool tests use real outer boundaries. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach } from 'vitest'
import { WorkerRegistry, type RegistryOptions } from '../../src/worker-registry.js'
import { withAdmission, closeStorageAdmissions } from '../../src/storage-admission.js'

const finishes: (() => Promise<void>)[] = []
afterEach(async () => { for (const finish of finishes.splice(0)) await finish(); await closeStorageAdmissions() })

export async function openAdmittedRegistry(common: string, options: RegistryOptions = {}): Promise<WorkerRegistry> {
  let capture!: ReturnType<typeof AsyncLocalStorage.snapshot>, registry!: WorkerRegistry
  let ready!: () => void, end!: () => void
  const entered = new Promise<void>(resolve => { ready = resolve })
  const ended = new Promise<void>(resolve => { end = resolve })
  const operation = withAdmission(common, 'reconcile', async () => {
    registry = await WorkerRegistry.open(common, options)
    capture = AsyncLocalStorage.snapshot()
    ready()
    await ended
  })
  await Promise.race([entered, operation])
  const finish = async () => { registry.close(); end(); await operation }
  finishes.push(finish)
  return new Proxy(registry, { get(target, key) {
    const value = Reflect.get(target, key)
    if (key === 'close') return () => { void finish() }
    return typeof value === 'function' ? (...args: unknown[]) => capture(() => value.apply(target, args)) : value
  } })
}
