/**
 * One admission rule for every entry point (opening, listing, closing, viewing, connecting):
 *
 *  - github.com/<owner>/<repo>/... rooms admit only a login session from the GitHub device flow whose
 *    token can push to the repo. Nothing else: not a forwarded GitHub token (?gh=, refused with 401
 *    in every mode), not ROOM_TOKEN, not an OIDC session.
 *  - Other rooms (local/..., git/<host>/...) admit ROOM_TOKEN when one is set, any login session when
 *    the server has a login provider, and are open when it has neither.
 */
import type { Auth, Provider } from './auth.js'
import { githubRepoOf, repoOf, roomNameOf } from './names.js'

export interface Creds { gh?: string; token?: string; session?: string }
/** `login` is the display name; `id` the namespaced identity (`oidc:<issuer-host>:<sub>`) when the provider has one. */
export type Verdict = { ok: true; login?: string; id?: string; provider?: Provider } | { ok: false; status: 401 | 403; why: string }

export const GH_REFUSED = 'forwarded GitHub tokens are not accepted: run room_login (GitHub device login)'

export interface AdmitOptions {
  auth: Pick<Auth, 'providers' | 'resolve' | 'fake'>
  /** ROOM_TOKEN: admits non-GitHub rooms only. */
  token?: string
  /** Can this GitHub token push to owner/repo? Default: asks the GitHub API, cached 10 min per token+repo. */
  canPush?: (token: string, ownerRepo: string) => Promise<boolean>
  fetch?: typeof fetch
  now?: () => number
}

/** Can the token push to the repo? Read access alone would make every public repo an open room. */
export function githubPushChecker(o: { fetch?: typeof fetch; now?: () => number } = {}): (token: string, ownerRepo: string) => Promise<boolean> {
  const f = o.fetch ?? globalThis.fetch
  const now = o.now ?? Date.now
  const cache = new Map<string, Map<string, number>>()
  return async (token, ownerRepo) => {
    const t = now()
    const hit = cache.get(token)?.get(ownerRepo)
    if (hit && hit > t) return true
    try {
      const res = await f(`https://api.github.com/repos/${ownerRepo}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'room-server' } })
      if (!res.ok) return false
      const body = await res.json() as { permissions?: { push?: boolean } }
      if (!body.permissions?.push) return false
      let m = cache.get(token); if (!m) { m = new Map(); cache.set(token, m) }
      m.set(ownerRepo, t + 10 * 60 * 1000)
      return true
    } catch { return false }
  }
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
      if (auth.providers.length) return { ok: false, status: 401, why: `not logged in: run room_login (room ${repoOf(roomNameOf(room))})` }
      if (TOKEN) return { ok: false, status: 401, why: 'token required or wrong: set ROOM_SERVER=ws://host/?token=<shared token>' }
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
