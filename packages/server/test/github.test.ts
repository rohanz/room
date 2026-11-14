import { describe, it, expect } from 'vitest'
import { GitHubProxy, LEDGER_MARKER } from '../src/github.js'
import { WorkSlots } from '../src/http.js'

type Call = { method: string; url: string; body?: any; auth?: string }
/** A scripted GitHub: two open PRs on `main`, one on `dev`; PR 7 has a ledger comment by octo. */
function fakeGitHub(opts: { login?: string | null; comments?: any[]; extraPrs?: any[] } = {}) {
  const login = opts.login === undefined ? 'o' : opts.login
  const calls: Call[] = []
  const comments: any[] = opts.comments ?? []
  const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
  const paged = (all: any[], u: URL) => { const per = Number(u.searchParams.get('per_page') ?? '30'), page = Number(u.searchParams.get('page') ?? '1'); return all.slice((page - 1) * per, page * per) }
  const f = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const headers = init?.headers as Record<string, string> | undefined
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers?.authorization })
    const u = new URL(url)
    if (u.pathname === '/repos/o/r/pulls' && method === 'GET') {
      const base = u.searchParams.get('base'), head = u.searchParams.get('head')
      const all = [
        { number: 13, title: 'Huge', user: { login: 'sam' }, head: { ref: 'huge' }, base: { ref: 'big' }, updated_at: '2026-09-15T07:00:00Z', html_url: 'https://github.com/o/r/pull/13' },
        { number: 7, title: 'Add login', user: { login: 'kieran' }, head: { ref: 'feat/login' }, base: { ref: 'main' }, updated_at: '2026-09-15T10:00:00Z', html_url: 'https://github.com/o/r/pull/7' },
        { number: 9, title: 'Fix orders', user: { login: 'sam' }, head: { ref: 'fix/orders' }, base: { ref: 'main' }, updated_at: '2026-09-15T09:00:00Z', html_url: 'https://github.com/o/r/pull/9' },
        { number: 11, title: 'Dev only', user: { login: 'sam' }, head: { ref: 'x' }, base: { ref: 'dev' }, updated_at: '2026-09-15T08:00:00Z', html_url: 'https://github.com/o/r/pull/11' },
        ...(opts.extraPrs ?? []),
      ]
      return json(paged(all.filter(p => (!base || p.base.ref === base) && (!head || `${p.head.user?.login ?? 'o'}:${p.head.ref}` === head)), u))
    }
    if (u.pathname === '/user') return login ? json({ login }) : json({ message: 'bad credentials' }, 401)
    if (u.pathname === '/repos/o/r/issues/7/comments' && method === 'GET') return json(paged(comments, u))
    if (u.pathname === '/repos/o/r/issues/7/comments' && method === 'POST') { const c = { id: 500, body: (init!.body && JSON.parse(String(init!.body)).body), html_url: 'https://github.com/o/r/pull/7#issuecomment-500', user: { login: opts.login } }; comments.push(c); return json(c, 201) }
    const patch = url.match(/\/repos\/o\/r\/issues\/comments\/(\d+)$/)
    if (patch && method === 'PATCH') { const c = comments.find(x => x.id === Number(patch[1])); c.body = JSON.parse(String(init!.body)).body; return json(c) }
    return json({ message: 'not found' }, 404)
  }) as unknown as typeof fetch
  return { fetch: f, calls, comments }
}

describe('GitHub proxy: open pull requests', () => {
  it('coalesces identical in-flight exact heads for one token', async () => {
    let calls = 0, finish!: (value: Response) => void
    const upstream = new Promise<Response>(resolve => { finish = resolve })
    const proxy = new GitHubProxy({ fetch: (async url => {
      if (String(url).endsWith('/user')) return new Response('{"login":"o"}')
      calls++; return upstream
    }) as typeof fetch })
    await proxy.loginOf('token')
    const a = proxy.openPrs('token', 'o/r', 'main')
    const b = proxy.openPrs('token', 'o/r', 'main')
    await new Promise(resolve => setImmediate(resolve))
    expect(calls).toBe(1)
    finish(new Response('[]', { status: 200 }))
    expect(await a).toEqual({ heads: ['o:main'], prs: [] })
    expect(await b).toEqual({ heads: ['o:main'], prs: [] })
  })
  it('caps complete note operations and aborts an in-flight GitHub fetch', async () => {
    const slots = new WorkSlots(8, 2, { reserve: () => () => {} })
    const held = Array.from({ length: 2 }, () => slots.reserve('same:note', 4)!)
    expect(slots.reserve('same:note', 4)).toBeUndefined()
    const controller = new AbortController()
    let aborted = false
    const proxy = new GitHubProxy({ fetch: (async (_url, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true })
    })) as typeof fetch })
    const pending = proxy.upsertNote('token', 'o/r', 1, 'note', controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
    expect(aborted).toBe(true)
    held.forEach(slot => slot.release())
    expect(slots.count).toBe(0)
  })
  it('returns busy for excess concurrent notes while earlier GitHub calls remain pending', async () => {
    let upstream = 0, complete!: (response: Response) => void
    const waiting = new Promise<Response>(resolve => { complete = resolve })
    const proxy = new GitHubProxy({ fetch: (async () => { upstream++; return waiting }) as typeof fetch })
    const slots = new WorkSlots(8, 2, { reserve: () => () => {} })
    const request = () => {
      const slot = slots.reserve('same:note', 100)
      if (!slot) return Promise.resolve(429)
      return proxy.upsertNote('token', 'o/r', 1, 'note').then(() => 200, () => 502).finally(() => slot.release())
    }
    const pending = Array.from({ length: 6 }, request)
    expect(await Promise.all(pending.slice(2))).toEqual([429, 429, 429, 429])
    expect(upstream).toBe(2)
    complete(new Response('{"login":"octo"}', { status: 200 }))
    // The fake returns a user payload for later endpoints; they fail but still settle and release.
    await Promise.all(pending.slice(0, 2))
    expect(slots.count).toBe(0)
  })
  it('returns exact-head metadata without reading files', async () => {
    const gh = fakeGitHub()
    const p = new GitHubProxy({ fetch: gh.fetch })
    const result = await p.openPrs('gho_x', 'o/r', 'feat/login')
    expect(result).toEqual({ heads: ['o:feat/login'], prs: [
      { number: 7, title: 'Add login', author: 'kieran', head: 'feat/login', headOwner: 'o', updatedAt: '2026-09-15T10:00:00Z', url: 'https://github.com/o/r/pull/7' },
    ] })
    expect(gh.calls[1].url).toContain('head=o%3Afeat%2Flogin')
    expect(gh.calls.every(c => c.auth === 'Bearer gho_x')).toBe(true)
    expect(gh.calls).toHaveLength(2) // user plus exact head
    expect(result.prs.every(pr => !('files' in pr) && !('coverage' in pr))).toBe(true)
  })

  it('caches successful empty or nonempty heads for 60s per token, repo and head', async () => {
    const gh = fakeGitHub()
    let t = 0
    const p = new GitHubProxy({ fetch: gh.fetch, now: () => t })
    await p.openPrs('a', 'o/r', 'feat/login')
    await p.openPrs('a', 'o/r', 'feat/login')
    expect(gh.calls.filter(c => c.url.includes('/pulls?'))).toHaveLength(1)
    await p.openPrs('a', 'o/r', 'none')
    await p.openPrs('a', 'o/r', 'none')
    expect(gh.calls.filter(c => c.url.includes('/pulls?'))).toHaveLength(2)
    await p.openPrs('b', 'o/r', 'feat/login')
    expect(gh.calls.filter(c => c.url.includes('/pulls?'))).toHaveLength(3)
    t = 61_000
    await p.openPrs('a', 'o/r', 'feat/login')
    expect(gh.calls.filter(c => c.url.includes('/pulls?'))).toHaveLength(4)
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
    const gh = fakeGitHub({ login: null })
    await expect(new GitHubProxy({ fetch: gh.fetch }).upsertNote('gho_x', 'o/r', 7, 'x')).rejects.toMatchObject({ status: 401 })
  })
})


describe('GitHub proxy: paging and head lookups', () => {
  it('finds the ledger comment on the second page of comments', async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `chatter ${i}`, user: { login: 'kieran' } }))
    const gh = fakeGitHub({ login: 'octo', comments: [...filler, { id: 777, body: `${LEDGER_MARKER}\nold`, user: { login: 'octo' } }] })
    const proxy = new GitHubProxy({ fetch: gh.fetch })
    const r = await proxy.upsertNote('gho_x', 'o/r', 7, 'new')
    expect(r).toMatchObject({ id: 777, updated: true })
    expect(gh.calls.some(c => c.method === 'POST')).toBe(false)
    expect(gh.calls.filter(c => new URL(c.url).pathname === '/repos/o/r/issues/7/comments' && c.method === 'GET').map(c => new URL(c.url).searchParams.get('page'))).toEqual(['1', '2'])
    // with no ledger anywhere, every page is read and a new comment is posted
    const gh2 = fakeGitHub({ login: 'octo', comments: [...filler, { id: 778, body: 'more chatter', user: { login: 'octo' } }] })
    const r2 = await new GitHubProxy({ fetch: gh2.fetch }).upsertNote('gho_x', 'o/r', 7, 'new')
    expect(r2.updated).toBe(false)
    expect(gh2.calls.filter(c => new URL(c.url).pathname === '/repos/o/r/issues/7/comments' && c.method === 'GET').length).toBe(2)
  })
  it('refuses to post a second ledger comment when the comment search did not complete, and retries cleanly', async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `chatter ${i}`, user: { login: 'kieran' } }))
    const gh = fakeGitHub({ login: 'octo', comments: [...filler, { id: 777, body: `${LEDGER_MARKER}\nold`, user: { login: 'octo' } }] })
    let fail = true
    const proxy = new GitHubProxy({ fetch: (async (url: string, init?: RequestInit) => {
      const u = new URL(url)
      if (fail && u.pathname === '/repos/o/r/issues/7/comments' && u.searchParams.get('page') === '2') return new Response('{}', { status: 502 })
      return gh.fetch(url, init)
    }) as typeof fetch })
    await expect(proxy.upsertNote('gho_x', 'o/r', 7, 'new')).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/incomplete.*retry/) })
    expect(gh.calls.some(c => c.method === 'POST' || c.method === 'PATCH')).toBe(false)
    fail = false
    expect(await proxy.upsertNote('gho_x', 'o/r', 7, 'new')).toMatchObject({ id: 777, updated: true })
  })
  it('refuses to post when the comment page ceiling hides whether a ledger exists', async () => {
    const calls: string[] = []
    const proxy = new GitHubProxy({ fetch: (async (url: string, init?: RequestInit) => {
      const u = new URL(url); calls.push(init?.method ?? 'GET')
      if (u.pathname === '/user') return new Response('{"login":"octo"}')
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'chatter', user: { login: 'kieran' } }))))
    }) as typeof fetch })
    await expect(proxy.upsertNote('gho_x', 'o/r', 7, 'new')).rejects.toMatchObject({ status: 503 })
    expect(calls.filter(m => m === 'GET').length).toBe(31) // /user + 30 comment pages
    expect(calls).not.toContain('POST')
  })
  it.each([
    ['same repository', ['o'], 'alice'], ['caller fork', ['alice'], 'alice'],
    ['both', ['o', 'alice'], 'alice'], ['unrelated fork', ['bob'], 'alice'],
    ['none', [], 'alice'], ['login equals upstream', ['o'], 'o'],
  ] as const)('queries only upstream and caller heads: %s', async (_label, owners, login) => {
    const extraPrs = owners.map((owner, i) => ({ number: 40 + i, head: { ref: 'topic', user: { login: owner } }, base: { ref: 'main' } }))
    const gh = fakeGitHub({ login, extraPrs })
    const result = await new GitHubProxy({ fetch: gh.fetch }).openPrs('tok', 'o/r', 'topic')
    const expected = owners.filter(owner => owner === 'o' || owner === login)
    expect(result.prs.map(pr => pr.headOwner)).toEqual(expected)
    expect(result.heads).toEqual(login.toLowerCase() === 'o' ? ['o:topic'] : ['o:topic', 'alice:topic'])
    const calls = gh.calls.filter(c => c.url.includes('/pulls?')).map(c => new URL(c.url))
    expect(calls.map(u => u.searchParams.get('head'))).toEqual(result.heads)
    expect(calls.every(u => !u.searchParams.has('page') && !u.searchParams.has('base'))).toBe(true)
  })

  it('does not treat a failed head request as a successful unique match or cache the failure', async () => {
    const gh = fakeGitHub({ login: 'alice' })
    let fail = true
    const calls: string[] = []
    const proxy = new GitHubProxy({ fetch: (async (url, init) => {
      const head = new URL(String(url)).searchParams.get('head')
      if (head) calls.push(head)
      if (head === 'alice:feat/login' && fail) return new Response('{}', { status: 500 })
      return gh.fetch(url, init)
    }) as typeof fetch })
    await expect(proxy.openPrs('t', 'o/r', 'feat/login')).rejects.toThrow(/lookup failed.*alice:feat\/login.*number=<n>/)
    fail = false
    expect((await proxy.openPrs('t', 'o/r', 'feat/login')).prs.map(pr => pr.number)).toEqual([7])
    expect(calls).toEqual(['o:feat/login', 'alice:feat/login', 'alice:feat/login'])
  })

  it('awaits the other exact head before reporting a failed request', async () => {
    let finish!: (response: Response) => void, settled = false
    const held = new Promise<Response>(resolve => { finish = resolve })
    const proxy = new GitHubProxy({ fetch: (async url => {
      if (String(url).endsWith('/user')) return new Response('{"login":"alice"}')
      return new URL(String(url)).searchParams.get('head') === 'o:topic' ? new Response('{}', { status: 500 }) : held
    }) as typeof fetch })
    const pending = proxy.openPrs('t', 'o/r', 'topic').finally(() => { settled = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    finish(new Response('[]'))
    await expect(pending).rejects.toThrow('lookup failed')
  })

  it('unions results by PR number', async () => {
    const proxy = new GitHubProxy({ fetch: (async url => new Response(JSON.stringify(String(url).endsWith('/user')
      ? { login: 'alice' } : [{ number: 7, head: { ref: 'topic', user: { login: 'o' } } }]))) as typeof fetch })
    expect((await proxy.openPrs('t', 'o/r', 'topic')).prs.map(pr => pr.number)).toEqual([7])
  })

  it.each(['o', 'O', 'alice'])('bounds requests per note at 1,500 unrelated PRs (login %s)', async login => {
    const extraPrs = Array.from({ length: 1500 }, (_, i) => ({ number: 1000 + i, head: { ref: 'other', user: { login: 'bob' } }, base: { ref: 'main' } }))
    const gh = fakeGitHub({ login, extraPrs })
    let now = 0
    const proxy = new GitHubProxy({ fetch: gh.fetch, now: () => now })
    const lookup = await proxy.openPrs('t', 'o/r', 'feat/login')
    expect(lookup.prs.map(pr => pr.number)).toEqual([7])
    await proxy.upsertNote('t', 'o/r', 7, 'ledger')
    expect(gh.calls.filter(call => call.url.includes('/pulls?'))).toHaveLength(login.toLowerCase() === 'o' ? 1 : 2)
    expect(gh.calls).toHaveLength(login.toLowerCase() === 'o' ? 4 : 5) // user, head(s), comments, write
    await proxy.openPrs('t', 'o/r', 'feat/login')
    await proxy.upsertNote('t', 'o/r', 7, 'updated')
    expect(gh.calls).toHaveLength(login.toLowerCase() === 'o' ? 6 : 7) // cached user/heads; comments and write only
    now = 61_000
    await proxy.openPrs('t', 'o/r', 'feat/login')
    await proxy.upsertNote('t', 'o/r', 7, 'after expiry')
    expect(gh.calls).toHaveLength(login.toLowerCase() === 'o' ? 10 : 12)
    expect(gh.calls.filter(call => call.url.endsWith('/user'))).toHaveLength(2)
  })

})
