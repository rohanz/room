import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chooseServer, choiceFile, clearChoice, normaliseWhere, readChoice, writeChoice, describeWhere, markWarned, rememberTag, worktreePath } from '../src/choice.js'
import { DEFAULT_SERVER, LOCAL } from '../src/session.js'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-choice-'))
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'], { stdio: 'pipe' })
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('room choice', () => {
  it('normalises the words people use', () => {
    expect(normaliseWhere('team')).toBe('team'); expect(normaliseWhere('web')).toBe('team'); expect(normaliseWhere('hosted')).toBe('team')
    expect(normaliseWhere('local')).toBe(LOCAL); expect(normaliseWhere('')).toBeUndefined(); expect(normaliseWhere(undefined)).toBeUndefined()
    expect(normaliseWhere('wss://x.example')).toBe('wss://x.example')
  })

  it('defaults to local, remembers an explicit choice per clone, and lets env and arguments override it', async () => {
    expect(await chooseServer(dir)).toMatchObject({ server: LOCAL, rule: 'default', where: LOCAL })
    expect(await chooseServer(dir, 'team')).toMatchObject({ server: DEFAULT_SERVER, rule: 'argument', where: 'team' })
    expect(await readChoice(dir)).toBeUndefined() // choosing does not remember; the join does, on success
    await writeChoice(dir, 'team', 'rohanz')
    expect(existsSync(await choiceFile(dir))).toBe(true)
    expect((await choiceFile(dir)).endsWith('/.git/room-choice.json')).toBe(true)
    expect(await chooseServer(dir)).toMatchObject({ server: DEFAULT_SERVER, rule: 'remembered', where: 'team' })
    expect(await chooseServer(dir, undefined, 'local')).toMatchObject({ server: LOCAL, rule: 'env' })
    expect(await chooseServer(dir, 'wss://own.example', 'local')).toMatchObject({ server: 'wss://own.example', rule: 'argument' })
    expect(await clearChoice(dir)).toBe(true)
    expect(await clearChoice(dir)).toBe(false)
    expect(await chooseServer(dir)).toMatchObject({ rule: 'default' })
  })

  it('describes the room in one word for humans', () => {
    expect(describeWhere(LOCAL)).toBe('local (this machine)')
    expect(describeWhere(DEFAULT_SERVER)).toBe(`team (${DEFAULT_SERVER})`)
  })
})

describe('visibility warning per worktree', () => {
  it('warns once per worktree and keeps the list across re-choices of the same room', async () => {
    await writeChoice(dir, 'team', 'rohanz')
    expect(await markWarned(dir, dir)).toBe(true)
    expect(await markWarned(dir, dir)).toBe(false)
    expect(await markWarned(dir, join(dir, 'other-worktree'))).toBe(true)
    await writeChoice(dir, 'team', 'rohanz') // same choice: keeps who was warned
    expect(await markWarned(dir, dir)).toBe(false)
    await writeChoice(dir, 'local') // a new choice starts over
    expect((await readChoice(dir))?.warned).toBeUndefined()
    await clearChoice(dir)
  })
})


describe('tags per worktree', () => {
  it('migrates the legacy tag only to the main worktree and drops it on every next write', async () => {
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'init'], { cwd: dir })
    const worktree = join(dir, 'worktree')
    execFileSync('git', ['worktree', 'add', '-qb', 'worker', worktree], { cwd: dir })
    const mainKey = await worktreePath(dir), workerKey = await worktreePath(worktree)
    const file = await choiceFile(dir)
    expect(realpathSync(join(await choiceFile(worktree), '..'))).toBe(realpathSync(join(file, '..')))
    for (const write of [() => rememberTag(worktree, 'codex'), () => writeChoice(worktree, 'team'), () => markWarned(worktree, worktree)]) {
      writeFileSync(file, JSON.stringify({ where: 'team', at: 1, tag: '', warned: [mainKey] }))
      expect((await readChoice(worktree))?.tags).toEqual({ [mainKey]: '' })
      expect((await readChoice(worktree))?.tags?.[workerKey]).toBeUndefined()
      await write()
      const stored = JSON.parse(readFileSync(file, 'utf8'))
      expect(stored).not.toHaveProperty('tag')
      expect(stored.tags[mainKey]).toBe('')
      expect(stored.warned).toContain(mainKey)
    }
    await rememberTag(worktree, 'codex')
    await rememberTag(dir, 'claude')
    expect((await readChoice(worktree))?.tags).toEqual({ [mainKey]: 'claude', [workerKey]: 'codex' })
    // An existing map entry wins over a legacy value when both are present.
    writeFileSync(file, JSON.stringify({ where: 'local', at: 1, tag: 'old', tags: { [mainKey]: 'claude' } }))
    expect((await readChoice(worktree))?.tags).toEqual({ [mainKey]: 'claude' })
    const subdir = join(worktree, 'nested'), alias = join(dir, 'alias')
    mkdirSync(subdir)
    symlinkSync(worktree, alias)
    await rememberTag(join(alias, 'nested'), 'codex')
    expect(await worktreePath(subdir)).toBe(workerKey)
    expect((await readChoice(dir))?.tags).toEqual({ [mainKey]: 'claude', [workerKey]: 'codex' })
    expect(await clearChoice(worktree)).toBe(true)
    expect(await readChoice(dir)).toBeUndefined()
  })
})

it('remembers disclosure per destination without opting an environment-only clone into a server', async () => {
  await clearChoice(dir)
  expect(await markWarned(dir, dir, 'wss://one')).toBe(true)
  expect(await markWarned(dir, dir, 'wss://one')).toBe(false)
  expect(await markWarned(dir, dir, 'wss://two')).toBe(true)
  expect((await chooseServer(dir)).server).toBe(LOCAL)
  await clearChoice(dir)
})

it('remembers the sharing level alongside the clone destination', async () => {
  await clearChoice(dir)
  await writeChoice(dir, 'team', 'rohanz', 'intent')
  expect(await readChoice(dir)).toMatchObject({ where: 'team', share: 'intent' })
  await writeChoice(dir, 'team', 'rohanz', 'declared')
  expect(await readChoice(dir)).toMatchObject({ where: 'team', share: 'declared' })
  await clearChoice(dir)
})
