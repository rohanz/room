import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import * as baseline from '@room/roomd/baseline'
import { realRepo } from './workers-fixture.js'
import { collectRecoveryRefs, preserveWorkerBranch, RECOVERY_REF_AGE_MS } from '../src/worker-refs.js'

it.each(['previous enumeration control', 'current enumeration'])('%s expires healthy pins beside a missing object', mode => {
  const { repo, git, head } = realRepo(), common = path.join(repo, '.git')
  const worker = { id: 'w_review', tag: 'review', branch: 'room/review' }
  git('update-ref', `refs/heads/${worker.branch}`, head)
  const { recoveryRef } = preserveWorkerBranch(common, worker)
  expect(recoveryRef).toBeDefined()

  // A stale/corrupt unrelated recovery ref must not prevent every healthy pin from expiring.
  const broken = 'refs/room/recovery/broken/object'
  const blob = baseline.boundedGitSync(repo, ['hash-object', '-w', '--stdin'], { input: Buffer.from('missing recovery object') }).toString().trim()
  git('update-ref', broken, blob)
  fs.unlinkSync(path.join(common, 'objects', blob.slice(0, 2), blob.slice(2)))

  if (mode === 'previous enumeration control') {
    const run = baseline.boundedGitSync
    vi.spyOn(baseline, 'boundedGitSync').mockImplementation((dir, args, opts) => {
      const format = '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(taggerdate:unix)'
      if (!args.includes(format)) return run(dir, args, opts)
      const listing = run(dir, args.map(arg => arg === format ? '--format=%(refname)%00%(objectname)' : arg), opts)
      // Restore the parent commit's enumeration and bypass only the new prefilter.
      // Every original per-object/direct-ref/OID check and deletion still runs unchanged.
      return Buffer.from(listing.toString().trimEnd().split('\n').map(line => `${line}\0tag\0`).join('\n'))
    })
  }
  try {
    expect(collectRecoveryRefs(common, Date.now() + 2 * RECOVERY_REF_AGE_MS)).toEqual([recoveryRef])
    expect(fs.readFileSync(path.join(common, broken), 'utf8').trim()).toBe(blob)
  } finally { vi.restoreAllMocks() }
})
