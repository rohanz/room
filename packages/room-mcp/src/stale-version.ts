import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pluginManifest from '../../../plugins/room/.claude-plugin/plugin.json' with { type: 'json' }

type Disk = {
  readFile?: (path: string) => string
  exists?: (path: string) => boolean
  readdir?: (path: string) => string[]
  now?: () => number
  ttlMs?: number
}

function version(value: unknown): number[] | undefined {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) return undefined
  const parts = value.split('.').map(Number)
  return parts.every(Number.isSafeInteger) ? parts : undefined
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/** The loaded bundle is in plugin/server; tsx runs from packages/room-mcp/src. */
function pluginRoot(modulePath: string): string {
  const dir = dirname(modulePath)
  return basename(dir) === 'src' && basename(dirname(dir)) === 'room-mcp'
    ? resolve(dir, '../../../plugins/room')
    : resolve(dir, '..')
}

/** Check the plugin manifest on disk without assuming the host's plugin-root environment. */
export function createStaleVersionWarning(
  modulePath: string = fileURLToPath(import.meta.url),
  runningVersion: string = pluginManifest.version,
  disk: Disk = {},
): () => string | undefined {
  const readFile = disk.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const exists = disk.exists ?? existsSync
  const readdir = disk.readdir ?? readdirSync
  const now = disk.now ?? Date.now
  const ttlMs = disk.ttlMs ?? 30_000
  const root = pluginRoot(modulePath)
  let checkedAt = -Infinity
  let cached: string | undefined

  const readVersion = (dir: string): string | undefined => {
    try {
      const parsed: unknown = JSON.parse(readFile(join(dir, '.claude-plugin', 'plugin.json')))
      const value = parsed && typeof parsed === 'object' && 'version' in parsed ? parsed.version : undefined
      return version(value) ? value as string : undefined
    } catch { return undefined }
  }

  return () => {
    const time = now()
    if (time - checkedAt < ttlMs) return cached
    checkedAt = time
    cached = undefined
    const running = version(runningVersion)
    if (!running) return undefined
    let installed: string | undefined
    if (exists(join(root, '.orphaned_at'))) {
      try {
        for (const entry of readdir(dirname(root))) {
          const sibling = join(dirname(root), entry)
          if (exists(join(sibling, '.orphaned_at'))) continue
          const candidate = readVersion(sibling)
          if (candidate && (!installed || compare(version(candidate)!, version(installed)!) > 0)) installed = candidate
        }
      } catch { /* A removed cache has no installed version to report. */ }
    } else installed = readVersion(root)
    if (installed && compare(version(installed)!, running) > 0) {
      cached = `this session runs Room ${runningVersion}; ${installed} is installed. Restart the session or reconnect Room (/mcp) to use it.`
    }
    return cached
  }
}
