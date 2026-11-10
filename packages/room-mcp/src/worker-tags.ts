/** Tag-named files belong to the current reservation, across every lead in a clone. */
import path from 'node:path'
import { safeTag } from './worker-codecs.js'
import { withGuard } from './leases.js'

export function workerTagFile(root: string, tag: string): string {
  if (!safeTag(tag)) throw new Error('invalid worker tag')
  return path.join(root, 'tags', `${tag}.json`)
}

/** Lock order: capacity/worker operation first, then tag. Never acquire an operation inside this guard. */
export function withWorkerTag<T>(root: string, tag: string, fn: () => T extends PromiseLike<unknown> ? never : T): T {
  return withGuard(workerTagFile(root, tag), fn)
}
