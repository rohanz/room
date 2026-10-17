import { createHash } from 'node:crypto'
import { diffPage, PAGE_CHARS } from './tools/reader-diff.js'

const READ_DIFF_LIMITS = { entries: 4, bytes: 16 * 1024 * 1024, entryBytes: 8 * 1024 * 1024, idleMs: 120_000 } as const
export const DIFF_RESTART = 'error: diff cursor expired or does not match this request; restart room_read with diff=true and no cursor'
type Entry = { owner: WeakRef<object>; request: string; text: string; fingerprint: string; digest: string; bytes: number; timer: ReturnType<typeof setTimeout> }

/** Process-wide caps; stores rendered replies only, never snapshots, sessions or file inputs. */
export class ReadDiffCache {
  private entries = new Set<Entry>()
  private bytes = 0
  constructor(private readonly limits: { entries: number; bytes: number; entryBytes: number; idleMs: number } = READ_DIFF_LIMITS) {}

  private remove(entry: Entry): void {
    if (!this.entries.delete(entry)) return
    this.bytes -= entry.bytes
    clearTimeout(entry.timer)
  }
  clear(owner: object, request?: string): void {
    for (const entry of this.entries) if (!entry.owner.deref() || (entry.owner.deref() === owner && (request === undefined || request === entry.request))) this.remove(entry)
  }
  get(owner: object, request: string, cursor: unknown): Entry | undefined {
    if (typeof cursor !== 'string' || !/^[a-f0-9]{64}:[1-9][0-9]*$/.test(cursor)) return undefined
    const digest = cursor.slice(0, 64)
    for (const entry of this.entries) {
      if (!entry.owner.deref()) { this.remove(entry); continue }
      if (entry.owner.deref() === owner && entry.request === request && entry.digest === digest) return entry
    }
    return undefined
  }
  start(owner: object, request: string, text: string, fingerprint: string): string {
    this.clear(owner, request)
    if (text.length <= PAGE_CHARS) return text
    // Two bytes per UTF-16 code unit bounds JS string storage; include keys and fixed metadata.
    const bytes = 2 * (text.length + request.length + fingerprint.length + 64) + 512
    if (bytes > this.limits.entryBytes || bytes > this.limits.bytes)
      return 'error: diff exceeds the bounded continuation cache; use room_state(all=true) to discover changed paths and room_read(diff=true, path=...) for individual files'
    while (this.entries.size >= this.limits.entries || this.bytes + bytes > this.limits.bytes) this.remove(this.entries.values().next().value!)
    const digest = createHash('sha256').update(text).digest('hex')
    const entry: Entry = { owner: new WeakRef(owner), request, text, fingerprint, digest, bytes,
      timer: setTimeout(() => this.remove(entry), this.limits.idleMs) }
    entry.timer.unref()
    this.entries.add(entry); this.bytes += bytes
    return diffPage(text, undefined, digest)
  }
  page(entry: Entry, cursor: unknown, fingerprint: string): string {
    if (!this.entries.has(entry)) return DIFF_RESTART
    if (entry.fingerprint !== fingerprint) {
      this.remove(entry)
      return 'error: diff changed since the previous page; restart room_read with diff=true and no cursor'
    }
    this.entries.delete(entry); this.entries.add(entry)
    entry.timer.refresh()
    return diffPage(entry.text, cursor, entry.digest)
  }
}

export const readDiffCache = new ReadDiffCache()
