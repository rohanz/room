/**
 * One admission rule for every entry point (opening, listing, closing, viewing, connecting):
 *
 *  - github.com/<owner>/<repo>/... rooms admit only a login session from the GitHub device flow whose
 *    token can push to the repo. Nothing else: not a forwarded GitHub token (?gh=, refused with 401
 *    in every mode), not ROOM_TOKEN, not an OIDC session.
 *  - Other rooms (local/..., git/<host>/...) admit ROOM_TOKEN when one is set, any login session when
 *    the server has a login provider, and are open when it has neither.
 */
import { GH_DENIAL_CACHE_MS } from './limits.js'
import type { Auth, Provider } from './auth.js'
import { githubRepoOf, roomNameOf } from './names.js'

export interface Creds { gh?: string; token?: string; session?: string }
/** `login` is the display name; `id` the namespaced identity (`oidc:<issuer-host>:<sub>`) when the provider has one. */
export type Verdict = { ok: true; login?: string; id?: string; provider?: Provider } | { ok: false; status: 401 | 403; why: string }

const GH_REFUSED = 'forwarded GitHub tokens are not accepted: run room_login (GitHub device login)'

export interface AdmitOptions {
  auth: Pick<Auth, 'providers' | 'resolve' | 'fake'>
  /** ROOM_TOKEN: admits non-GitHub rooms only. */
  token?: string
  /** Can this GitHub token push to owner/repo? Default: asks the GitHub API, grants cached 10 min and definite denials at most 60 s per token+repo. */
  canPush?: (token: string, ownerRepo: string, fresh?: boolean) => Promise<boolean | undefined>
  fetch?: typeof fetch
  now?: () => number
}

const GH_POSITIVE_CACHE_MS = 10 * 60 * 1000
/** A throttled GitHub answer: no allowance left, a Retry-After, or a rate-limit message in the (bounded) body.
 *  A body that cannot be read throws: the caller answers "unavailable", never a denial it has not seen. */
async function rateLimited(res: Response): Promise<boolean> {
  if (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')) return true
  return /rate limit|abuse detection/i.test((await res.text()).slice(0, 2048))
}
export type PushChecker = ((token: string, ownerRepo: string, fresh?: boolean) => Promise<boolean | undefined>) & { forget(token: string): void }
export function githubPushChecker(o: { fetch?: typeof fetch; now?: () => number } = {}): PushChecker {
  const f = o.fetch ?? globalThis.fetch, now = o.now ?? Date.now
  // Logout clears cached decisions while pending checks remain coalesced; generations prevent stale repopulation.
  const holders = new Map<string, { cache: Map<string, { allowed: boolean; until: number }>; pending: Map<string, Promise<boolean | undefined>>; generation: number }>()
  const check = (async (token: string, ownerRepo: string, fresh = false) => {
    let holder = holders.get(token)
    if (!holder) {
      holder = { cache: new Map(), pending: new Map(), generation: 0 }; holders.set(token, holder)
      if (holders.size > 1000) for (const [key, value] of holders) { if (!value.pending.size) { holders.delete(key); break } }
    }
    const current = holder.pending.get(ownerRepo)
    if (current) return current
    const hit = holder.cache.get(ownerRepo)
    if (hit && hit.until > now() && (!fresh || !hit.allowed)) return hit.allowed
    const h = holder, generation = holder.generation
    const work = (async () => {
      try {
        const res = await f(`https://api.github.com/repos/${ownerRepo}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'room-server' }, signal: AbortSignal.timeout(10000) })
        let allowed: boolean
        if (!res.ok) {
          if (![401, 403, 404].includes(res.status)) return undefined
          // GitHub uses 403 for primary and secondary rate limits too: that is "unavailable", never a denial.
          if (res.status === 403 && await rateLimited(res)) return undefined
          h.cache.delete(ownerRepo)
          // 401 is a stale credential, not a repository permission denial.
          if (res.status === 401) return false
          allowed = false
        } else {
          const body = await res.json() as { permissions?: { push?: boolean } }
          if (body.permissions?.push !== true && body.permissions?.push !== false) return undefined
          allowed = body.permissions.push
        }
        if (h.generation === generation && holders.get(token) === h) h.cache.set(ownerRepo, { allowed, until: now() + (allowed ? GH_POSITIVE_CACHE_MS : GH_DENIAL_CACHE_MS) })
        if (h.cache.size > 100) h.cache.delete(h.cache.keys().next().value!)
        return allowed
      } catch { return undefined }
    })()
    h.pending.set(ownerRepo, work)
    try { return await work } finally { h.pending.delete(ownerRepo) }
  }) as PushChecker
  check.forget = token => {
    const holder = holders.get(token)
    if (!holder) return
    holder.cache.clear(); holder.generation++
    if (!holder.pending.size) holders.delete(token)
  }
  return check
}

export function makeAdmitted(o: AdmitOptions): (room: string, c: Creds) => Promise<Verdict> {
  const { auth, token: TOKEN } = o
  const canPush = o.canPush ?? githubPushChecker(o)
  return async (room, c) => {
    const repo = githubRepoOf(room)
    if (!repo) {
      if (TOKEN && c.token === TOKEN) return { ok: true }
      if (c.session) {
        const st = auth.resolve(c.session)
        if (st) return { ok: true, login: st.login, id: st.id, provider: st.provider }
        if (auth.providers.length) return { ok: false, status: 401, why: 'session expired or unknown: run room_login' }
      }
      if (auth.providers.length) return { ok: false, status: 401, why: `not logged in: run room_login (room ${roomNameOf(room)})` }
      if (TOKEN) return { ok: false, status: 401, why: 'token required or wrong: set ROOM_TOKEN or send X-Room-Token' }
      return { ok: true }
    }
    // github.com rooms: a GitHub login session with push access, nothing else.
    if (c.gh) return { ok: false, status: 401, why: `${GH_REFUSED} (room ${repo})` }
    if (!c.session) {
      if (c.token) return { ok: false, status: 401, why: `ROOM_TOKEN does not admit GitHub rooms: run room_login (room ${repo})` }
      return { ok: false, status: 401, why: auth.providers.includes('github') ? `not logged in: run room_login (room ${repo})` : `${repo} is a GitHub repo but this server has no GitHub login configured (GITHUB_CLIENT_ID); run room_login on a server that has one` }
    }
    const st = auth.resolve(c.session)
    if (!st) return { ok: false, status: 401, why: 'session expired or unknown: run room_login' }
    if (!st.ghToken) return { ok: false, status: 403, why: auth.providers.includes('github') ? `${repo} is a GitHub repo: log in with GitHub (room_login provider=github) to prove push access` : `${repo} is a GitHub repo but this server has no GitHub login configured (GITHUB_CLIENT_ID)` }
    // The fake issuer (tests, demo) mints no real token: every fake login may push.
    if (auth.fake ? st.ghToken.startsWith('fake:') || await canPush(st.ghToken, repo) : await canPush(st.ghToken, repo)) return { ok: true, login: st.login, provider: 'github' }
    return { ok: false, status: 403, why: `${st.login} cannot push to ${repo}: ask for write access` }
  }
}
