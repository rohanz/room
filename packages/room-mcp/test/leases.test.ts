import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupOrphanTemps, compareAndRelease, createExclusive, liveness, recover, replace, withGuard, withGuardAsync, type InstanceToken } from '../src/leases.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function leaseFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-lease-test-'))
  dirs.push(dir)
  return path.join(dir, 'lease.json')
}
const token = (nonce: string, pid = process.pid): InstanceToken => ({ sessionId: 's', pid, startTime: 'birth', executable: 'node', nonce })
const childScript = fileURLToPath(new URL('./fixtures/lease-child.ts', import.meta.url))
const children: ChildProcess[] = []
afterEach(() => { for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL') })
function launch(mode: string, file: string, ready: string, signal = ''): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', childScript, mode, file, ready, signal], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  return child
}
async function untilFile(file: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (fs.existsSync(file)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${file}`)
}
function output(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '', err = ''
    child.stdout?.on('data', chunk => { out += chunk })
    child.stderr?.on('data', chunk => { err += chunk })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve(out) : reject(new Error(`child exited ${code}: ${err}`)))
  })
}

describe('local leases', () => {
  it.each((['sync', 'async'] as const).flatMap(mode => (['directory sync', 'temp cleanup'] as const).map(failure => [mode, failure] as const)))('releases an acquired guard after post-link failure (%s, %s)', async (mode, failure) => {
    const file = leaseFile(), guard = `${file}.guard`, dir = path.dirname(file)
    let injected = false, entered = false
    const fail = () => {
      if (!injected && fs.existsSync(guard)) {
        injected = true
        throw Object.assign(new Error(`one-shot ${failure} failure`), { code: 'EIO' })
      }
    }
    if (mode === 'sync') {
      if (failure === 'directory sync') {
        const sync = fs.fsyncSync.bind(fs)
        vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { if (fs.fstatSync(fd).isDirectory()) fail(); return sync(fd) })
      } else {
        const rm = fs.rmSync.bind(fs)
        vi.spyOn(fs, 'rmSync').mockImplementation((...args) => { if (String(args[0]).endsWith('.tmp')) fail(); return rm(...args) })
      }
    } else if (failure === 'directory sync') {
      const open = fs.promises.open.bind(fs.promises)
      vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args)
        if (String(args[0]) === dir) {
          const sync = handle.sync.bind(handle)
          vi.spyOn(handle, 'sync').mockImplementation(async () => { fail(); await sync() })
        }
        return handle
      })
    } else {
      const rm = fs.promises.rm.bind(fs.promises)
      vi.spyOn(fs.promises, 'rm').mockImplementation(async (...args) => { if (String(args[0]).endsWith('.tmp')) fail(); return rm(...args) })
    }
    try {
      const callback = () => { entered = true }
      if (mode === 'sync') expect(() => withGuard(file, callback)).toThrow(`one-shot ${failure} failure`)
      else await expect(withGuardAsync(file, callback)).rejects.toThrow(`one-shot ${failure} failure`)
      expect(injected).toBe(true)
      expect(entered).toBe(false)
    } finally { vi.restoreAllMocks() }
    expect(fs.existsSync(guard), 'failed acquisition left its live guard installed').toBe(false)
    if (mode === 'sync') expect(withGuard(file, () => 'retry')).toBe('retry')
    else await expect(withGuardAsync(file, () => 'retry')).resolves.toBe('retry')
  })

  it.each(['sync', 'async'] as const)('keeps a different nonce when failed acquisition cleans up (%s)', async mode => {
    const file = leaseFile(), guard = `${file}.guard`, successor = token('successor')
    const replaceAndFail = () => {
      fs.unlinkSync(guard)
      fs.writeFileSync(guard, JSON.stringify(successor))
      throw Object.assign(new Error('post-link failure'), { code: 'EIO' })
    }
    if (mode === 'sync') {
      const link = fs.linkSync.bind(fs)
      vi.spyOn(fs, 'linkSync').mockImplementation((...args) => { link(...args); replaceAndFail() })
    } else {
      const link = fs.promises.link.bind(fs.promises)
      vi.spyOn(fs.promises, 'link').mockImplementation(async (...args) => { await link(...args); replaceAndFail() })
    }
    try {
      if (mode === 'sync') expect(() => withGuard(file, () => 1)).toThrow('post-link failure')
      else await expect(withGuardAsync(file, () => 1)).rejects.toThrow('post-link failure')
    } finally { vi.restoreAllMocks() }
    expect(JSON.parse(fs.readFileSync(guard, 'utf8'))).toEqual(successor)
  })

  it('uses the same exclusion protocol for async and sync guard holders', async () => {
    const file = leaseFile()
    expect(await withGuardAsync(file, () => {
      expect(() => withGuard(file, () => 'overlap')).toThrow(/lease guard busy/)
      return 'held'
    })).toBe('held')
    expect(withGuard(file, () => 'next')).toBe('next')
    let pending!: Promise<unknown>
    withGuard(file, () => { pending = withGuardAsync(file, () => 'overlap') })
    // The synchronous holder has released before the async contender can publish.
    expect(await pending).toBe('overlap')
  })

  it('recovers dead nested guards asynchronously without synchronous fsync', async () => {
    const file = leaseFile(), guard = `${file}.guard`
    fs.writeFileSync(guard, JSON.stringify(token('dead', 500)))
    fs.writeFileSync(`${guard}.guard`, JSON.stringify(token('also-dead', 501)))
    const sync = vi.spyOn(fs, 'fsyncSync')
    try {
      expect(await withGuardAsync(file, () => 'recovered', () => undefined)).toBe('recovered')
      expect(sync).not.toHaveBeenCalled()
    } finally { sync.mockRestore() }
    expect(fs.readdirSync(path.dirname(file))).toEqual([])
  })

  it('keeps unreadable async guards and releases after an invalid callback', async () => {
    const file = leaseFile(), guard = `${file}.guard`
    fs.writeFileSync(guard, '{}')
    await expect(withGuardAsync(file, () => 1, () => undefined)).rejects.toThrow(/lease guard busy/)
    expect(fs.readFileSync(guard, 'utf8')).toBe('{}')
    fs.unlinkSync(guard)
    await expect(withGuardAsync(file, (async () => 1) as never)).rejects.toThrow(/synchronous/)
    expect(fs.existsSync(guard)).toBe(false)
    await expect(withGuardAsync(file, () => { throw new Error('callback failed') })).rejects.toThrow('callback failed')
    expect(fs.existsSync(guard)).toBe(false)
  })

  it('syncs async guard contents before linking, and cleans a failed write', async () => {
    const file = leaseFile()
    const open = fs.promises.open.bind(fs.promises)
    let synced = false
    const opening = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (args[1] === 'wx') {
        const sync = handle.sync.bind(handle)
        vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); synced = true })
      }
      return handle
    })
    const link = fs.promises.link.bind(fs.promises)
    const linking = vi.spyOn(fs.promises, 'link').mockImplementation(async (...args) => {
      expect(synced).toBe(true)
      return link(...args)
    })
    try { await withGuardAsync(file, () => 1) }
    finally { opening.mockRestore(); linking.mockRestore() }
    const failure = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (args[1] === 'wx') vi.spyOn(handle, 'sync').mockRejectedValue(new Error('sync failed'))
      return handle
    })
    try { await expect(withGuardAsync(file, () => 1)).rejects.toThrow('sync failed') }
    finally { failure.mockRestore() }
    expect(fs.readdirSync(path.dirname(file))).toEqual([])
  })

  it('admits exactly one of two creators in separate processes', async () => {
    const file = leaseFile()
    const a = launch('create', file, `${file}.a`, `${file}.go`)
    const b = launch('create', file, `${file}.b`, `${file}.go`)
    const doneA = output(a), doneB = output(b)
    await Promise.all([untilFile(`${file}.a`), untilFile(`${file}.b`)])
    fs.writeFileSync(`${file}.go`, '')
    expect([await doneA, await doneB].sort()).toEqual(['lost', 'won'])
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toHaveProperty('child')
  })

  it('guards release against a successor that replaced the old token', () => {
    const file = leaseFile()
    const a = token('a'), b = token('b')
    expect(createExclusive(file, { holder: a })).toBe(true)
    expect(replace(file, value => value.holder.nonce === a.nonce, { holder: b })).toBe(true)
    expect(compareAndRelease(file, a)).toBe(false)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).holder).toEqual(b)
    expect(compareAndRelease(file, b)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('releases a bare run-writer token and admits a successor', () => {
    const file = leaseFile()
    const a = token('writer-a'), b = token('writer-b')
    expect(createExclusive(file, a)).toBe(true)
    expect(compareAndRelease(file, a)).toBe(true)
    expect(createExclusive(file, b)).toBe(true)
    expect(compareAndRelease(file, a)).toBe(false)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(b)
  })

  it('recovers a guard after its owner is killed', async () => {
    const file = leaseFile(), ready = `${file}.ready`
    const child = launch('guard', file, ready)
    await untilFile(ready)
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
    expect(withGuard(file, () => 'recovered')).toBe('recovered')
    expect(fs.existsSync(`${file}.guard`)).toBe(false)
  })

  it('rejects an async guarded callback even when a caller erases its type', () => {
    const file = leaseFile()
    const invalid = () => withGuard(file, (async () => 1) as never)
    expect(invalid).toThrow(/synchronous/)
    expect(fs.existsSync(`${file}.guard`)).toBe(false)
  })

  it('fsyncs parents of newly created directories', () => {
    const file = path.join(path.dirname(leaseFile()), 'new', 'nested', 'lease.json')
    const original = fs.fsyncSync
    let directories = 0
    const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) directories++
      return original(fd)
    })
    try { expect(createExclusive(file, { held: true })).toBe(true) }
    finally { spy.mockRestore() }
    expect(directories).toBeGreaterThanOrEqual(3)
  })

  it('fsyncs a parent even when another writer created the directory first', () => {
    const root = path.dirname(leaseFile())
    const parent = path.join(root, 'room')
    const target = path.join(parent, 'registry')
    const originalMkdir = fs.mkdirSync, originalOpen = fs.openSync, originalFsync = fs.fsyncSync
    const opened = new Map<number, string>()
    let intervened = false, parentSynced = false, syncedBeforeSecondReturned = false
    const open = vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags: string | number, ...args: any[]) => {
      const fd = originalOpen(file, flags as any, ...args as [any])
      if (flags === 'r') opened.set(fd, path.resolve(String(file)))
      return fd
    }) as typeof fs.openSync)
    const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (opened.get(fd) === parent) parentSynced = true
      return originalFsync(fd)
    })
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(((dir: fs.PathLike, ...args: any[]) => {
      const result = originalMkdir(dir, ...args as [any])
      if (!intervened && path.resolve(String(dir)) === target) {
        intervened = true
        expect(createExclusive(path.join(target, 'second.json'), {})).toBe(true)
        syncedBeforeSecondReturned = parentSynced
      }
      return result
    }) as typeof fs.mkdirSync)
    try { expect(createExclusive(path.join(target, 'first.json'), {})).toBe(true) }
    finally { mkdir.mockRestore(); fsync.mockRestore(); open.mockRestore() }
    expect(intervened).toBe(true)
    expect(syncedBeforeSecondReturned).toBe(true)
  })

  it('keeps a live writer temp and removes it after that writer dies', async () => {
    const file = leaseFile(), ready = `${file}.ready`
    const child = launch('temp', file, ready)
    await untilFile(ready)
    const temp = fs.readFileSync(ready, 'utf8')
    expect(fs.existsSync(temp)).toBe(true)
    createExclusive(`${file}.other`, {})
    expect(fs.existsSync(temp)).toBe(true)
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
    expect(cleanupOrphanTemps(path.dirname(file), () => ({}))).toBe(0)
    expect(fs.existsSync(temp)).toBe(true)
    createExclusive(`${file}.third`, {})
    expect(fs.existsSync(temp)).toBe(false)
  })

  it('keeps a live pid temp when an identity probe is missing or disagrees', () => {
    const file = leaseFile()
    const marker = createHash('sha256').update('original-birth').digest('hex').slice(0, 24)
    const temp = `${file}.roomtmp-p${process.pid}-s${marker}-n12345678-1234-1234-1234-123456789abc.tmp`
    fs.writeFileSync(temp, 'in progress')
    const dir = path.dirname(file)
    expect(cleanupOrphanTemps(dir, () => undefined)).toBe(0)
    expect(fs.existsSync(temp)).toBe(true)
    expect(cleanupOrphanTemps(dir, () => ({ startTime: 'transiently-wrong-birth' }))).toBe(0)
    expect(fs.existsSync(temp)).toBe(true)
  })

  it('recovers a dead holder after a pid is reused with a different start time', () => {
    const file = leaseFile()
    const dead = token('old', 500)
    expect(liveness(dead, () => ({ startTime: 'new-birth', executable: 'node' }))).toBe('dead')
    expect(liveness(dead, () => ({ startTime: 'new-birth' }))).toBe('dead')
    // macOS derives kern.boottime from wall clock minus uptime: a clock correction moves it, not the process start.
    const mac = { pid: 1, startTime: 'darwin:1789781722:1790860993', executable: 'claude' }
    expect(liveness(mac, () => ({ startTime: 'darwin:1789781723:1790860993', executable: 'claude' }))).toBe('alive')
    expect(liveness(mac, () => ({ startTime: 'darwin:1789781723:1790860994', executable: 'claude' }))).toBe('dead')
    expect(liveness(mac, () => ({ startTime: 'darwin:1789900000:1790860993', executable: 'claude' }))).toBe('dead')
    expect(createExclusive(file, { holder: dead })).toBe(true)
    expect(recover(file, value => value.holder.nonce === 'old', () => ({ startTime: 'new-birth', executable: 'node' }))).toBe(true)
    expect(createExclusive(file, { holder: token('new') })).toBe(true)
  })

  it('recovers a dead bare run-writer token', () => {
    const file = leaseFile()
    const old = token('old-writer', 500)
    expect(createExclusive(file, old)).toBe(true)
    expect(recover(file, value => value.nonce === old.nonce, () => ({ startTime: 'reused', executable: 'node' }))).toBe(true)
    expect(createExclusive(file, token('successor'))).toBe(true)
  })

  it('keeps an unreadable holder until an explicit override', () => {
    const file = leaseFile()
    const old = token('old', 500)
    expect(createExclusive(file, { holder: old })).toBe(true)
    expect(liveness(old, () => ({}))).toBe('unknown')
    expect(recover(file, () => true, () => ({}))).toBe(false)
    expect(fs.existsSync(file)).toBe(true)
  })
})
