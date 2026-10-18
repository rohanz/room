import { collectRefHook, git, lead, put, release, root, second, setup, worker } from './collect-fixture.js'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { registryForDir } from '../src/worker-registry.js'
import { workerByTag } from './registry-fixture.js'
describe('room_collect', () => {

  it('copies ignored and nested artifacts byte-for-byte, without committing', async () => {
    put(worker, 'artifact.bin', 'a\0b'); put(worker, 'out/nested.txt', 'nested')
    const t = setup(), before = git(lead, 'rev-parse', 'HEAD')
    expect(await t.call({ tag: 'test', mode: 'copy', paths: ['artifact.bin', 'out'] })).toBe('copied artifact.bin\ncopied out/nested.txt')
    expect(fs.readFileSync(path.join(lead, 'artifact.bin'))).toEqual(fs.readFileSync(path.join(worker, 'artifact.bin')))
    expect(git(lead, 'rev-parse', 'HEAD')).toBe(before)
    expect(fs.existsSync(worker)).toBe(true)
  })

  it('protects the source of a staged lead rename during copy collection', async () => {
    const t = setup()
    git(lead, 'config', 'diff.renames', 'true')
    git(lead, 'mv', 'file.txt', 'renamed.txt')
    expect(git(lead, 'diff', '--name-status', 'HEAD')).toMatch(/^R100\s/)
    const before = { head: git(lead, 'rev-parse', 'HEAD'), index: git(lead, 'ls-files', '--stage'), status: git(lead, 'status', '--porcelain') }
    put(worker, 'a.txt', 'earlier copy must not land')
    expect(await t.call({ tag: 'test', mode: 'copy', paths: ['a.txt', 'file.txt'] })).toContain('lead has modified file.txt')
    expect(fs.existsSync(path.join(lead, 'file.txt'))).toBe(false)
    expect(fs.existsSync(path.join(lead, 'a.txt'))).toBe(false)
    expect({ head: git(lead, 'rev-parse', 'HEAD'), index: git(lead, 'ls-files', '--stage'), status: git(lead, 'status', '--porcelain') }).toEqual(before)
    expect(fs.readFileSync(path.join(lead, 'renamed.txt'))).toEqual(fs.readFileSync(path.join(worker, 'file.txt')))
    expect(release).not.toHaveBeenCalled()
    expect(await t.call({ tag: 'test', mode: 'copy', paths: ['file.txt'], force: true })).toBe('copied file.txt')
  })

  it('preflights the whole copy before releasing or writing, and requires force for modified destinations', async () => {
    put(worker, 'a.txt', 'a'); put(worker, 'file.txt', 'worker'); put(lead, 'file.txt', 'lead')
    const t = setup()
    expect(await t.call({ tag: 'test', mode: 'copy', paths: ['a.txt', 'file.txt'] })).toContain('lead has modified file.txt')
    expect(fs.existsSync(path.join(lead, 'a.txt'))).toBe(false); expect(release).not.toHaveBeenCalled()
    expect(await t.call({ tag: 'test', mode: 'copy', paths: ['file.txt'], force: true })).toBe('copied file.txt')
  })

  it('preserves an original and a newly created later destination during copy preparation', async () => {
    put(worker, 'file.txt', 'worker replacement\n'); put(worker, 'new.txt', 'worker new\n')
    const t = setup()
    const original = fs.readFileSync(path.join(lead, 'file.txt'))
    const realCopy = fs.promises.copyFile.bind(fs.promises)
    let copies = 0
    const seam = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (...args) => {
      await realCopy(...args)
      if (++copies === 1) put(lead, 'new.txt', 'new lead edit during copy\n')
    })
    try {
      expect(await t.call({ tag: 'test', mode: 'copy', paths: ['file.txt', 'new.txt'] })).toMatch(/new\.txt changed during collection; nothing written, retry/)
      expect(fs.readFileSync(path.join(lead, 'file.txt'))).toEqual(original)
      expect(fs.readFileSync(path.join(lead, 'new.txt'), 'utf8')).toBe('new lead edit during copy\n')
      expect(release).not.toHaveBeenCalled()
    } finally { seam.mockRestore() }
  })

  it('refuses a source changed while an earlier copy is prepared', async () => {
    put(worker, 'a.txt', 'worker a\n'); put(worker, 'b.txt', 'worker b\n')
    const t = setup()
    const realCopy = fs.promises.copyFile.bind(fs.promises)
    let copies = 0
    const seam = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (...args) => {
      await realCopy(...args)
      if (++copies === 1) put(worker, 'b.txt', 'worker b changed during copy\n')
    })
    try {
      expect(await t.call({ tag: 'test', mode: 'copy', paths: ['a.txt', 'b.txt'] })).toMatch(/b\.txt changed during collection; nothing written, retry/)
      expect(fs.existsSync(path.join(lead, 'a.txt'))).toBe(false)
      expect(fs.existsSync(path.join(lead, 'b.txt'))).toBe(false)
      expect(release).not.toHaveBeenCalled()
    } finally { seam.mockRestore() }
  })

  it('rolls back copied files and restores original leaves when a later rename fails', async () => {
    put(worker, 'file.txt', 'worker replacement\n'); put(worker, 'new.txt', 'worker new\n')
    const t = setup()
    const original = fs.readFileSync(path.join(lead, 'file.txt'))
    const rename = fs.renameSync.bind(fs)
    const seam = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).includes('collect-copy-') && String(from).endsWith('.new') && to === path.join(lead, 'new.txt')) throw new Error('injected second rename failure')
      return rename(from, to)
    })
    try {
      expect(await t.call({ tag: 'test', mode: 'copy', paths: ['file.txt', 'new.txt'] })).toContain('injected second rename failure')
      expect(fs.readFileSync(path.join(lead, 'file.txt'))).toEqual(original)
      expect(fs.existsSync(path.join(lead, 'new.txt'))).toBe(false)
      expect(release).not.toHaveBeenCalled()
    } finally { seam.mockRestore() }
  })

  it('yields through 2,000 copy paths without reading whole file contents into memory', async () => {
    for (let i = 0; i < 2_000; i++) put(worker, `bulk/${i.toString().padStart(4, '0')}.txt`, 'x')
    const t = setup()
    let turnRan = false, copies = 0
    const realCopy = fs.promises.copyFile.bind(fs.promises)
    const copy = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (...args) => {
      expect(turnRan).toBe(true)
      copies++
      return realCopy(...args)
    })
    const read = vi.spyOn(fs, 'readFileSync')
    setImmediate(() => { turnRan = true })
    try {
      const reply = await t.call({ tag: 'test', mode: 'copy', paths: ['bulk'] })
      expect(reply.match(/^copied bulk\//gm)).toHaveLength(2_000)
      expect(copies).toBe(2_000)
      expect(read.mock.calls.filter(([name]) => typeof name === 'string' && name.includes('/bulk/'))).toHaveLength(0)
    } finally { copy.mockRestore(); read.mockRestore() }
  }, 120_000) // 2,000 real copies: the assertion is about memory, not speed; a saturated host took over 30 s

  it('refuses a destination that grows after apply preparation, before any write', async () => {
    put(worker, 'file.txt', 'worker\n')
    put(worker, 'new.txt', 'new\n')
    const t = setup()
    await t.sync()
    const registry = await registryForDir(lead)
    const begin = registry.beginCollect.bind(registry)
    const seam = vi.spyOn(registry, 'beginCollect').mockImplementation(async id => {
      await begin(id)
      fs.appendFileSync(path.join(lead, 'file.txt'), 'x'.repeat(600_000))
    })
    try {
      expect(await t.call({ tag: 'test' })).toMatch(/file\.txt changed during collection; nothing written, retry/)
      expect(fs.readFileSync(path.join(lead, 'file.txt')).length).toBeGreaterThan(512 * 1024)
      expect(fs.existsSync(path.join(lead, 'new.txt'))).toBe(false)
      expect(workerByTag(lead, 'test')).toBeDefined()
    } finally { seam.mockRestore() }
  })

  it('preserves a lead edit made while publishing collection refs', async () => {
    put(worker, 'file.txt', 'worker edit\n')
    const t = setup()
    let fired = false
    collectRefHook.call = () => { fired = true; put(lead, 'file.txt', 'new human edit\n') }
    const reply = await t.call({ tag: 'test' })
    expect(fired).toBe(true)
    expect(reply).toMatch(/file\.txt changed during collection; nothing written, retry/)
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('new human edit\n')
    expect(workerByTag(lead, 'test')).toBeDefined()
    expect(release).not.toHaveBeenCalled()
  })

  it('preserves all destinations when a lead edit arrives during multi-worker ref publication', async () => {
    const t = setup(), other = second(t)
    put(worker, 'file.txt', 'worker edit\n')
    put(other, 'new.txt', 'other worker edit\n')
    const published: string[] = []
    collectRefHook.call = ref => {
      published.push(ref)
      if (ref.includes('/test/')) put(lead, 'file.txt', 'new human edit\n')
    }
    const reply = await t.call({})
    expect(published).toHaveLength(2)
    expect(reply).toMatch(/file\.txt changed during collection; nothing written, retry/)
    expect(fs.readFileSync(path.join(lead, 'file.txt'), 'utf8')).toBe('new human edit\n')
    expect(fs.existsSync(path.join(lead, 'new.txt'))).toBe(false)
    expect(workerByTag(lead, 'test')).toBeDefined()
    expect(workerByTag(lead, 'second')).toBeDefined()
    expect(release).not.toHaveBeenCalled()
  })

  it('treats an oversized matching copy destination as a conflict until force is explicit', async () => {
    const large = Buffer.alloc(512 * 1024 + 1, 65)
    fs.writeFileSync(path.join(worker, 'large.bin'), large)
    fs.writeFileSync(path.join(lead, 'large.bin'), large)
    const t = setup()
    expect(await t.call({ tag: 'test', mode: 'copy', paths: ['large.bin'] })).toContain('lead has modified large.bin; pass force=true')
    expect(release).not.toHaveBeenCalled()
    expect(await t.call({ tag: 'test', mode: 'copy', paths: ['large.bin'], force: true })).toBe('copied large.bin')
  })

  it('restores earlier destinations if a later apply write fails', async () => {
    put(worker, 'a.txt', 'new a\n'); put(worker, 'b.txt', 'new b\n')
    const t = setup()
    const open = fs.openSync.bind(fs)
    const seam = vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      if (file === path.join(lead, 'b.txt') && typeof flags === 'number' && (flags & fs.constants.O_WRONLY)) throw new Error('injected write failure')
      return open(file, flags, mode)
    }) as typeof fs.openSync)
    try {
      expect(await t.call({ tag: 'test' })).toContain('injected write failure')
      expect(fs.existsSync(path.join(lead, 'a.txt'))).toBe(false)
      expect(fs.existsSync(path.join(lead, 'b.txt'))).toBe(false)
      expect(workerByTag(lead, 'test')).toBeDefined()
    } finally { seam.mockRestore() }
  })

  it('guards running workers and invalid modes', async () => {
    const t = setup('running')
    expect(await t.call({ tag: 'test' })).toContain('skipped test: running')
    expect(await t.call({ tag: 'test', mode: 'bad' })).toContain('mode must be')
    expect(await t.call({ tag: 'test', force: true })).toContain('skipped test: running')
  })

  it('rejects traversal, Git metadata, source and destination symlinks even with force', async () => {
    put(worker, 'out/value', 'value'); fs.symlinkSync(root, path.join(worker, 'escape'))
    fs.symlinkSync(root, path.join(lead, 'out'))
    const t = setup()
    for (const p of ['../escape', '.git/config', 'escape/lead/file.txt', 'out/value']) {
      expect(await t.call({ tag: 'test', mode: 'copy', paths: [p], force: true })).toMatch(/unsafe|symlink/)
    }
    expect(release).not.toHaveBeenCalled()
  })
})
