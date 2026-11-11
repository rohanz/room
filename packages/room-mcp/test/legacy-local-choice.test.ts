import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { choiceFile, writeChoice, rememberTag } from '../src/choice.js'
import { resolveConfig } from '../src/config.js'
import { legacyLocalBranchRoom } from '../src/room-name.js'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-choice-')); dirs.push(dir)
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  return dir
}
describe('retired local choices', () => {
  it('recognizes old branch names without changing custom room names', () => {
    expect(legacyLocalBranchRoom('local/shop/feature/login', 'shop')).toBe('local/shop')
    for (const room of ['local/experiments', 'local/other/main', 'local/shop', 'local/shop/', 'local/shopping/main']) expect(legacyLocalBranchRoom(room, 'shop')).toBeUndefined()
  })
  it('ignores an unmarked branch choice and leaves every byte intact', async () => {
    const dir = repo(), file = await choiceFile(dir)
    const before = JSON.stringify({ where: 'local', at: 1, room: `local/${path.basename(dir)}/main`, share: { level: 'declared' } }) + '\n'
    fs.writeFileSync(file, before)
    expect((await resolveConfig({ dir, env: {} })).room).toBeUndefined()
    await rememberTag(dir, 'codex')
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })
  it('keeps the same explicit branch-shaped name written by 0.17', async () => {
    const dir = repo(), room = `local/${path.basename(dir)}/scratch`
    await writeChoice(dir, 'local', 'test', room)
    expect((await resolveConfig({ dir, env: {} })).room).toBe(room)
  })
  it('preserves ambiguous custom names also used by 0.17', async () => {
    const dir = repo(), file = await choiceFile(dir), before = '{"where":"local","at":1,"room":"local/experiments"}\n'
    fs.writeFileSync(file, before)
    expect((await resolveConfig({ dir, env: {} })).room).toBe('local/experiments')
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })
})
