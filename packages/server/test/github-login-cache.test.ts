import { expect, it } from 'vitest'
import { GitHubProxy } from '../src/github.js'

it('finds the token owner under its new login after the lookup cache expires', async () => {
  let now = 0, login = 'alice', hasPr = false
  const proxy = new GitHubProxy({ now: () => now, fetch: (async input => {
    const url = new URL(String(input))
    if (url.pathname === '/user') return new Response(JSON.stringify({ login }))
    expect(url.pathname).toBe('/repos/org/repo/pulls')
    const head = url.searchParams.get('head')
    return new Response(JSON.stringify(hasPr && (!head || head === `${login}:feature`)
      ? [{ number: 7, head: { ref: 'feature', user: { login } } }] : []))
  }) as typeof fetch })
  const lookup = async () => (await proxy.openPrs('same-token', 'org/repo', 'feature')).prs
  expect(await lookup()).toEqual([])
  login = 'renamed-alice'; hasPr = true
  now = 59_000
  expect(await lookup()).toEqual([]) // a hit does not extend either cached value's lifetime
  now = 61_000
  expect((await lookup()).map(pr => pr.number)).toEqual([7])
})
