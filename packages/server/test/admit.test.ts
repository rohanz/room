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
    expect(await canPush('gho_read', 'o/r')).toBe(false) // a no is not cached
    expect(calls).toBe(3)
    t = 11 * 60 * 1000
    expect(await canPush('gho_ok', 'o/r')).toBe(true)
    expect(calls).toBe(4)
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
