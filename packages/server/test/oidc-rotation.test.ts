/** OIDC key and endpoint rotation: a token signed with a newly published key verifies after one JWKS
 *  refresh, discovery is refreshed on a finite schedule, and invalid signatures never cause refetching. */
import { describe, it, expect } from 'vitest'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { Auth, OIDC_DISCOVERY_TTL_MS, OIDC_JWKS_REFRESH_COOLDOWN_MS } from '../src/auth.js'

const ISSUER = 'https://idp.example.com'
const CLIENT = 'room-client'

async function key(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' } }
}

/** An IdP whose published keys, signing key and token endpoint the test changes between logins. */
async function rotatingIdp() {
  const state = {
    published: [await key('k1')], signWith: '' as string, tokenPath: '/token', discoveryFails: false,
    nonce: '', counts: { discovery: 0, jwks: 0 } as Record<string, number>, tokenUrls: [] as string[],
    forge: false, now: Date.now(),
  }
  state.signWith = 'k1'
  const extra = await key('stranger')
  const f = (async (url: string) => {
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      state.counts.discovery++
      if (state.discoveryFails) return json({}, 503)
      return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}${state.tokenPath}`, jwks_uri: `${ISSUER}/jwks` })
    }
    if (url === `${ISSUER}/jwks`) { state.counts.jwks++; return json({ keys: state.published.map(k => k.jwk) }) }
    if (url.startsWith(`${ISSUER}/token`)) {
      state.tokenUrls.push(url)
      const signer = state.published.find(k => k.kid === state.signWith) ?? (state.signWith === extra.kid ? extra : undefined)
      if (!signer) throw new Error(`no key ${state.signWith}`)
      const id_token = await new SignJWT({ email: 'ann@example.com', email_verified: true, nonce: state.nonce })
        .setProtectedHeader({ alg: 'RS256', kid: state.forge ? state.published[0]!.kid : signer.kid })
        .setIssuer(ISSUER).setAudience(CLIENT).setSubject('sub-1').setIssuedAt(Math.floor(state.now / 1000)).setExpirationTime(Math.floor(state.now / 1000) + 300).sign(signer.privateKey)
      return json({ id_token })
    }
    return json({}, 404)
  }) as unknown as typeof fetch
  return { fetch: f, state, key, extra }
}

function setup(idp: Awaited<ReturnType<typeof rotatingIdp>>) {
  const auth = new Auth({ oidc: { issuer: ISSUER, clientId: CLIENT, clientSecret: 's', publicUrl: 'https://room.example.com' }, fetch: idp.fetch, now: () => idp.state.now })
  const login = async () => {
    const start = await auth.start('oidc') as { url: string }
    const u = new URL(start.url)
    idp.state.nonce = u.searchParams.get('nonce')!
    return auth.callbackOidc('CODE', u.searchParams.get('state')!)
  }
  return { auth, login, advance: (ms: number) => { idp.state.now += ms } }
}

describe('OIDC rotation', () => {
  it('refreshes the JWKS once when a token names a key it has not seen', async () => {
    const idp = await rotatingIdp()
    const { login, advance } = setup(idp)
    expect(await login()).toMatchObject({ login: 'ann@example.com' })
    expect(idp.state.counts.jwks).toBe(1)
    // The IdP publishes k2 and signs with it, well inside the JWKS cache period.
    idp.state.published.push(await idp.key('k2')); idp.state.signWith = 'k2'
    advance(60_000 + OIDC_JWKS_REFRESH_COOLDOWN_MS)
    expect(await login()).toMatchObject({ login: 'ann@example.com' })
    expect(idp.state.counts.jwks).toBe(2)
    expect(await login()).toMatchObject({ login: 'ann@example.com' })
    expect(idp.state.counts.jwks).toBe(2)
  })

  it('an unknown key that stays unknown is rejected, and refetching is rate-limited', async () => {
    const idp = await rotatingIdp()
    const { login, advance } = setup(idp)
    await login()
    idp.state.signWith = idp.extra.kid
    advance(OIDC_JWKS_REFRESH_COOLDOWN_MS)
    expect(await login()).toMatchObject({ error: expect.stringMatching(/ID token rejected/) })
    expect(idp.state.counts.jwks).toBe(2)
    for (let i = 0; i < 5; i++) expect(await login()).toMatchObject({ error: expect.stringMatching(/ID token rejected/) })
    expect(idp.state.counts.jwks).toBe(2)
    advance(OIDC_JWKS_REFRESH_COOLDOWN_MS + 1)
    await login()
    expect(idp.state.counts.jwks).toBe(3)
  })

  it('a bad signature under a known key id never refetches the key set', async () => {
    const idp = await rotatingIdp()
    const { login, advance } = setup(idp)
    await login()
    idp.state.signWith = idp.extra.kid; idp.state.forge = true // claims k1, signed by a stranger
    advance(OIDC_JWKS_REFRESH_COOLDOWN_MS * 2)
    for (let i = 0; i < 3; i++) expect(await login()).toMatchObject({ error: expect.stringMatching(/signature/) })
    expect(idp.state.counts.jwks).toBe(1)
  })

  it('refreshes discovery after its lifetime, keeping the last good document while the IdP fails', async () => {
    const idp = await rotatingIdp()
    const { login, advance } = setup(idp)
    await login()
    expect(idp.state.counts.discovery).toBe(1)
    idp.state.tokenPath = '/token2'
    advance(OIDC_DISCOVERY_TTL_MS - 1000)
    await login()
    expect(idp.state.counts.discovery).toBe(1)
    expect(idp.state.tokenUrls.at(-1)).toBe(`${ISSUER}/token`)
    advance(2000)
    await login()
    expect(idp.state.counts.discovery).toBe(2)
    expect(idp.state.tokenUrls.at(-1)).toBe(`${ISSUER}/token2`)
    // A failed refresh keeps the previous document and is not retried on every request.
    idp.state.discoveryFails = true
    advance(OIDC_DISCOVERY_TTL_MS + 1)
    expect(await login()).toMatchObject({ login: 'ann@example.com' })
    expect(await login()).toMatchObject({ login: 'ann@example.com' })
    expect(idp.state.counts.discovery).toBe(3)
  })
})
