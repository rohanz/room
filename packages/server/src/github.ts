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

export class GitHubProxy {
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly cacheMs: number
  private readonly cache = new Map<string, { exp: number; prs: PullRequest[] }>()
  private readonly logins = new Map<string, string>()

  constructor(private readonly o: GitHubProxyOptions = {}) {
    this.fetch = o.fetch ?? globalThis.fetch
    this.now = o.now ?? Date.now
    this.cacheMs = o.cacheMs ?? 60_000
  }

  private async api(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: unknown }> {
    const res = await this.fetch(`${API}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'room-server', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
    const body = await res.json().catch(() => undefined)
    return { status: res.status, body }
  }

  /** Open PRs of owner/repo, newest update first, with their files. By default those whose base is `branch`;
   *  `{ head: true }` lists those whose HEAD is `branch` instead (any base). Cached per query. */
  async openPrs(token: string, ownerRepo: string, branch: string, opts: { head?: boolean } = {}): Promise<PullRequest[]> {
    const key = `${ownerRepo}#${opts.head ? 'head:' : ''}${branch}`
    const hit = this.cache.get(key)
    if (hit && hit.exp > this.now()) return hit.prs
    const owner = ownerRepo.split('/')[0]
    const filter = opts.head ? `head=${encodeURIComponent(`${owner}:${branch}`)}` : `base=${encodeURIComponent(branch)}`
    const list = await this.api(token, `/repos/${ownerRepo}/pulls?state=open&${filter}&per_page=50&sort=updated&direction=desc`)
    if (list.status !== 200 || !Array.isArray(list.body)) throw new GitHubError(list.status, `could not list pull requests of ${ownerRepo} (HTTP ${list.status})`)
    const prs: PullRequest[] = []
    for (const raw of list.body as RawPr[]) {
      // GitHub pages the file list at 100; a large PR has more, and a mirrored scope must not silently drop them.
      const paths: string[] = []
      for (let page = 1; page <= 30; page++) {
        const files = await this.api(token, `/repos/${ownerRepo}/pulls/${raw.number}/files?per_page=100&page=${page}`)
        if (files.status !== 200 || !Array.isArray(files.body)) break
        const batch = (files.body as { filename?: string }[]).map(f => f.filename).filter((f): f is string => !!f)
        paths.push(...batch)
        if ((files.body as unknown[]).length < 100) break
      }
      prs.push({ number: raw.number, title: raw.title ?? '', author: raw.user?.login ?? '', head: raw.head?.ref ?? '', files: paths, updatedAt: raw.updated_at ?? '', url: raw.html_url ?? '' })
    }
    this.cache.set(key, { exp: this.now() + this.cacheMs, prs })
    for (const [k, v] of this.cache) if (v.exp <= this.now()) this.cache.delete(k)
    return prs
  }

  /** The login behind a token (cached), used to find the caller's own ledger comment. */
  async loginOf(token: string): Promise<string> {
    const hit = this.logins.get(token)
    if (hit) return hit
    const r = await this.api(token, '/user')
    const login = (r.body as { login?: string } | undefined)?.login
    if (r.status !== 200 || !login) throw new GitHubError(r.status, `could not read the GitHub user (HTTP ${r.status})`)
    this.logins.set(token, login)
    return login
  }

  /** Post or update the one room-ledger comment on a PR, authored by the token's user. */
  async upsertNote(token: string, ownerRepo: string, number: number, body: string): Promise<{ id: number; url: string; updated: boolean }> {
    const login = await this.loginOf(token)
    const text = body.includes(LEDGER_MARKER) ? body : `${LEDGER_MARKER}\n${body}`
    const existing = await this.api(token, `/repos/${ownerRepo}/issues/${number}/comments?per_page=100`)
    if (existing.status !== 200 || !Array.isArray(existing.body)) throw new GitHubError(existing.status, `could not read comments of ${ownerRepo}#${number} (HTTP ${existing.status})`)
    const mine = (existing.body as RawComment[]).find(c => c.user?.login === login && typeof c.body === 'string' && c.body.includes(LEDGER_MARKER))
    const r = mine
      ? await this.api(token, `/repos/${ownerRepo}/issues/comments/${mine.id}`, { method: 'PATCH', body: { body: text } })
      : await this.api(token, `/repos/${ownerRepo}/issues/${number}/comments`, { method: 'POST', body: { body: text } })
    const c = r.body as RawComment | undefined
    if ((r.status !== 200 && r.status !== 201) || !c?.id) throw new GitHubError(r.status, `could not ${mine ? 'update' : 'post'} the comment on ${ownerRepo}#${number} (HTTP ${r.status})`)
    this.o.log?.(`pr-note: ${mine ? 'updated' : 'posted'} comment ${c.id} on ${ownerRepo}#${number} as ${login}`)
    return { id: c.id, url: c.html_url ?? '', updated: !!mine }
  }
}

export class GitHubError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

interface RawPr { number: number; title?: string; user?: { login?: string }; head?: { ref?: string }; updated_at?: string; html_url?: string }
interface RawComment { id: number; body?: string; html_url?: string; user?: { login?: string } }
