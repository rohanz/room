import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chooseServer, choiceFile, clearChoice, normaliseWhere, readChoice, writeChoice, describeWhere, markWarned } from '../src/choice.js'
import { DEFAULT_SERVER, LOCAL } from '../src/session.js'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-choice-'))
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'], { stdio: 'pipe' })
})

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
