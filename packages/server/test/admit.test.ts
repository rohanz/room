import { describe, it, expect } from 'vitest'
import { Auth } from '../src/auth.js'
import { makeAdmitted, githubPushChecker } from '../src/admit.js'

const GH = 'github.com/o/r/main'
const LOCAL = 'local/dir/main'

/** A GitHub whose only pushable token is gho_ok on o/r. */
const pushFetch = (async (url: string, init?: RequestInit) => {
  const auth = (init?.headers as Record<string, string>).authorization
  if (url === 'https://api.github.com/repos/o/r' && auth === 'Bearer gho_ok') return new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 })
  if (url === 'https://api.github.com/repos/o/r') return new Response(JSON.stringify({ permissions: { push: false } }), { status: 200 })
  return new Response('{}', { status: 404 })
}) as unknown as typeof fetch

async function githubLogin(a: Auth, login: string): Promise<string> {
  const { device } = await a.startDevice()
  const r = await a.poll(device, { fakeLogin: login })
  return (r as { session: string }).session
}

describe('admission: github.com rooms', () => {
  it('a forwarded GitHub token is refused with 401 pointing at room_login, with and without GitHub login configured', async () => {
    for (const auth of [new Auth({}), new Auth({ clientId: 'fake', production: false }), new Auth({ clientId: 'fake', production: false })]) {
      const admitted = makeAdmitted({ auth, token: 'shared', canPush: async () => true })
      const v = await admitted(GH, { gh: 'gho_ok' })
      expect(v).toMatchObject({ ok: false, status: 401 })
      expect((v as { why: string }).why).toContain('room_login')
      expect((v as { why: string }).why).toContain('forwarded GitHub tokens are not accepted')
      // even alongside a valid ROOM_TOKEN
      expect(await admitted(GH, { gh: 'gho_ok', token: 'shared' })).toMatchObject({ ok: false, status: 401 })
    }
  })

  it('ROOM_TOKEN never admits a github.com room', async () => {
    const auth = new Auth({})
    const admitted = makeAdmitted({ auth, token: 'shared', canPush: async () => true })
    const v = await admitted(GH, { token: 'shared' })
    expect(v).toMatchObject({ ok: false, status: 401 })
    expect((v as { why: string }).why).toMatch(/ROOM_TOKEN does not admit GitHub rooms.*room_login/)
    // but the same token admits a non-GitHub room
    expect(await admitted(LOCAL, { token: 'shared' })).toEqual({ ok: true })
    expect(await admitted(LOCAL, { token: 'wrong' })).toMatchObject({ ok: false, status: 401 })
  })

  it('without GitHub login configured, github.com rooms cannot be entered at all', async () => {
    const admitted = makeAdmitted({ auth: new Auth({}), canPush: async () => true })
    const v = await admitted(GH, {})
    expect(v).toMatchObject({ ok: false, status: 401 })
    expect((v as { why: string }).why).toContain('GITHUB_CLIENT_ID')
  })

  it('a GitHub login session is admitted when its token can push, refused (403) when it cannot', async () => {
    const auth = new Auth({ clientId: 'fake', production: false })
    const admitted = makeAdmitted({ auth, canPush: async (t) => t === 'fake:octo' })
    const octo = await githubLogin(auth, 'octo')
    expect(await admitted(GH, { session: octo })).toEqual({ ok: true, login: 'octo', provider: 'github' })
    expect(await admitted(GH, { session: 'nope' })).toMatchObject({ ok: false, status: 401, why: expect.stringContaining('room_login') })
    expect(await admitted(GH, {})).toMatchObject({ ok: false, status: 401, why: expect.stringContaining('room_login') })
  })

  it('a github.com room named without a branch is still held to the GitHub rules, never the shared-token ones', async () => {
    const admitted = makeAdmitted({ auth: new Auth({}), token: 'shared', canPush: async () => true })
    expect(await admitted('github.com/o/r', { token: 'shared' })).toMatchObject({ ok: false, status: 401 })
    expect(await admitted('github.com/o/r/main', { token: 'shared' })).toMatchObject({ ok: false, status: 401 })
  })

  it('the fake issuer admits every fake login to every github.com room (tests and demo only)', async () => {
    const auth = new Auth({ clientId: 'fake', production: false })
    const admitted = makeAdmitted({ auth, canPush: async () => false })
    const kieran = await githubLogin(auth, 'kieran')
    expect(await admitted('github.com/any/repo/dev', { session: kieran })).toEqual({ ok: true, login: 'kieran', provider: 'github' })
  })

  it('the real push check asks GitHub for push permission and caches a yes', async () => {
    let t = 0
    let calls = 0
    const counting = ((...a: Parameters<typeof fetch>) => { calls++; return pushFetch(...a) }) as typeof fetch
    const canPush = githubPushChecker({ fetch: counting, now: () => t })
    expect(await canPush('gho_ok', 'o/r')).toBe(true)
    expect(await canPush('gho_ok', 'o/r')).toBe(true)
    expect(calls).toBe(1)
    expect(await canPush('gho_read', 'o/r')).toBe(false)
    expect(await canPush('gho_read', 'o/r')).toBe(false) // definite denial is cached briefly
    expect(calls).toBe(2)
    t = 11 * 60 * 1000
    expect(await canPush('gho_ok', 'o/r')).toBe(true)
    expect(calls).toBe(3)
  })

  it('a fresh denial clears a previously cached push grant', async () => {
    let allowed = true, calls = 0
    const check = githubPushChecker({ fetch: (async () => { calls++; return new Response(JSON.stringify({ permissions: { push: allowed } }), { status: 200 }) }) as typeof fetch })
    expect(await check('token', 'o/r')).toBe(true)
    allowed = false
    expect(await check('token', 'o/r')).toBe(true) // ordinary admission uses the positive cache
    expect(await check('token', 'o/r', true)).toBe(false)
    expect(await check('token', 'o/r')).toBe(false)
    expect(calls).toBe(2)
  })
})

describe('admission: non-GitHub rooms', () => {
  it('open when the server has neither a provider nor ROOM_TOKEN', async () => {
    expect(await makeAdmitted({ auth: new Auth({}) })(LOCAL, {})).toEqual({ ok: true })
  })
  it('with a login provider, any session is admitted and a missing or stale one is 401', async () => {
    const auth = new Auth({ clientId: 'fake', production: false })
    const admitted = makeAdmitted({ auth })
    const s = await githubLogin(auth, 'octo')
    expect(await admitted('git/gitlab.example/o/r/main', { session: s })).toMatchObject({ ok: true, login: 'octo' })
    expect(await admitted(LOCAL, {})).toMatchObject({ ok: false, status: 401, why: expect.stringContaining('room_login') })
    expect(await admitted(LOCAL, { session: 'stale' })).toMatchObject({ ok: false, status: 401, why: expect.stringContaining('expired or unknown') })
    // a gh token is simply ignored here: it is not a credential
    expect(await admitted(LOCAL, { gh: 'gho_ok' })).toMatchObject({ ok: false, status: 401 })
  })
})

it('coalesces permission checks and caches definite denials for only 60 seconds', async () => {
  let t = 0, calls = 0, finish!: (r: Response) => void
  const check = githubPushChecker({ now: () => t, fetch: (async () => { calls++; return new Promise<Response>(resolve => { finish = resolve }) }) as typeof fetch })
  const a = check('holder', 'o/r'), b = check('holder', 'o/r', true)
  expect(calls).toBe(1)
  finish(new Response('{}', { status: 403 }))
  expect(await a).toBe(false); expect(await b).toBe(false)
  expect(await check('holder', 'o/r')).toBe(false)
  expect(calls).toBe(1)
  t = 60_000
  const expired = check('holder', 'o/r')
  expect(calls).toBe(2)
  finish(new Response('{}', { status: 500 }))
  expect(await expired).toBeUndefined()
  const retry = check('holder', 'o/r')
  expect(calls).toBe(3)
  finish(new Response('{}', { status: 404 })); await retry
  check.forget('holder')
  const loggedOut = check('holder', 'o/r')
  expect(calls).toBe(4)
  finish(new Response('{}', { status: 404 })); await loggedOut
})

it('does not cache network failures, 5xx or missing permission data', async () => {
  for (const fail of [() => { throw new Error('offline') }, () => new Response('{}', { status: 503 }), () => new Response('{}')]) {
    let calls = 0
    const check = githubPushChecker({ fetch: (async () => { calls++; return fail() }) as typeof fetch })
    expect(await check('token', 'o/r')).toBeUndefined()
    expect(await check('token', 'o/r')).toBeUndefined()
    expect(calls).toBe(2)
  }
})

it('logout removes a holder cache even if its permission fetch is pending', async () => {
  let finish!: (value: Response) => void, calls = 0
  const check = githubPushChecker({ fetch: (async () => { calls++; return new Promise<Response>(resolve => { finish = resolve }) }) as typeof fetch })
  const pending = check('token', 'o/r')
  check.forget('token')
  finish(new Response('{}', { status: 403 })); await pending
  const next = check('token', 'o/r')
  expect(calls).toBe(2)
  finish(new Response('{}', { status: 403 })); await next
})

it('session logout and expiry clear the removed holder permission entries', async () => {
  let now = 0, calls = 0
  const checker = githubPushChecker({ fetch: (async () => { calls++; return new Response('{}', { status: 403 }) }) as typeof fetch })
  const auth = new Auth({ clientId: 'fake', production: false, now: () => now, sessionTtlMs: 1000,
    onSessionRemoved: (_session, _reason, removed) => { if (removed?.ghToken) checker.forget(removed.ghToken) } })
  for (const reason of ['logout', 'expiry']) {
    const session = await githubLogin(auth, 'holder')
    await checker('fake:holder', 'o/r'); await checker('fake:holder', 'o/r')
    if (reason === 'logout') auth.logout(session)
    else { now += 1001; auth.sweepSessions() }
    await checker('fake:holder', 'o/r')
  }
  expect(calls).toBe(3)
})

it('logout keeps an upstream check coalesced but prevents its result repopulating the cache', async () => {
  let calls = 0, finish!: (r: Response) => void
  const checker = githubPushChecker({ fetch: (async () => { calls++; return new Promise<Response>(resolve => { finish = resolve }) }) as typeof fetch })
  const a = checker('token', 'o/r')
  checker.forget('token')
  const b = checker('token', 'o/r')
  expect(calls).toBe(1)
  finish(new Response('{}', { status: 403 })); await Promise.all([a, b])
  const c = checker('token', 'o/r')
  expect(calls).toBe(2)
  finish(new Response('{}', { status: 403 })); await c
})

it('treats GitHub rate limiting as unavailable, not as a denial: the grant survives and nothing is cached', async () => {
  // GitHub answers 403 (or 429) for primary and secondary rate limits as well as for real denials.
  const limited: (() => Response)[] = [
    () => new Response('{"message":"API rate limit exceeded for user ID 1."}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' } }),
    () => new Response('{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}', { status: 403, headers: { 'retry-after': '60' } }),
    () => new Response('{"message":"You have exceeded a secondary rate limit."}', { status: 403 }),
    () => new Response('{}', { status: 429 }),
  ]
  for (const throttle of limited) {
    let t = 0, mode: 'ok' | 'limited' = 'ok', calls = 0
    const check = githubPushChecker({ now: () => t, fetch: (async () => { calls++; return mode === 'ok' ? new Response('{"permissions":{"push":true}}') : throttle() }) as typeof fetch })
    expect(await check('holder', 'o/r')).toBe(true)
    mode = 'limited'
    // A revalidation (fresh) during throttling is "unavailable": the caller keeps existing sockets.
    expect(await check('holder', 'o/r', true)).toBeUndefined()
    // The earlier grant is still in the positive cache for ordinary admission.
    expect(await check('holder', 'o/r')).toBe(true)
    mode = 'ok'
    expect(await check('holder', 'o/r', true)).toBe(true)
    expect(calls).toBe(3)
    t += 1
  }
  // A plain 403 without rate-limit signals is still a denial.
  const denied = githubPushChecker({ fetch: (async () => new Response('{"message":"Must have admin rights to Repository."}', { status: 403 })) as typeof fetch })
  expect(await denied('holder', 'o/r')).toBe(false)
})
