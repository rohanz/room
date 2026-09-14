import { describe, it, expect } from 'vitest'
import { GitHubProxy, LEDGER_MARKER } from '../src/github.js'

type Call = { method: string; url: string; body?: any; auth?: string }
/** A scripted GitHub: two open PRs on `main`, one on `dev`; PR 7 has a ledger comment by octo. */
function fakeGitHub(opts: { login?: string; comments?: any[] } = {}) {
  const calls: Call[] = []
  const comments: any[] = opts.comments ?? []
  const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
  const f = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const headers = init?.headers as Record<string, string> | undefined
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers?.authorization })
    const u = new URL(url)
    if (u.pathname === '/repos/o/r/pulls' && method === 'GET') {
      const base = u.searchParams.get('base')
      const all = [
        { number: 7, title: 'Add login', user: { login: 'kieran' }, head: { ref: 'feat/login' }, base: { ref: 'main' }, updated_at: '2026-09-15T10:00:00Z', html_url: 'https://github.com/o/r/pull/7' },
        { number: 9, title: 'Fix orders', user: { login: 'sam' }, head: { ref: 'fix/orders' }, base: { ref: 'main' }, updated_at: '2026-09-15T09:00:00Z', html_url: 'https://github.com/o/r/pull/9' },
        { number: 11, title: 'Dev only', user: { login: 'sam' }, head: { ref: 'x' }, base: { ref: 'dev' }, updated_at: '2026-09-15T08:00:00Z', html_url: 'https://github.com/o/r/pull/11' },
      ]
      return json(all.filter(p => !base || p.base.ref === base))
    }
    const files = url.match(/\/repos\/o\/r\/pulls\/(\d+)\/files/)
    if (files) return json(files[1] === '7' ? [{ filename: 'src/auth.py' }, { filename: 'src/session.py' }] : [{ filename: 'src/orders.py' }])
    if (u.pathname === '/user') return opts.login ? json({ login: opts.login }) : json({ message: 'bad credentials' }, 401)
    if (u.pathname === '/repos/o/r/issues/7/comments' && method === 'GET') return json(comments)
    if (u.pathname === '/repos/o/r/issues/7/comments' && method === 'POST') { const c = { id: 500, body: (init!.body && JSON.parse(String(init!.body)).body), html_url: 'https://github.com/o/r/pull/7#issuecomment-500', user: { login: opts.login } }; comments.push(c); return json(c, 201) }
    const patch = url.match(/\/repos\/o\/r\/issues\/comments\/(\d+)$/)
    if (patch && method === 'PATCH') { const c = comments.find(x => x.id === Number(patch[1])); c.body = JSON.parse(String(init!.body)).body; return json(c) }
    return json({ message: 'not found' }, 404)
  }) as unknown as typeof fetch
  return { fetch: f, calls, comments }
}

describe('GitHub proxy: open pull requests', () => {
  it('lists open PRs targeting the branch with their files, using the given token', async () => {
    const gh = fakeGitHub()
    const p = new GitHubProxy({ fetch: gh.fetch })
    const prs = await p.openPrs('gho_x', 'o/r', 'main')
    expect(prs).toEqual([
      { number: 7, title: 'Add login', author: 'kieran', head: 'feat/login', files: ['src/auth.py', 'src/session.py'], updatedAt: '2026-09-15T10:00:00Z', url: 'https://github.com/o/r/pull/7' },
      { number: 9, title: 'Fix orders', author: 'sam', head: 'fix/orders', files: ['src/orders.py'], updatedAt: '2026-09-15T09:00:00Z', url: 'https://github.com/o/r/pull/9' },
    ])
    expect(gh.calls[0].url).toContain('/repos/o/r/pulls?state=open&base=main')
    expect(gh.calls.every(c => c.auth === 'Bearer gho_x')).toBe(true)
    // a branch with a slash is encoded
    await p.openPrs('gho_x', 'o/r', 'feature/x')
    expect(gh.calls.at(-1)!.url).toContain('base=feature%2Fx')
  })

  it('caches the list for 60s per repo+branch', async () => {
    const gh = fakeGitHub()
    let t = 0
    const p = new GitHubProxy({ fetch: gh.fetch, now: () => t })
    await p.openPrs('gho_x', 'o/r', 'main')
    const n = gh.calls.length
    await p.openPrs('gho_x', 'o/r', 'main')
    expect(gh.calls.length).toBe(n) // served from cache
    await p.openPrs('gho_x', 'o/r', 'dev')
    expect(gh.calls.length).toBeGreaterThan(n) // another branch is another key
    t = 61_000
    await p.openPrs('gho_x', 'o/r', 'main')
    expect(gh.calls.filter(c => c.url.includes('base=main')).length).toBe(2)
  })

  it('reports GitHub failures with the status', async () => {
    const p = new GitHubProxy({ fetch: (async () => new Response('{"message":"bad"}', { status: 401 })) as unknown as typeof fetch })
    await expect(p.openPrs('bad', 'o/r', 'main')).rejects.toMatchObject({ status: 401 })
  })
})

describe('GitHub proxy: one ledger comment per PR', () => {
  it('creates the comment with the marker when the user has none', async () => {
    const gh = fakeGitHub({ login: 'octo', comments: [{ id: 1, body: 'unrelated', user: { login: 'octo' } }, { id: 2, body: `${LEDGER_MARKER}\nsomeone else's ledger`, user: { login: 'kieran' } }] })
    const p = new GitHubProxy({ fetch: gh.fetch })
    const r = await p.upsertNote('gho_x', 'o/r', 7, '### ledger\n- a')
    expect(r).toEqual({ id: 500, url: 'https://github.com/o/r/pull/7#issuecomment-500', updated: false })
    const post = gh.calls.find(c => c.method === 'POST')!
    expect(post.body.body.startsWith(LEDGER_MARKER)).toBe(true)
    expect(post.body.body).toContain('- a')
  })

  it('edits the existing marked comment authored by the user instead of posting another', async () => {
    const gh = fakeGitHub({ login: 'octo', comments: [{ id: 42, body: `${LEDGER_MARKER}\nold`, user: { login: 'octo' } }] })
    const p = new GitHubProxy({ fetch: gh.fetch })
    const r = await p.upsertNote('gho_x', 'o/r', 7, `${LEDGER_MARKER}\nnew`)
    expect(r).toMatchObject({ id: 42, updated: true })
    expect(gh.calls.some(c => c.method === 'POST')).toBe(false)
    expect(gh.calls.find(c => c.method === 'PATCH')!.url).toMatch(/\/issues\/comments\/42$/)
    expect(gh.comments[0].body).toBe(`${LEDGER_MARKER}\nnew`)
    // the login lookup is cached per token
    await p.upsertNote('gho_x', 'o/r', 7, 'again')
    expect(gh.calls.filter(c => c.url.endsWith('/user')).length).toBe(1)
  })

  it('fails when the token cannot read its user', async () => {
    const gh = fakeGitHub()
    await expect(new GitHubProxy({ fetch: gh.fetch }).upsertNote('gho_x', 'o/r', 7, 'x')).rejects.toMatchObject({ status: 401 })
  })
})
