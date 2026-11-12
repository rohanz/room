import { privateStateDirectory } from '@room/relay'
/** Ownership uncertainty is retained in place and remains visible until the item is gone. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { boundedGitSync } from '@room/roomd/baseline'
import { writeAtomic } from './leases.js'

export interface RetainedWorkerItem {
  kind: 'worktree' | 'registration' | 'branch' | 'ref' | 'directory' | 'file'
  path: string; reason: string; id?: string; tag?: string
}
const directory = (common: string) => path.join(common, 'room', 'registry', 'retained')
const itemFile = (common: string, item: Pick<RetainedWorkerItem, 'kind' | 'path'>) => path.join(directory(common), createHash('sha256').update(item.kind + '\0' + item.path).digest('hex') + '.json')
export function retainWorkerItem(common: string, item: RetainedWorkerItem): string {
  privateStateDirectory(directory(common))
  writeAtomic(itemFile(common, item), item)
  return `kept ${item.kind} ${item.path}: ${item.reason}`
}
export function clearRetainedWorkerItem(common: string, kind: RetainedWorkerItem['kind'], target: string): void {
  fs.rmSync(itemFile(common, { kind, path: target }), { force: true })
}
export function retainedWorkerItemPresent(common: string, item: RetainedWorkerItem): boolean {
  if (item.kind === 'branch' || item.kind === 'ref') {
    try {
      const out = boundedGitSync(common, ['--git-dir', common, 'for-each-ref', '--format=%(refname)', item.path]).toString().split('\n')
      if (out.includes(item.path)) return true
      // for-each-ref omits a dangling symbolic ref; that name is still retained.
      try { boundedGitSync(common, ['--git-dir', common, 'symbolic-ref', '-q', item.path]); return true } catch (error) {
        if ((error as { status?: number }).status !== 1) return true
      }
      return false
    } catch { return true }
  }
  try { fs.lstatSync(item.path); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT' }
}
function retainedWorkerItems(common: string): RetainedWorkerItem[] {
  let names: string[]
  try { names = fs.readdirSync(directory(common)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  return names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
    const file = path.join(directory(common), name)
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.size > 65536) throw new Error('invalid retained-item metadata file')
      const value = JSON.parse(fs.readFileSync(file, 'utf8')) as RetainedWorkerItem
      if (!['worktree', 'registration', 'branch', 'ref', 'directory', 'file'].includes(value.kind) || typeof value.path !== 'string' || typeof value.reason !== 'string')
        throw new Error('invalid retained-item evidence')
      return retainedWorkerItemPresent(common, value) ? [value] : []
    } catch { return [{ kind: 'file' as const, path: file, reason: 'retained-item evidence is unreadable; inspect it manually' }] }
  })
}
export function retainedWorkerLines(common: string): string[] {
  const items = retainedWorkerItems(common)
  return items.length ? ['left in place because Room cannot confirm it created them (each note clears once you remove the item):', ...items.map(item => `  ${item.tag ? item.tag + ': ' : ''}kept ${item.kind} ${item.path}: ${item.reason}`)] : []
}
