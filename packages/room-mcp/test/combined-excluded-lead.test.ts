import { fixture, git, names, put } from './combined-kept-preview-fixture.js'
import { digestPath } from '@room/shared'
import { expect, it } from 'vitest'

it.each([false, true])('kept preview ignores excluded lead-only output but retains overlapping gaps (workerChanged=%s)', async workerChanged => {
  const t = await fixture()
  const file = 'plugins/room/server/room-mcp.mjs'
  put(t.root, file, 'bundle\n'.repeat(100_000))
  const head = t.room.manifestHead.get('lead')!
  t.room.manifestHead.set('lead', { ...head, excluded: [digestPath(t.room.ensureRoomSalt(), file)] })
  if (workerChanged) {
    const dir = t.sessions.get('lead+api')!.dir
    put(dir, file, 'worker bundle edit\n')
    git(dir, 'add', file); git(dir, 'commit', '-qm', 'worker changes bundle')
  }
  const result = await t.preview('lead+api', names.filter(name => name !== 'lead+api'))
  expect(result.complete, result.out.join('\n')).toBe(!workerChanged)
  if (workerChanged) expect(result.gaps.some(gap => gap.path === file)).toBe(true)
  else expect(result.merged).toEqual(t.expected)
})
