/**
 * GitHub REST proxy for pull requests, called with the GitHub token the server holds for a
 * logged-in session (clients never see the token). Two operations:
 *  - exact upstream/caller head lookups (cached 60s per token, repo and qualified head);
 *  - one "room ledger" comment per PR: found by a marker and edited in place, else created.
 */

export interface PullRequest {
  number: number
  title: string
  author: string
  /** Head branch name. */
  head: string
  /** Owner of the head branch; optional in responses from older servers. */
  headOwner?: string
  updatedAt: string
  url: string
}

export interface PrLookup { heads: string[]; prs: PullRequest[] }

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
const MAX_COMMENT_PAGES = 30

export class GitHubProxy {
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly cacheMs: number
  private readonly cache = new Map<string, { exp: number; value: PullRequest[] | string }>()
  private readonly inFlight = new Map<string, { promise: Promise<PullRequest[]>; controller: AbortController; users: number }>()

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
   *  short one, `maxPages`, or (`until`) an item the caller was looking for. A non-200 first page is an error.
   *  `complete` is false when a later page failed (`failed` is its HTTP status) or the ceiling stopped the walk
   *  on a full page; `items` is then what was read, never evidence that nothing more exists. */
  private async pages<T>(token: string, path: string, maxPages: number, until?: (item: T) => boolean, signal?: AbortSignal): Promise<Paged<T> | { error: number }> {
    const items: T[] = []
    const sep = path.endsWith('?') || path.endsWith('&') ? '' : '&'
    for (let page = 1; page <= maxPages; page++) {
      if (signal?.aborted) throw signal.reason ?? new Error('request cancelled')
      const r = await this.api(token, `${path}${sep}per_page=${PAGE}&page=${page}`, { signal })
      if (r.status !== 200 || !Array.isArray(r.body)) return page === 1 ? { error: r.status } : { items, complete: false, failed: r.status }
      const batch = r.body as T[]
      items.push(...batch)
      if (batch.length < PAGE || (until && batch.some(until))) return { items, complete: true }
    }
    return { items, complete: false }
  }

  /** Query only the upstream owner's branch and the token user's fork; never enumerate the repo. */
  async openPrs(token: string, ownerRepo: string, branch: string, opts: { signal?: AbortSignal } = {}): Promise<PrLookup> {
    const upstream = ownerRepo.split('/')[0]
    const login = await this.loginOf(token, opts.signal)
    const owners = upstream.toLowerCase() === login.toLowerCase() ? [upstream] : [upstream, login]
    const heads = owners.map(owner => `${owner}:${branch}`)
    // Await both requests even on failure, retaining the operation's resource slot until they settle.
    const results = await Promise.allSettled(heads.map(head => this.prsForHead(token, ownerRepo, head, opts)))
    const prs = new Map<number, PullRequest>()
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason
      for (const pr of result.value) prs.set(pr.number, pr)
    }
    return { heads, prs: [...prs.values()] }
  }

  private async prsForHead(token: string, ownerRepo: string, head: string, opts: { signal?: AbortSignal }): Promise<PullRequest[]> {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('request cancelled')
    const key = `${token}\0${ownerRepo}#head:${head}`
    const hit = this.cache.get(key)
    if (hit && hit.exp > this.now() && Array.isArray(hit.value)) return hit.value
    let flight = this.inFlight.get(key)
    if (!flight) {
      const controller = new AbortController()
      const promise = this.fetchHeadPrs(token, ownerRepo, head, controller.signal).then(prs => {
        this.remember(key, prs)
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

  private async fetchHeadPrs(token: string, ownerRepo: string, head: string, signal: AbortSignal): Promise<PullRequest[]> {
    const result = await this.api(token, `/repos/${ownerRepo}/pulls?state=open&head=${encodeURIComponent(head)}&per_page=100`, { signal })
    if (result.status !== 200 || !Array.isArray(result.body)) throw new GitHubError(result.status, `pull request lookup failed for ${head} (HTTP ${result.status}); retry or use room_pr_note number=<n>`)
    return (result.body as RawPr[]).map(raw => ({
      number: raw.number, title: raw.title ?? '', author: raw.user?.login ?? '', head: raw.head?.ref ?? '',
      headOwner: raw.head?.user?.login ?? raw.head?.label?.split(':')[0] ?? head.slice(0, head.indexOf(':')),
      updatedAt: raw.updated_at ?? '', url: raw.html_url ?? '',
    }))
  }

  /** Login and head results share the same TTL and bounded cache. Hits never extend their lifetime. */
  private remember(key: string, value: PullRequest[] | string): void {
    this.cache.set(key, { exp: this.now() + this.cacheMs, value })
    for (const [k, v] of this.cache) if (v.exp <= this.now()) this.cache.delete(k)
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!)
  }

  /** The token's current login, cached for the same 60s as its head results. */
  async loginOf(token: string, signal?: AbortSignal): Promise<string> {
    const key = `${token}\0login`
    const hit = this.cache.get(key)
    if (hit && hit.exp > this.now() && typeof hit.value === 'string') return hit.value
    const r = await this.api(token, '/user', { signal })
    const login = (r.body as { login?: string } | undefined)?.login
    if (r.status !== 200 || !login) throw new GitHubError(r.status, `could not read the GitHub user (HTTP ${r.status})`)
    this.remember(key, login)
    return login
  }

  /** Post or update the one room-ledger comment on a PR, authored by the token's user. */
  async upsertNote(token: string, ownerRepo: string, number: number, body: string, signal?: AbortSignal): Promise<{ id: number; url: string; updated: boolean }> {
    const login = await this.loginOf(token, signal)
    if (signal?.aborted) throw signal.reason ?? new Error('request cancelled')
    const text = body.includes(LEDGER_MARKER) ? body : `${LEDGER_MARKER}\n${body}`
    // A long-lived PR has more than one page of comments; the ledger may be on any of them.
    const isMine = (c: RawComment) => c.user?.login === login && typeof c.body === 'string' && c.body.includes(LEDGER_MARKER)
    const existing = await this.pages<RawComment>(token, `/repos/${ownerRepo}/issues/${number}/comments?`, MAX_COMMENT_PAGES, isMine, signal)
    if ('error' in existing) throw new GitHubError(existing.error, `could not read comments of ${ownerRepo}#${number} (HTTP ${existing.error})`)
    const mine = existing.items.find(isMine)
    // Not finding the ledger proves it absent only when every page was read; otherwise posting could duplicate it.
    if (!mine && !existing.complete) {
      const why = existing.failed !== undefined ? `a later page answered HTTP ${existing.failed}` : `more than ${MAX_COMMENT_PAGES * PAGE} comments`
      throw new GitHubError(503, `the comment search on ${ownerRepo}#${number} is incomplete (${why}), so the room ledger was not posted; retry`)
    }
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

type Paged<T> = { items: T[]; complete: boolean; failed?: number }
interface RawPr { number: number; title?: string; user?: { login?: string }; head?: { ref?: string; label?: string; user?: { login?: string } }; updated_at?: string; html_url?: string }
interface RawComment { id: number; body?: string; html_url?: string; user?: { login?: string } }
