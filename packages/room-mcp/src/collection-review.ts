import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { writeAtomic } from './leases.js'

interface Hold { owner: string; reviewer: string; reason: string; at: number; tokenHash: string }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

/** Call only while holding the canonical destination's withCollectLease. Local state, not room data. */
export class CollectionReview {
  readonly file: string
  constructor(registryRoot: string, worktree: string) {
    this.file = path.join(registryRoot, 'collection-reviews', hash(fs.realpathSync(worktree)) + '.json')
  }
  private read(): Hold[] {
    let value: unknown
    try { value = JSON.parse(fs.readFileSync(this.file, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error(`cannot read collection review holds; collection blocked: ${this.file}`)
    }
    if (!Array.isArray(value) || value.length > 32 || !value.every(h => h && typeof h === 'object'
      && typeof h.owner === 'string' && /^[a-f0-9]{64}$/.test(h.owner)
      && typeof h.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(h.tokenHash)
      && typeof h.reviewer === 'string' && typeof h.reason === 'string' && Number.isFinite(h.at))) {
      throw new Error(`invalid collection review holds; collection blocked: ${this.file}`)
    }
    return value as Hold[]
  }
  status(): string {
    const holds = this.read()
    return holds.length ? 'collection held for review:\n' + holds.map(h => `- ${h.reviewer}: ${h.reason}`).join('\n')
      + '\nThe reviewer must call room_collect checkpoint="release". force does not bypass a hold.'
      : 'no collection review holds'
  }
  assertClear(): void {
    if (this.read().length) throw new Error(this.status())
  }
  hold(session: string, reviewer: string, reason: string): string {
    const holds = this.read(), owner = hash(session)
    if (holds.some(h => h.owner === owner)) return 'your collection review hold is already active. ' + this.status()
    if (holds.length >= 32) throw new Error('too many collection review holds; release an existing hold first')
    const token = randomBytes(32).toString('hex')
    holds.push({ owner, reviewer, reason, at: Date.now(), tokenHash: hash(token) })
    writeAtomic(this.file, holds)
    return 'collection review hold active for this checkout. New room_collect apply, copy and discard operations are blocked. '
      + 'This does not undo or interrupt an earlier collection, or freeze other lifecycle actions.\n'
      + 'Release after review with room_collect checkpoint="release" from this same session. '
      + `For recovery from another session, keep this private reviewToken: ${token}`
  }
  release(session: string, token?: string): string {
    const holds = this.read()
    const remaining = holds.filter(h => token ? h.tokenHash !== hash(token) : h.owner !== hash(session))
    if (remaining.length === holds.length) throw new Error('no matching review hold; only its creating session or private reviewToken can release it')
    writeAtomic(this.file, remaining)
    return 'your collection review hold released; no work collected. ' + this.status()
  }
}
