import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { git, lead, put, setup, worker, root } from './collect-fixture.js'
import { registryForDir } from '../src/worker-registry.js'
import { FileWorkerStore } from '../src/worker-file-store.js'
import { collectRecoveryRefs } from '../src/worker-refs.js'

const gc = () => {
  git(lead, 'reflog', 'expire', '--expire=now', '--all')
  git(lead, 'gc', '--prune=now', '--quiet')
}

it.each(['unchanged', 'modified', 'deleted', 'executable', 'symlink', 'missing-blob'] as const)(
  'second review reconstructs %s carried input from named artifacts after GC', async kind => {
    const t = setup('failed')
    const file = 'carry.txt'
    if (kind === 'symlink') fs.symlinkSync('file.txt', path.join(worker, file))
    else put(worker, file, 'original carry\n')
    const sha = kind === 'symlink'
      ? '' // capture the link-text blob through Git's index below
      : git(worker, 'hash-object', '-w', file)
    let carriedSha = sha
    if (kind === 'symlink') {
      git(worker, 'add', file)
      carriedSha = git(worker, 'rev-parse', `:${file}`)
      git(worker, 'reset', '-q', 'HEAD', '--', file)
    }
    t.set('test', { ...t.w, carriedUntracked: [{ path: file, sha: carriedSha, mode: kind === 'symlink' ? 0o777 : 0o644 }] })
    if (kind === 'modified') put(worker, file, 'changed carried bytes\n')
    if (kind === 'deleted') fs.unlinkSync(path.join(worker, file))
    if (kind === 'executable') fs.chmodSync(path.join(worker, file), 0o755)
    if (kind === 'missing-blob') gc()
    put(worker, 'file.txt', 'tracked recovery\n')
    put(worker, 'ordinary.txt', 'ordinary recovery\n')
    put(worker, 'artifact.bin', 'ignored output')
    const reply = await t.call({ tag: 'test', discard: true })
    expect(reply).toContain('discarded test')
    expect(reply).toContain('deleted without a copy: artifact.bin')
    const record = (await (await registryForDir(lead)).read('w_test'))!
    const base = record.discard!.recoveryRef!
    expect(reply).toContain(base)
    gc()
    const recovered = path.join(root, 'recovered-second')
    git(lead, 'worktree', 'add', '--detach', recovered, base)
    expect(fs.readFileSync(path.join(recovered, 'file.txt'), 'utf8')).toBe('tracked recovery\n')
    expect(fs.readFileSync(path.join(recovered, 'ordinary.txt'), 'utf8')).toBe('ordinary recovery\n')
    if (kind === 'deleted') expect(fs.existsSync(path.join(recovered, file))).toBe(false)
    else if (kind === 'symlink') expect(fs.readlinkSync(path.join(recovered, file))).toBe('file.txt')
    else expect(fs.readFileSync(path.join(recovered, file), 'utf8')).toBe(kind === 'modified' ? 'changed carried bytes\n' : 'original carry\n')
    if (kind === 'executable') expect(fs.statSync(path.join(recovered, file)).mode & 0o111).not.toBe(0)
  })

it.each(['children', 'stop', 'removing', 'cleanup', 'prune'] as const)(
  'second review crash after durable %s step keeps recoverable tree and ignored names', async step => {
    const t = setup('failed')
    put(worker, 'file.txt', 'tracked after crash\n')
    put(worker, 'ordinary.txt', 'untracked after crash\n')
    put(worker, 'artifact.bin', 'ignored after crash')
    await t.sync()
    const registry = await registryForDir(lead)
    await registry.beginDiscard('w_test', [])
    const original = FileWorkerStore.prototype.markDiscardStep
    const fault = vi.spyOn(FileWorkerStore.prototype, 'markDiscardStep').mockImplementation(async function (this: FileWorkerStore, id, current) {
      const result = await original.call(this, id, current)
      if (current === step) throw new Error('simulated crash')
      return result
    })
    try { await expect(registry.replayDiscard('w_test')).rejects.toThrow('simulated crash') }
    finally { fault.mockRestore() }
    await registry.replayDiscard('w_test')
    const record = (await registry.read('w_test'))!
    expect(record.archive!.summary).toContain('deleted without a copy: artifact.bin')
    expect(record.archive!.summary).toContain(record.discard!.recoveryRef!)
    gc()
    const recovered = path.join(root, 'recovered-crash')
    git(lead, 'worktree', 'add', '--detach', recovered, record.discard!.recoveryRef!)
    expect(fs.readFileSync(path.join(recovered, 'file.txt'), 'utf8')).toBe('tracked after crash\n')
    expect(fs.readFileSync(path.join(recovered, 'ordinary.txt'), 'utf8')).toBe('untracked after crash\n')
  })

it('second review keeps recovery pins seven days after delayed replay removes the checkout', async () => {
  const t = setup('failed')
  put(worker, 'file.txt', 'late replay recovery\n')
  await t.sync()
  const registry = await registryForDir(lead)
  const day = 86400_000, started = Date.now()
  await registry.beginDiscard('w_test', [])
  const original = FileWorkerStore.prototype.recordDiscardRecovery
  const fault = vi.spyOn(FileWorkerStore.prototype, 'recordDiscardRecovery').mockImplementation(async function (this: FileWorkerStore, id, facts) {
    await original.call(this, id, facts)
    if (facts.recoveryRef) throw new Error('crashed after snapshot')
  })
  try { await expect(registry.replayDiscard('w_test')).rejects.toThrow('crashed after snapshot') }
  finally { fault.mockRestore() }
  expect(fs.existsSync(worker)).toBe(true)
  const realNow = Date.now.bind(Date)
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6 * day)
  try {
    await registry.replayDiscard('w_test')
    const record = (await registry.read('w_test'))!
    expect(fs.existsSync(worker)).toBe(false)
    expect(record.archive!.summary).toContain('kept for seven days')
    // Only two days have elapsed since destructive cleanup completed.
    expect(collectRecoveryRefs(registry.commonDir, started + 8 * day, true)).not.toContain(record.discard!.recoveryRef)
  } finally { clock.mockRestore() }
})

it.each(['before-replay', 'after-replay'] as const)('second review re-establishes an expired snapshot pin when GC runs %s around delayed replay', async gcOrder => {
  const t = setup()
  const delivered = Array.from({ length: 30 }, (_, i) => `delivered ${i}`).join('\n') + '\n'
  put(worker, 'file.txt', delivered)
  expect(await t.call({ tag: 'test', keep: true })).toContain('kept test')
  const registry = await registryForDir(lead)
  const keptBase = (await registry.read('w_test'))!.base!
  put(worker, 'file.txt', delivered.replace('delivered 25', 'latest worker line'))
  put(lead, 'file.txt', 'lead moved on\n')
  const started = Date.now(), day = 86400_000
  await registry.beginDiscard('w_test', [])
  const original = FileWorkerStore.prototype.recordDiscardRecovery
  const fault = vi.spyOn(FileWorkerStore.prototype, 'recordDiscardRecovery').mockImplementation(async function (this: FileWorkerStore, id, facts) {
    await original.call(this, id, facts)
    if (facts.recoveryRef) throw new Error('crashed before removal')
  })
  try { await expect(registry.replayDiscard('w_test')).rejects.toThrow('crashed before removal') }
  finally { fault.mockRestore() }
  const ref = (await registry.read('w_test'))!.discard!.recoveryRef!
  const realNow = Date.now.bind(Date)
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 8 * day)
  try {
    if (gcOrder === 'before-replay') expect(collectRecoveryRefs(registry.commonDir, Date.now())).toContain(ref)
    gc()
    // The checkout and private kept ref still make recovery possible before replay.
    expect(git(lead, 'cat-file', '-t', keptBase)).toBe('commit')
    await registry.replayDiscard('w_test')
    expect(fs.existsSync(worker)).toBe(false)
    if (gcOrder === 'after-replay') collectRecoveryRefs(registry.commonDir, Date.now())
    gc()
    const recoveredRef = (await registry.read('w_test'))!.discard!.recoveryRef!
    expect(git(lead, 'show', `${recoveredRef}:file.txt`)).toBe(delivered.replace('delivered 25', 'latest worker line').trim())
  } finally { clock.mockRestore() }
})
