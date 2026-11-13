import fs from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import { fixture, names } from './combined-kept-preview-fixture.js'
import { preparedEach } from './fixtures/prepared-test.js'
import { buildCombinedTree } from '../src/tools/combined-tree.js'
import { nameLeaseFile } from '../src/names.js'

const people = names.filter(name => name !== 'lead+consumer')
preparedEach(['session', 'pid', 'startTime', 'executable', 'room', 'server'] as const,
  'second review rejects a stale local lease with mismatching %s', () => fixture(), async (t, kind) => {
    expect((await t.preview('lead+consumer', people)).complete).toBe(true)
    const caller = t.sessions.get('lead+consumer')!
    const file = nameLeaseFile(t.registry.commonDir, 'local/test', 'lead')
    const lease = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (kind === 'room' || kind === 'server') lease.roomKey = kind === 'room' ? 'local/other' : 'wss://other/local/test'
    else {
      const key = kind === 'session' ? 'sessionId' : kind
      lease.holder[key] = kind === 'pid' ? lease.holder.pid + 1 : 'new-identity'
    }
    fs.writeFileSync(file, JSON.stringify(lease))
    // Call the engine directly: the fixture's convenience preview stamps new leases.
    const result = await buildCombinedTree(t.stateFor(caller), caller, people.map(person => ({ person, session: caller })))
    expect(result.complete, JSON.stringify(result.gaps)).toBe(false)
    expect(result.gaps.some(g => g.why.includes('checkout is not verified'))).toBe(true)
  })

preparedEach(['binary', 'oversized', 'dangling-link', 'outside-link'] as const,
  'second review refuses unpublished %s replacement of a consumed lead path', () => fixture(), async (t, kind) => {
    const file = path.join(t.root, 'src/api.ts')
    if (kind === 'binary') fs.writeFileSync(file, Buffer.from([0, 255, 1]))
    else if (kind === 'oversized') fs.writeFileSync(file, 'a'.repeat(2 * 1024 * 1024))
    else {
      fs.unlinkSync(file)
      fs.symlinkSync(kind === 'dangling-link' ? 'missing' : '/etc/hosts', file)
    }
    const result = await t.preview('lead+consumer', people)
    expect(result.complete, JSON.stringify(result.gaps)).toBe(false)
    expect(result.merged.has('src/api.ts')).toBe(false)
  })
