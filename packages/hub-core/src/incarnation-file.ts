import { serializedStore, type IncarnationStore } from './hub.js'

/** Share record decoding and serialization while each host supplies its durable filesystem writer. */
export function incarnationFile(file: string, io: {
  read(file: string): string | Promise<string>
  /** Preserve hosts that treat a JSON null record as absent. */
  nullIsMissing?: boolean
  write(file: string, record: { max: number }): void | Promise<void>
}): IncarnationStore {
  return serializedStore({
    read: async () => {
      try {
        const record = JSON.parse(await io.read(file)) as { max?: unknown } | null
        if (record === null && io.nullIsMissing) return undefined
        const max = record!.max
        return typeof max === 'number' ? max : undefined
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw e
      }
    },
    write: async max => { await io.write(file, { max }) },
  })
}
