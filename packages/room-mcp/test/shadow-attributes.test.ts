import './shadow-controlled-fixture.js'
import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { setGitObserver } from '@room/roomd/git'
import { ConflictShadow } from '../src/conflict-shadow.js'
import { ShadowGraph } from '../src/shadow-graph.js'
import { captureShadow } from '../src/shadow-snapshot.js'
import { registryForDir } from '../src/worker-registry.js'
import { stabilityFixture } from './shadow-stability-fixture.js'
import { git, put, repo, world } from './worker-refresh-fixture.js'

async function snapshot() {
  const graph = new ShadowGraph(path.join(repo, '.git/room/shadow/attributes'), repo)
  await graph.init()
  return captureShadow(graph, repo, git(repo, 'rev-parse', 'HEAD'))
}
function globalLfs() {
  const config = path.join(repo, '.git', 'test-global-config')
  fs.writeFileSync(config, '[filter "lfs"]\nclean = git-lfs clean -- %f\nsmudge = git-lfs smudge -- %f\nprocess = git-lfs filter-process\nrequired = true\n[merge "unused"]\ndriver = false\n')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
}

it('models an unused globally configured LFS filter and merge driver', async () => {
  globalLfs()
  expect((await snapshot()).entries.has('shared.txt')).toBe(true)
})
it.each([
  ['outside/** filter=lfs merge=unused text eol=crlf working-tree-encoding=UTF-16 ident\n', true],
  ['*.txt linguist-generated linguist-language=Text diff=custom export-ignore\n', true],
  ['*.txt -filter -text -ident !merge\n', false],
] as const)('models only absent relevant attributes on covered paths: %s', async (attributes, modelled) => {
  globalLfs()
  put(repo, '.gitattributes', attributes)
  if (modelled) expect((await snapshot()).entries.has('shared.txt')).toBe(true)
  else await expect(snapshot()).rejects.toThrow('unmodelled history: attribute filter=unset')
})
it('ignores attributes on excluded, oversized and binary paths', async () => {
  globalLfs()
  put(repo, '.roomignore', 'private.txt\n')
  put(repo, 'private.txt', 'hidden\n')
  put(repo, 'big.txt', 'x'.repeat(512 * 1024 + 1))
  fs.writeFileSync(path.join(repo, 'binary.txt'), Buffer.from([0xff]))
  put(repo, '.gitattributes', 'private.txt filter=lfs\nbig.txt eol=crlf\nbinary.txt merge=unused\nbuild/** ident\n')
  const scan = await snapshot()
  expect(scan.entries.has('shared.txt')).toBe(true)
  for (const file of ['private.txt', 'big.txt', 'binary.txt']) expect(scan.gaps.has(file)).toBe(true)
})
it('resolves info/attributes and a global attributes file by covered path', async () => {
  const attrs = path.join(repo, '.git', 'test-attributes')
  fs.writeFileSync(attrs, 'outside/** filter=lfs\n*.txt linguist-generated\n')
  git(repo, 'config', 'core.attributesFile', attrs)
  fs.writeFileSync(path.join(repo, '.git/info/attributes'), 'outside/** ident\n')
  expect((await snapshot()).entries.has('shared.txt')).toBe(true)
  fs.appendFileSync(attrs, 'shared.txt ident\n')
  await expect(snapshot()).rejects.toThrow('attribute ident=set on "shared.txt"')
})
it('queries all covered paths in one NUL-delimited check-attr batch', async () => {
  const calls: string[][] = []
  put(repo, 'other.txt', 'other\n')
  setGitObserver(args => { if (args[0] === 'check-attr') calls.push([...args]) })
  try {
    expect((await snapshot()).entries.has('other.txt')).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('--stdin')
    expect(calls[0]).toContain('-z')
  } finally { setGitObserver(undefined) }
})
it.each([
  ['filter=lfs', 'filter=lfs'], ['eol=crlf', 'eol=crlf'], ['merge=custom', 'merge=custom'],
  ['text', 'text=set'], ['text=auto', 'text=auto'], ['text=input', 'text=input'],
  ['crlf', 'crlf=set'], ['crlf=input', 'crlf=input'], ['crlf=auto', 'crlf=auto'],
  ['working-tree-encoding=UTF-16', 'working-tree-encoding=UTF-16'], ['ident', 'ident=set'],
  ['-merge', 'merge=unset'], ['merge=union', 'merge=union'],
])('skips a covered path with %s and identifies the attribute and example path', async (setting, reason) => {
  put(repo, '.gitattributes', `shared.txt ${setting}\n`)
  await expect(snapshot()).rejects.toThrow(`unmodelled history: attribute ${reason} on "shared.txt"`)
})
it('skips an active globally configured LFS filter without invoking it', async () => {
  globalLfs()
  put(repo, '.gitattributes', 'shared.txt filter=lfs\n')
  await expect(snapshot()).rejects.toThrow('attribute filter=lfs on "shared.txt"')
})
it('checks deleted covered paths too', async () => {
  fs.unlinkSync(path.join(repo, 'shared.txt'))
  put(repo, '.gitattributes', 'shared.txt filter=lfs\n')
  await expect(snapshot()).rejects.toThrow('attribute filter=lfs on "shared.txt"')
})
it.each(['true', 'input'])('skips implicit core.autocrlf=%s conversion on covered paths', async value => {
  git(repo, 'config', 'core.autocrlf', value)
  await expect(snapshot()).rejects.toThrow('configuration core.autocrlf on')
  put(repo, '.gitattributes', '* -text\n')
  await expect(snapshot()).rejects.toThrow('configuration core.autocrlf on')
})
it('rejects merge.default even with explicit text merges', async () => {
  git(repo, 'config', 'merge.default', 'custom')
  await expect(snapshot()).rejects.toThrow('configuration merge.default on')
  put(repo, '.gitattributes', '* merge=text\n')
  await expect(snapshot()).rejects.toThrow('configuration merge.default on')
})
it('skips checkout attribute overrides and keeps private merges independent of global attributes', async () => {
  const config = path.join(process.env.XDG_CONFIG_HOME!, 'git')
  fs.mkdirSync(config, { recursive: true })
  fs.writeFileSync(path.join(config, 'attributes'), '* merge=union\n')
  fs.writeFileSync(path.join(repo, '.git/info/attributes'), '* merge=text\n')
  const graph = new ShadowGraph(path.join(repo, '.git/room/shadow/global-attributes'), repo)
  await graph.init()
  const head = git(repo, 'rev-parse', 'HEAD')
  await expect(captureShadow(graph, repo, head)).rejects.toThrow('attribute merge=text')
  const entries = await graph.entries(head)
  const anchor = await graph.event('spawn', await graph.tree(entries), [])
  const a = new Map(entries), b = new Map(entries)
  a.set('shared.txt', { mode: '100644', oid: await graph.blob('A\n') })
  b.set('shared.txt', { mode: '100644', oid: await graph.blob('B\n') })
  const aa = await graph.event('observation', await graph.tree(a), [anchor])
  const bb = await graph.event('observation', await graph.tree(b), [anchor])
  expect((await graph.compare(aa, bb)).paths).toEqual(['shared.txt'])
})
it.each(['filter=lfs', 'eol=crlf', 'merge=custom'])('logs a covered worker %s once and stops comparing it', async setting => {
  const f = await stabilityFixture()
  const log = vi.spyOn(f.shadow as any, 'log')
  try {
    put(f.d.dir, '.gitattributes', `shared.txt ${setting}\n`)
    await f.publish(1)
    await f.internal.pass(); f.advance(60_001); await f.internal.pass()
    expect(f.internal.actors.has(f.d.name)).toBe(false)
    const diagnostics = log.mock.calls.filter(([line]) => String(line).startsWith('conflict shadow: unmodelled history:'))
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0][0]).toContain(`attribute ${setting} on "shared.txt"`)
    expect(diagnostics[0][0]).toContain(f.d.name)
  } finally { f.shadow.stop() }
})
it.each(['filter=lfs', 'eol=crlf', 'merge=custom'])('preserves the %s diagnostic when an initial queued snapshot is skipped', async setting => {
  const t = world(), d = await t.spawn('d'), log = vi.fn()
  const shadow = new ConflictShadow(t.leadSession(), log)
  try {
    put(d.dir, '.gitattributes', `shared.txt ${setting}\n`)
    const record = (await (await registryForDir(repo)).read(d.id))!
    const ticket = shadow.reserve('spawn', shadow.preparation(), d.id)!
    shadow.enqueue(() => ({ kind: 'spawn', record, supplied: false }), ticket)
    await shadow.idle(); await shadow.idle()
    expect(log.mock.calls.filter(([line]) => line.includes(`attribute ${setting} on "shared.txt"`))).toHaveLength(1)
    expect((shadow as any).actors.has(d.name)).toBe(false)
  } finally { shadow.stop() }
})
