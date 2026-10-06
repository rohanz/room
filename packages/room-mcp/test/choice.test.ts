import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { choiceFile, clearChoice, normaliseWhere, readChoice, writeChoice, describeWhere, rememberTag, worktreePath } from '../src/choice.js'
import { resolveConfig } from '../src/config.js'
import { LOCAL } from '../src/session.js'
import { RELEASE_VERSION } from '../src/index.js'

it('advertises the plugin release version in the MCP handshake', () => {
  const plugin = JSON.parse(readFileSync(new URL('../../../plugins/room/.claude-plugin/plugin.json', import.meta.url), 'utf8'))
  const codex = JSON.parse(readFileSync(new URL('../../../plugins/room/.codex-plugin/plugin.json', import.meta.url), 'utf8'))
  const marketplace = JSON.parse(readFileSync(new URL('../../../.claude-plugin/marketplace.json', import.meta.url), 'utf8'))
  expect(RELEASE_VERSION).toBe(plugin.version)
  expect(RELEASE_VERSION).toBe(codex.version)
  expect(RELEASE_VERSION).toBe(marketplace.plugins[0].version)
})

let dir: string
const configured = (where?: string, server?: string) => resolveConfig({ dir, args: { where }, env: { ROOM_SERVER: server } })
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
    expect(await configured()).toMatchObject({ server: LOCAL, whereRule: 'default', where: LOCAL })
    await expect(configured('team')).rejects.toThrow('No team server configured')
    expect(await configured('team', 'ws://own-team.test')).toMatchObject({ server: 'ws://own-team.test', whereRule: 'argument', where: 'team' })
    expect(await readChoice(dir)).toBeUndefined() // choosing does not remember; the join does, on success
    await writeChoice(dir, 'wss://team.example', 'rohanz')
    expect(existsSync(await choiceFile(dir))).toBe(true)
    expect((await choiceFile(dir)).endsWith('/.git/room-choice.json')).toBe(true)
    expect(await configured()).toMatchObject({ server: 'wss://team.example', whereRule: 'remembered', where: 'wss://team.example' })
    expect(await configured(undefined, 'ws://own-team.test')).toMatchObject({ server: 'ws://own-team.test', whereRule: 'env' })
    expect(await configured(undefined, 'local')).toMatchObject({ server: LOCAL, whereRule: 'env' })
    expect(await configured('wss://own.example', 'local')).toMatchObject({ server: 'wss://own.example', whereRule: 'argument' })
    expect(await clearChoice(dir)).toBe(true)
    expect(await clearChoice(dir)).toBe(false)
    expect(await configured()).toMatchObject({ whereRule: 'default' })
  })

  it('describes the room in one word for humans', () => {
    expect(describeWhere(LOCAL)).toBe('local (this machine)')
    expect(describeWhere('wss://team.example')).toBe('team (wss://team.example)')
  })
})

describe('tags per worktree', () => {
  it('migrates the legacy tag only to the main worktree and drops it on the next write', async () => {
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'init'], { cwd: dir })
    const worktree = join(dir, 'worktree')
    execFileSync('git', ['worktree', 'add', '-qb', 'worker', worktree], { cwd: dir })
    const mainKey = await worktreePath(dir), workerKey = await worktreePath(worktree)
    const file = await choiceFile(dir)
    expect(realpathSync(join(await choiceFile(worktree), '..'))).toBe(realpathSync(join(file, '..')))
    for (const write of [() => rememberTag(worktree, 'codex'), () => writeChoice(worktree, 'team')]) {
      writeFileSync(file, JSON.stringify({ where: 'team', at: 1, tag: '', warned: [mainKey] }))
      expect((await readChoice(worktree))?.tags).toEqual({ [mainKey]: '' })
      expect((await readChoice(worktree))?.tags?.[workerKey]).toBeUndefined()
      await write()
      const stored = JSON.parse(readFileSync(file, 'utf8'))
      expect(stored).not.toHaveProperty('tag')
      expect(stored.tags[mainKey]).toBe('')
      // 0.16 sharing inputs survive tag and destination rewrites until the policy store has replaced them.
      expect(stored.warned).toEqual([mainKey])
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

it('choice writes keep only destination and identity, never sharing authority', async () => {
  await clearChoice(dir)
  await writeChoice(dir, 'wss://team.example', 'rohanz')
  const choice = await readChoice(dir)
  expect(choice).toMatchObject({ where: 'wss://team.example', by: 'rohanz' })
  expect(choice).not.toHaveProperty('share')
  expect(choice).not.toHaveProperty('warned')
  await clearChoice(dir)
})
