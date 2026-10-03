/** The parser runtime and grammar instances belong exclusively to this thread. */
import { parentPort } from 'node:worker_threads'
import { ensureLanguages, parseFile } from './engine.js'

if (!parentPort) throw new Error('parser worker needs a parent port')
parentPort.on('message', async ({ id, path, texts }: { id: number; path: string; texts: (string | undefined)[] }) => {
  try {
    await ensureLanguages([path])
    const cache = new Map<string, ReturnType<typeof parseFile>>()
    const parsed = texts.map(text => {
      if (text === undefined) return undefined
      if (!cache.has(text)) cache.set(text, parseFile(path, text))
      return cache.get(text)
    })
    parentPort!.postMessage({ id, parsed })
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
})
