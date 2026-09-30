/**
 * GitHub REST proxy for pull requests, called with the GitHub token the server holds for a
 * logged-in session (clients never see the token). Two operations:
 *  - open PRs of a repo targeting a branch, with the paths each one touches (cached 60s per
 *    repo+branch so four agents polling every two minutes cost one GitHub call);
 *  - one "room ledger" comment per PR: found by a marker and edited in place, else created.
 */

export interface PullRequest {
  number: number
  title: string
  author: string
  /** Head branch name. */
  head: string
  files: string[]
  updatedAt: string
  url: string
}

export interface GitHubProxyOptions {
  fetch?: typeof fetch
  now?: () => number
  /** Cache lifetime for the PR list; default 60s. */
  cacheMs?: number
  log?: (line: string) => void
}

/** Marker that identifies the comment the room maintains on a PR. */
export const LEDGER_MARKER = '<!-- room-ledger -->'
const API = 'https://api.github.com'
/** GitHub's largest page. Page ceilings keep one request from turning into hundreds of GitHub calls. */
const PAGE = 100
const MAX_PR_PAGES = 10
const MAX_FILE_PAGES = 30
const MAX_COMMENT_PAGES = 30

export class GitHubProxy {
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly cacheMs: number
  private readonly cache = new Map<string, { exp: number; prs: PullRequest[] }>()
  private readonly inFlight = new Map<string, { promise: Promise<PullRequest[]>; controller: AbortController; users: number }>()
  private readonly logins = new Map<string, string>()

  constructor(private readonly o: GitHubProxyOptions = {}) {
    this.fetch = o.fetch ?? globalThis.fetch
    this.now = o.now ?? Date.now
    this.cacheMs = o.cacheMs ?? 60_000
  }

  private async api(token: string, path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<{ status: number; body: unknown }> {
    if (init.signal?.aborted) throw init.signal.reason ?? new Error('request cancelled')
    const res = await this.fetch(`${API}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'room-server', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    })
    const body = await res.json().catch(() => undefined)
    if (init.signal?.aborted) throw init.signal.reason ?? new Error('request cancelled')
    return { status: res.status, body }
  }

  /** Every item of a paged list endpoint (`path` ends in `?` or `&...`), 100 per page, following pages until a
   *  short one, `maxPages`, or (`until`) an item the caller was looking for. A non-200 first page is an error;
   *  a later failure keeps what was read. */
  private async pages<T>(token: string, path: string, maxPages: number, until?: (item: T) => boolean, signal?: AbortSignal): Promise<{ items: T[] } | { error: number }> {
    const items: T[] = []
    const sep = path.endsWith('?') || path.endsWith('&') ? '' : '&'
    for (let page = 1; page <= maxPages; page++) {
      if (signal?.aborted) throw signal.reason ?? new Error('request cancelled')
      const r = await this.api(token, `${path}${sep}per_page=${PAGE}&page=${page}`, { signal })
      if (r.status !== 200 || !Array.isArray(r.body)) { if (page === 1) return { error: r.status }; break }
      const batch = r.body as T[]
      items.push(...batch)
      if (batch.length < PAGE || (until && batch.some(until))) break
    }
    return { items }
  }

  /** Open PRs of owner/repo, newest update first, with their files. By default those whose base is `branch`;
   *  `{ head: true }` lists those whose HEAD is `branch` instead (any base). Cached per query. */
  async openPrs(token: string, ownerRepo: string, branch: string, opts: { head?: boolean; signal?: AbortSignal } = {}): Promise<PullRequest[]> {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('request cancelled')
    const key = `${token}\0${ownerRepo}#${opts.head ? 'head:' : ''}${branch}`
    const hit = this.cache.get(key)
    if (hit && hit.exp > this.now()) return hit.prs
    let flight = this.inFlight.get(key)
    if (!flight) {
      const controller = new AbortController()
      const promise = this.fetchPrs(token, ownerRepo, branch, opts.head, controller.signal).then(prs => {
        this.cache.set(key, { exp: this.now() + this.cacheMs, prs })
        for (const [k, v] of this.cache) if (v.exp <= this.now()) this.cache.delete(k)
        if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!)
        return prs
      }).finally(() => { this.inFlight.delete(key) })
      flight = { promise, controller, users: 0 }
      this.inFlight.set(key, flight)
    }
    flight.users++
    const active = flight
    const abandoned = () => { if (--active.users === 0) active.controller.abort() }
    if (!opts.signal) { try { return await active.promise } finally { abandoned() } }
    let onAbort: (() => void) | undefined
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(opts.signal!.reason ?? new Error('request cancelled'))
      opts.signal!.addEventListener('abort', onAbort, { once: true })
    })
    let left = false
    try { return await Promise.race([active.promise, cancelled]) }
    catch (error) {
      if (opts.signal.aborted) {
        abandoned(); left = true
        // The caller's work slot must outlive an upstream fetch that ignores cancellation.
        if (active.users === 0) await active.promise.catch(() => {})
      }
      throw error
    } finally { opts.signal.removeEventListener('abort', onAbort!); if (!left) abandoned() }
  }

  private async fetchPrs(token: string, ownerRepo: string, branch: string, head: boolean | undefined, signal: AbortSignal): Promise<PullRequest[]> {
    const owner = ownerRepo.split('/')[0]
    const filter = head ? `head=${encodeURIComponent(`${owner}:${branch}`)}` : `base=${encodeURIComponent(branch)}`
    // GitHub pages the list at 100; a busy repo has more open PRs than that.
    const raws = await this.pages<RawPr>(token, `/repos/${ownerRepo}/pulls?state=open&${filter}&sort=updated&direction=desc`, MAX_PR_PAGES, undefined, signal)
    if ('error' in raws) throw new GitHubError(raws.error, `could not list pull requests of ${ownerRepo} (HTTP ${raws.error})`)
    const prs: PullRequest[] = []
    for (const raw of raws.items) {
      // Same for the file list; a mirrored scope must not silently drop the files past the first page.
      const files = await this.pages<{ filename?: string }>(token, `/repos/${ownerRepo}/pulls/${raw.number}/files?`, MAX_FILE_PAGES, undefined, signal)
      const paths = ('error' in files ? [] : files.items).map(f => f.filename).filter((f): f is string => !!f)
      prs.push({ number: raw.number, title: raw.title ?? '', author: raw.user?.login ?? '', head: raw.head?.ref ?? '', files: paths, updatedAt: raw.updated_at ?? '', url: raw.html_url ?? '' })
    }
    return prs
  }

  /** The login behind a token (cached), used to find the caller's own ledger comment. */
  async loginOf(token: string, signal?: AbortSignal): Promise<string> {
    const hit = this.logins.get(token)
    if (hit) return hit
    const r = await this.api(token, '/user', { signal })
    const login = (r.body as { login?: string } | undefined)?.login
    if (r.status !== 200 || !login) throw new GitHubError(r.status, `could not read the GitHub user (HTTP ${r.status})`)
    this.logins.set(token, login)
    if (this.logins.size > 1000) this.logins.delete(this.logins.keys().next().value!)
    return login
  }

  /** Post or update the one room-ledger comment on a PR, authored by the token's user. */
  async upsertNote(token: string, ownerRepo: string, number: number, body: string, signal?: AbortSignal): Promise<{ id: number; url: string; updated: boolean }> {
    const login = await this.loginOf(token, signal)
    if (signal?.aborted) throw signal.reason ?? new Error('request cancelled')
    const text = body.includes(LEDGER_MARKER) ? body : `${LEDGER_MARKER}\n${body}`
    // A long-lived PR has more than one page of comments; the ledger may be on any of them.
    const existing = await this.pages<RawComment>(token, `/repos/${ownerRepo}/issues/${number}/comments?`, MAX_COMMENT_PAGES, c => c.user?.login === login && typeof c.body === 'string' && c.body.includes(LEDGER_MARKER), signal)
    if ('error' in existing) throw new GitHubError(existing.error, `could not read comments of ${ownerRepo}#${number} (HTTP ${existing.error})`)
    const mine = existing.items.find(c => c.user?.login === login && typeof c.body === 'string' && c.body.includes(LEDGER_MARKER))
    const r = mine
      ? await this.api(token, `/repos/${ownerRepo}/issues/comments/${mine.id}`, { method: 'PATCH', body: { body: text }, signal })
      : await this.api(token, `/repos/${ownerRepo}/issues/${number}/comments`, { method: 'POST', body: { body: text }, signal })
    const c = r.body as RawComment | undefined
    if ((r.status !== 200 && r.status !== 201) || !c?.id) throw new GitHubError(r.status, `could not ${mine ? 'update' : 'post'} the comment on ${ownerRepo}#${number} (HTTP ${r.status})`)
    this.o.log?.(`pr-note: ${mine ? 'updated' : 'posted'} comment ${c.id} on ${ownerRepo}#${number} as ${login}`)
    return { id: c.id, url: c.html_url ?? '', updated: !!mine }
  }
}

class GitHubError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

interface RawPr { number: number; title?: string; user?: { login?: string }; head?: { ref?: string }; updated_at?: string; html_url?: string }
interface RawComment { id: number; body?: string; html_url?: string; user?: { login?: string } }
