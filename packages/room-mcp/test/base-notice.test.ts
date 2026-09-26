import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomDoc, type Msg } from '@room/shared'
import { dropSatisfiedBaseNotice } from '../src/base-notice.js'

describe('base notice delivery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-base-notice-'))
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  let oldBase: string, newBase: string
  beforeAll(() => {
    run('init', '-q')
    run('config', 'user.email', 'test@example.com')
    run('config', 'user.name', 'Test')
    writeFileSync(join(dir, 'app.txt'), 'old\n')
    run('add', 'app.txt'); run('commit', '-qm', 'old')
    oldBase = run('rev-parse', 'HEAD')
    writeFileSync(join(dir, 'app.txt'), 'new\n')
    run('commit', '-qam', 'new')
    newBase = run('rev-parse', 'HEAD')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const notice = (base: string) => ({ id: 'base-1', type: 'base', base } as Msg)
  const recipient = () => {
    const room = new RoomDoc()
    return { dir, room, me: { name: 'Recipient', kind: 'agent' as const } }
  }

  it('drops a base already in HEAD and records the recipient receipt', async () => {
    const s = recipient()
    expect(await dropSatisfiedBaseNotice(s, notice(oldBase))).toBe(true)
    expect(s.room.seen(s.me.name).has('base-1')).toBe(true)
  })

  it('delivers when HEAD is behind the new base', async () => {
    run('checkout', '-q', oldBase)
    try {
      const s = recipient()
      expect(await dropSatisfiedBaseNotice(s, notice(newBase))).toBe(false)
      expect(s.room.seen(s.me.name).has('base-1')).toBe(false)
    } finally { run('checkout', '-q', newBase) }
  })

  it('delivers when git cannot inspect the base', async () => {
    const s = recipient()
    expect(await dropSatisfiedBaseNotice(s, notice('missing-commit'))).toBe(false)
    expect(s.room.seen(s.me.name).has('base-1')).toBe(false)
  })
})
