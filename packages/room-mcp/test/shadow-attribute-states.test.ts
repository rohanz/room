import './shadow-git-fixture.js'
import path from 'node:path'
import { expect, it } from 'vitest'
import { ShadowGraph } from '../src/shadow-graph.js'
import { captureShadow } from '../src/shadow-snapshot.js'
import { git, put, repo } from './worker-refresh-fixture.js'

async function graph() {
  const result = new ShadowGraph(path.join(repo, '.git/room/shadow/attribute-states'), repo)
  await result.init()
  return result
}

it.each(['set', 'unset', 'unspecified'])('rejects an active filter whose driver name is %s', async name => {
  put(repo, '.gitattributes', `shared.txt filter=${name}\n`)
  git(repo, 'config', `filter.${name}.clean`, 'sed s/a/converted/')
  // This independent Git call proves that the named filter is active, despite
  // check-attr rendering its name identically to a special attribute state.
  expect(git(repo, 'hash-object', '--path=shared.txt', 'shared.txt'))
    .not.toBe(git(repo, 'hash-object', '--no-filters', 'shared.txt'))
  const g = await graph()
  await expect(captureShadow(g, repo, git(repo, 'rev-parse', 'HEAD'))).rejects.toThrow('unmodelled history:')
})

it('does not confuse the string text=unset with the boolean -text', async () => {
  put(repo, '.gitattributes', '* -text\nshared.txt text=unset\n')
  put(repo, 'shared.txt', 'a\r\nb\r\nc\r\n')
  git(repo, 'config', 'core.autocrlf', 'true')
  expect(git(repo, 'hash-object', '--path=shared.txt', 'shared.txt'))
    .not.toBe(git(repo, 'hash-object', '--no-filters', 'shared.txt'))
  const g = await graph()
  await expect(captureShadow(g, repo, git(repo, 'rev-parse', 'HEAD'))).rejects.toThrow('unmodelled history:')
})

it.each(['filter', 'merge'])('rejects unused %s drivers with ambiguous state-word names', async kind => {
  const g = await graph(), head = git(repo, 'rev-parse', 'HEAD')
  for (const name of ['set', 'unset', 'unspecified']) {
    const key = `${kind}.${name}.${kind === 'filter' ? 'clean' : 'driver'}`
    git(repo, 'config', key, 'false')
    await expect(captureShadow(g, repo, head)).rejects.toThrow(`attribute configuration on`)
    git(repo, 'config', '--unset', key)
  }
})

it.each(['no', 'off', '0', ''])('rejects core.autocrlf=%s without interpreting boolean spellings', async value => {
  git(repo, 'config', 'core.autocrlf', value)
  const g = await graph()
  await expect(captureShadow(g, repo, git(repo, 'rev-parse', 'HEAD'))).rejects.toThrow('attribute configuration on')
})

it('allows explicit core.autocrlf=false but refuses any merge.default setting', async () => {
  git(repo, 'config', 'core.autocrlf', 'false')
  const g = await graph(), head = git(repo, 'rev-parse', 'HEAD')
  expect((await captureShadow(g, repo, head)).entries.has('shared.txt')).toBe(true)
  for (const value of ['text', '']) {
    git(repo, 'config', 'merge.default', value)
    await expect(captureShadow(g, repo, head)).rejects.toThrow('attribute configuration on')
  }
})
