import { LINES, base, carry, commitLines, git, lead, previewSetup, put, root, setup, worker } from './collect-fixture.js'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { HandlerState } from '../src/tools/context.js'
import { handlers as fileHandlers, linkSharedDirs, materializeMergedFile } from '../src/tools/files.js'
import { publishFixture } from './fixtures/manifest.js'
import { workerByTag } from './registry-fixture.js'

describe('worker preview', () => {
  it('does not link dependencies through an archived symlink ancestor', async () => {
    const scratch = path.join(root, 'scratch'), outside = path.join(root, 'outside')
    fs.mkdirSync(path.join(lead, 'packages', 'pkg', 'node_modules', 'dep'), { recursive: true })
    fs.mkdirSync(path.join(scratch, 'packages'), { recursive: true })
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(scratch, 'packages', 'pkg'))
    await expect(linkSharedDirs(lead, scratch)).rejects.toThrow(/unsafe merged ancestor|escapes scratch tree/)
    expect(fs.existsSync(path.join(outside, 'node_modules'))).toBe(false)
  })

  it('yields within package discovery, including skipped package directories', async () => {
    const scratch = path.join(root, 'scratch')
    fs.mkdirSync(scratch)
    for (let i = 0; i < 2_000; i++) fs.mkdirSync(path.join(lead, 'packages', `pkg-${String(i).padStart(4, '0')}`), { recursive: true })
    const exists = fs.existsSync.bind(fs)
    let turned = false, lastSawTurn = false
    const seam = vi.spyOn(fs, 'existsSync').mockImplementation((file: fs.PathLike) => {
      if (String(file).endsWith('pkg-0000/node_modules')) setImmediate(() => { turned = true })
      if (String(file).endsWith('pkg-1999/node_modules')) lastSawTurn = turned
      return exists(file)
    })
    try {
      await linkSharedDirs(lead, scratch)
      expect(lastSawTurn).toBe(true)
    } finally { seam.mockRestore() }
  })

  it('yields within scoped package links before creating the last symlink', async () => {
    const scratch = path.join(root, 'scratch')
    fs.mkdirSync(path.join(lead, 'node_modules', '@scope'), { recursive: true })
    fs.mkdirSync(scratch)
    for (let i = 0; i < 96; i++) fs.mkdirSync(path.join(lead, 'node_modules', '@scope', `lib-${String(i).padStart(3, '0')}`))
    const symlink = fs.symlinkSync.bind(fs)
    let turned = false, lastSawTurn = false
    const seam = vi.spyOn(fs, 'symlinkSync').mockImplementation(((target: fs.PathLike, file: fs.PathLike, type?: fs.symlink.Type) => {
      if (String(file).endsWith('lib-000')) setImmediate(() => { turned = true })
      if (String(file).endsWith('lib-095')) lastSawTurn = turned
      return symlink(target, file, type)
    }) as typeof fs.symlinkSync)
    try {
      await linkSharedDirs(lead, scratch)
      expect(lastSawTurn).toBe(true)
    } finally { seam.mockRestore() }
  })

  it('refuses a symlink ancestor in the extracted scratch tree', () => {
    const scratch = path.join(root, 'scratch'), outside = path.join(root, 'outside')
    fs.mkdirSync(scratch); fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(scratch, 'config'))
    expect(() => materializeMergedFile(scratch, 'config/value.txt', Buffer.from('secret'))).toThrow('unsafe merged ancestor')
    expect(fs.existsSync(path.join(outside, 'value.txt'))).toBe(false)
  })

  it('does not write through a symlink restored from the ancestor archive', async () => {
    const external = path.join(root, 'external.txt')
    put(root, 'external.txt', 'outside stays intact\n')
    fs.symlinkSync(external, path.join(lead, 'config.txt'))
    git(lead, 'add', 'config.txt'); git(lead, 'commit', '-qm', 'symlink ancestor')
    const head = git(lead, 'rev-parse', 'HEAD')
    git(worker, 'merge', '-q', '--ff-only', head)
    fs.unlinkSync(path.join(lead, 'config.txt'))
    fs.unlinkSync(path.join(worker, 'config.txt'))
    put(lead, 'config.txt', 'safe lead version\n')
    put(worker, 'config.txt', 'safe lead version\n')
    put(worker, 'file.txt', 'worker edit\n')
    const t = await previewSetup()
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [], withheld: () => undefined,
      baseFor: () => head, shareOf: () => 'full', liveText: async () => undefined,
    })
    await t.sync()
    await fileHandlers(t.state).room_preview_merge({ person: 'lead+test', run: 'cat config.txt && echo "1 passed"' })
    expect(fs.readFileSync(external, 'utf8')).toBe('outside stays intact\n')
  })

  it('runs against the same binary bytes and executable mode that collect applies', async () => {
    const t = await previewSetup()
    fs.writeFileSync(path.join(worker, 'fixture.bin'), Buffer.from([0, 255, 1]))
    put(worker, 'run.sh', '#!/bin/sh\necho run\n')
    fs.chmodSync(path.join(worker, 'run.sh'), 0o755)
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [], withheld: () => undefined,
      baseFor: () => base, shareOf: () => 'full', liveText: async () => undefined,
    })
    await t.sync()
    const result = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test', run: 'test "$(od -An -tu1 fixture.bin | tr -s " " | xargs)" = "0 255 1" && test -x run.sh && echo "1 passed"' })
    expect(result).toContain('tests: PASSED (exit 0)')
  })
  it('previews the lead\'s own local intent-only worker from its worktree', async () => {
    const t = await previewSetup()
    put(worker, 'own-output.txt', 'worker output')
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [],
      withheld: () => 'lead+test shares intent only; ask them or wait for their push',
      baseFor: () => base, shareOf: () => 'intent', liveText: async () => undefined,
    })
    await t.sync()
    const result = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test' })
    expect(result).toContain('own-output.txt (lead+test only)')
  })
  it('withholds the lead\'s own intent-only worker once its worktree vanished', async () => {
    const t = await previewSetup()
    fs.rmSync(worker, { recursive: true, force: true })
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [],
      withheld: () => 'lead+test shares intent only; ask them or wait for their push',
      baseFor: () => base, shareOf: () => 'intent', liveText: async () => undefined,
    })
    await t.sync()
    const result = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test' })
    expect(result).toContain("lead+test's worktree no longer exists")
    expect(result).toContain('PARTIAL preview')
    expect(result).toContain('no manifest record')
  })
  it('previews a vanished local worker from its shared overlay instead of its checkout', async () => {
    const t = await previewSetup()
    put(worker, 'disk-only.txt', 'never shared')
    publishFixture(t.s.room, 'lead+test', 'shared.txt', 'shared change\n')
    fs.rmSync(worker, { recursive: true, force: true })
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [], withheld: () => undefined,
      baseFor: () => base, shareOf: () => 'full',
      liveText: async (_s: unknown, p: string) => p === 'shared.txt' ? 'shared change\n' : undefined,
    })
    await t.sync()
    const result = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test' })
    expect(result).toContain("lead+test's worktree no longer exists; previewing its shared overlay instead")
    expect(result).toContain('shared.txt')
    expect(result).not.toContain('disk-only.txt')
  })
  it('collects Unicode UTF-8 bytes unchanged from a worker worktree', async () => {
    const t = await previewSetup()
    const value = Buffer.from('em dash —, CJK 漢, emoji 😀\n', 'utf8')
    fs.writeFileSync(path.join(worker, 'unicode.txt'), value)
    expect(await t.call({ tag: 'test' })).toContain('Changes from test: unicode.txt')
    expect(fs.readFileSync(path.join(lead, 'unicode.txt'))).toEqual(value)
  })

  it.each([true, false])('skips linked and escaping symlinks from both sides (record=%s)', async recorded => {
    put(lead, 'data/input', 'private input')
    put(worker, '.gitignore', 'artifact.bin\ndata/\n')
    fs.symlinkSync(path.join(lead, 'data'), path.join(worker, 'data'))
    put(worker, 'new.txt', 'output')
    const t = setup()
    if (recorded) t.set('test', { ...t.get('test'), link: ['data'] })
    const ws = { ...t.s, dir: worker, me: { name: 'lead+test', kind: 'agent' } }
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [], withheld: () => undefined,
      baseFor: () => base, shareOf: () => 'full', liveText: async () => undefined,
    })
    const reason = recorded ? 'linked input' : 'symlink leaving the worktree'
    await t.sync()
    const leadResult = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test' })
    expect(leadResult).toContain(`NOT previewed (${reason}, lead+test): data`)
    expect(leadResult).toContain('new.txt (lead+test only)')
    t.state.S = () => ws as unknown as ReturnType<HandlerState['S']>
    await t.sync()
    const workerResult = await fileHandlers(t.state).room_preview_merge({ person: 'lead' })
    expect(workerResult).toContain(`NOT previewed (${reason}, lead+test): data`)
    expect(workerResult).toContain('no conflicts')
  })
  it('previews a worker against its carried-in commit, not the lead\'s HEAD', async () => {
    const head = commitLines()
    const t = setup()
    put(lead, 'app.py', LINES.replace('two', 'W')); put(lead, 'notes.txt', 'draft\n')
    carry(t, worker, 'test', { 'app.py': LINES.replace('two', 'W'), 'notes.txt': 'draft\n' })
    put(lead, 'app.py', LINES.replace('two', 'W2')); put(lead, 'notes.txt', 'draft 2\n')
    put(worker, 'app.py', LINES.replace('two', 'W').replace('five', 'WORKER'))
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [], withheld: () => undefined,
      baseFor: (_s: unknown, person: string) => person === 'lead' ? head : workerByTag(lead, 'test')!.base, shareOf: () => 'full',
      liveText: async () => undefined,
    })
    await t.sync()
    const result = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test', run: 'cat app.py notes.txt' })
    expect(result).toContain('both changed, merge cleanly: app.py')
    expect(result).not.toContain('notes.txt (lead+test')
    expect(result).toContain('no conflicts')
    expect(result).toContain('one\nW2\nthree\nfour\nWORKER\nsix\nseven\ndraft 2')
  })
  it('discovers untracked worker paths and explicitly excludes ignored output', async () => {
    put(worker, 'new.txt', 'new\n'); put(worker, 'empty.txt', ''); put(worker, 'artifact.bin', 'artifact')
    const nested = path.join(lead, 'nested'); fs.mkdirSync(nested); git(nested, 'init', '-q')
    const t = await previewSetup()
    Object.assign(t.state, {
      rooms: { ...t.state.rooms, all: () => [t.s], holding: () => t.s },
      others: () => ['lead+test'], presences: () => [], withheld: () => undefined,
      baseFor: () => base, shareOf: () => 'full',
      liveText: async (_s: unknown, p: string, person: string) => {
        try { return fs.readFileSync(path.join(person === 'lead' ? lead : worker, p), 'utf8') }
        catch { return undefined }
      },
    })
    await t.sync()
    const result = await fileHandlers(t.state).room_preview_merge({ person: 'lead+test', run: 'cat new.txt' })
    expect(result).toContain('new.txt (lead+test only)')
    expect(result).toContain('NOT previewed (gitignored, lead+test): artifact.bin')
    expect(result).toContain('empty.txt (lead+test only)')
    expect(result).toContain('NOT previewed (directory or nested repository): nested/')
    expect(result).toContain('exit 0')
  })
})
