import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { CURRENT_COMPAT, SETTLE_MS, STARTING_RETRY_MS, startHub, serializedStore } from '@room/hub-core'
import { WORKER_RECORD_SCHEMA, RoomDoc } from '@room/shared'
import * as processes from '../../relay/src/process.js'
import { holderDeadCheck } from '../../relay/src/hub.js'
import { EventEmitter } from 'node:events'
import { fixtureHolder, observeSocketMessages, validateAcquireTrace } from '../../../scripts/compat-pair.mts'
import { updatePins, validatePins, validatePinCommit } from '../../../scripts/compat-pins.mjs'
import { pairPlan, pendingCandidate, selectPairs, validateDescriptor } from '../../../scripts/compat-matrix.mts'
import { run } from '../../../scripts/compat-process.mts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const initial = [{ tag: 'v0.17.0', commit: 'ec13dcd83f67895c622410e3d9e8f53b5c5cb7a2' }, { tag: 'v0.17.32', commit: '77bf1c448d6ce883b844443204c7c9c7306d0c4c' }]

describe('compatibility release pins', () => {
  it('appends the release without discarding older pins or changing immutable commits', () => {
    expect(updatePins(initial, '0.21.0')).toEqual([...initial, { tag: 'v0.21.0' }])
    expect(updatePins(initial, '0.17.32')).toEqual(initial)
    expect(initial).toHaveLength(2)
  })
  it('requires explicit retirement and protects all three prior minors', () => {
    for (const minor of [18, 19, 20]) expect(() => updatePins(initial, `0.${minor}.0`, ['v0.17.0'])).toThrow('three-minor support window')
    expect(updatePins(initial, '0.21.0', ['v0.17.0'])).toEqual([initial[1], { tag: 'v0.21.0' }])
    expect(() => updatePins(initial, '0.21.0', ['v0.16.0'])).toThrow('not found')
  })
  it('rejects malformed tags, SHAs and duplicate pins', () => {
    expect(() => updatePins(initial, 'next')).toThrow('invalid compatibility tag')
    expect(() => validatePins([{ tag: 'v0.17.0', commit: 'ec13dcd8' }])).toThrow('invalid commit')
    expect(() => validatePins([...initial, initial[0]])).toThrow('duplicate')
    expect(() => validatePins([])).toThrow('nonempty')
  })
  it('stamps release pins through the real bump command, then freezes a tag commit', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'compat-release-'))
    const read = (file: string) => fs.readFile(path.join(temp, file), 'utf8')
    try {
      for (const file of ['scripts/bump-version.mjs', 'scripts/compat-pins.mjs', 'scripts/compat-pins.json', 'plugins/room/.claude-plugin/plugin.json', 'plugins/room/.codex-plugin/plugin.json', '.claude-plugin/marketplace.json', 'plugins/room/hooks/common.mjs']) {
        await fs.mkdir(path.dirname(path.join(temp, file)), { recursive: true })
        await fs.copyFile(path.join(root, file), path.join(temp, file))
      }
      await fs.writeFile(path.join(temp, 'scripts/compat-pins.json'), JSON.stringify(initial))
      await fs.writeFile(path.join(temp, 'plugins/room/hooks/common.mjs'), "export const HOOKS_VERSION = '0.17.32'\n")
      await run(process.execPath, ['scripts/bump-version.mjs', '0.20.0'], temp)
      expect(JSON.parse(await read('scripts/compat-pins.json'))).toEqual([...initial, { tag: 'v0.20.0' }])
      expect(JSON.parse(await read('plugins/room/.codex-plugin/plugin.json')).version).toBe('0.20.0')
      await run('git', ['init'], temp)
      await run('git', ['add', '.'], temp)
      await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'fixture'], temp)
      await run('git', ['tag', 'v0.20.0'], temp)
      const candidate = { tag: 'v0.20.0' }
      expect(() => validatePinCommit(candidate, '0.20.0', undefined)).not.toThrow()
      const tagCommit = execFileSync('git', ['rev-parse', 'v0.20.0^{commit}'], { cwd: temp, encoding: 'utf8' }).trim()
      expect(() => validatePinCommit(candidate, '0.20.0', tagCommit)).toThrow('node scripts/compat-pins.mjs 0.20.0 --pin-commit')
      expect(() => validatePinCommit(candidate, '0.21.0', undefined)).toThrow('--pin-commit')
      await run(process.execPath, ['scripts/compat-pins.mjs', '0.20.0', '--pin-commit'], temp)
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: temp, encoding: 'utf8' }).trim()
      expect(JSON.parse(await read('scripts/compat-pins.json')).at(-1)).toEqual({ tag: 'v0.20.0', commit })
      expect(() => validatePinCommit({ tag: 'v0.20.0', commit }, '0.20.0', tagCommit)).not.toThrow()
      expect(() => validatePinCommit({ tag: 'v0.20.0', commit }, '0.20.0', 'f'.repeat(40))).toThrow('moved')
      const frozen = await read('scripts/compat-pins.json')
      await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-m', 'moved'], temp)
      await run('git', ['tag', '-f', 'v0.20.0'], temp)
      await expect(run(process.execPath, ['scripts/compat-pins.mjs', '0.20.0', '--pin-commit'], temp)).rejects.toThrow('moved')
      expect(await read('scripts/compat-pins.json')).toBe(frozen)
    } finally { await fs.rm(temp, { recursive: true, force: true }) }
  })
})

describe('compatibility process harness without sockets', () => {
  it('permits only the exact untagged candidate and never masks other fetch errors', () => {
    const missing = new Error("fatal: couldn't find remote ref refs/tags/v0.18.0")
    expect(pendingCandidate({ tag: 'v0.18.0' }, '0.18.0', missing)).toBe(true)
    expect(pendingCandidate({ tag: 'v0.17.32' }, '0.18.0', missing)).toBe(false)
    expect(pendingCandidate({ tag: 'v0.18.0', commit: 'a'.repeat(40) }, '0.18.0', missing)).toBe(false)
    expect(pendingCandidate({ tag: 'v0.18.0' }, '0.18.0', new Error('authentication failed'))).toBe(false)
  })
  it('plans every old/new transport direction per pin', () => {
    const plan = pairPlan(initial)
    expect(plan).toHaveLength(10)
    expect(plan.filter(pair => pair.tag === 'v0.17.0')).toEqual([
      { tag: 'v0.17.0', transport: 'server', authority: 'old', client: 'new' },
      { tag: 'v0.17.0', transport: 'server', authority: 'new', client: 'old' },
      { tag: 'v0.17.0', transport: 'relay', authority: 'old', client: 'new' },
      { tag: 'v0.17.0', transport: 'relay', authority: 'new', client: 'old' },
      { tag: 'v0.17.0', transport: 'daemon', authority: 'new', client: 'old' },
    ])
  })
  it('skips only the old-authority pairs of a release that cannot start on this platform, with the reason', () => {
    const pins = [{ tag: 'v0.17.0', commit: 'a'.repeat(40), unsupported: { win32: 'no Windows server before 0.17.16' } }, { tag: 'v0.17.32', commit: 'b'.repeat(40) }]
    const win = pairPlan(pins, 'win32')
    expect(win.filter(pair => pair.skip)).toEqual([
      { tag: 'v0.17.0', transport: 'server', authority: 'old', client: 'new', skip: 'no Windows server before 0.17.16' },
      { tag: 'v0.17.0', transport: 'relay', authority: 'old', client: 'new', skip: 'no Windows server before 0.17.16' },
    ])
    expect(win.filter(pair => pair.tag === 'v0.17.0' && pair.authority === 'new').every(pair => !pair.skip)).toBe(true)
    expect(pairPlan(pins, 'linux').some(pair => pair.skip)).toBe(false)
    expect(selectPairs(pins, 'v0.17.0:server', 'win32').map(pair => !!pair.skip)).toEqual([true, false])
    expect(() => validatePins([{ tag: 'v0.17.0', unsupported: { beos: 'x' } }])).toThrow('invalid unsupported entry')
    expect(() => validatePins([{ tag: 'v0.17.0', unsupported: { win32: '' } }])).toThrow('invalid unsupported entry')
  })
  it('filters a single tag or transport while retaining both old/new directions', () => {
    expect(selectPairs(initial, 'v0.17.32:relay')).toEqual(pairPlan(initial).filter(pair => pair.tag === 'v0.17.32' && pair.transport === 'relay'))
    expect(selectPairs(initial, 'candidate:server')).toEqual([{ tag: 'candidate', transport: 'server', authority: 'new', client: 'new' }])
    expect(selectPairs(initial, 'candidate')).toHaveLength(3)
    expect(selectPairs(initial, 'candidate:daemon')).toEqual([{ tag: 'candidate', transport: 'daemon', authority: 'new', client: 'new' }])
    expect(selectPairs(initial, 'v0.17.0:daemon')).toEqual([{ tag: 'v0.17.0', transport: 'daemon', authority: 'new', client: 'old' }])
    for (const invalid of ['v0.18.0', 'candidate:udp', 'candidate:server:extra', 'candidate:']) expect(() => selectPairs(initial, invalid)).toThrow('invalid --only')
  })
  it('uses a process identity the local relay accepts as a live holder', () => {
    const holder = fixtureHolder(processes, 'fixture')
    expect(holder.pid).toBe(process.pid)
    expect(holderDeadCheck()(holder)).toBe(false)
    const observed = processes.probeProcessNow(process.pid)!
    expect(holder.executable).toBe(observed.executable ?? '')
    // The previous synthetic executable path is not the relay's process marker.
    if (observed.executable && observed.executable !== process.execPath) {
      expect(holderDeadCheck()({ ...holder, executable: process.execPath })).toBe(true)
    }
  })
  it('explains five relay starting refusals before holder liveness is ever checked', async () => {
    let mono = 0, incarnation: number | undefined, probes = 0
    const doc = new RoomDoc()
    const hub = await startHub({ doc, mono: () => mono, wall: () => 1_000_000 + mono, log() {},
      store: serializedStore({ read: async () => incarnation, write: async value => { incarnation = value } }),
      holderDead: () => { probes++; return false },
    })
    const conn = {}, principal = { local: true } as const
    try {
      expect(hub.handle(conn, { v: 1, id: 'hello', op: 'hello', proto: 1, schema: 2, client: 'fixture', sessionId: 'fixture' }, principal)).toMatchObject({ ok: true })
      const acquire = { v: 1, id: 'acquire', op: 'acquire', name: 'compat', holder: fixtureHolder(processes, 'fixture') }
      let refusals = 0
      for (; mono < SETTLE_MS; mono += STARTING_RETRY_MS) {
        expect(hub.handle(conn, acquire, principal)).toMatchObject({ ok: false, reason: 'starting', retryMs: STARTING_RETRY_MS })
        refusals++
      }
      expect(refusals).toBe(5)
      expect(probes).toBe(0)
      expect(hub.handle(conn, acquire, principal)).toMatchObject({ ok: true })
      expect(probes).toBe(0)
    } finally { hub.stop(); doc.doc.destroy() }
  })
  it('bounds acquire retries to starting replies within the advertised settle window', () => {
    const request = (id: string) => ({ connection: 1, direction: 'out', type: 7, op: 'acquire', id })
    const starting = (re: string) => ({ connection: 1, direction: 'in', type: 7, re, ok: false, reason: 'starting', retryMs: STARTING_RETRY_MS })
    const success = { connection: 1, direction: 'in', type: 7, re: 'ok', ok: true }
    const trace = Array.from({ length: 5 }, (_, i) => [request(String(i)), starting(String(i))]).flat()
    trace.push(request('ok'), success)
    expect(validateAcquireTrace(trace, SETTLE_MS, STARTING_RETRY_MS)).toEqual({ attempts: 6, startingRefusals: 5, retryWaitBudgetMs: SETTLE_MS })
    expect(validateAcquireTrace([request('ok'), success], SETTLE_MS, STARTING_RETRY_MS).attempts).toBe(1)
    expect(() => validateAcquireTrace([request('extra'), starting('extra'), ...trace], SETTLE_MS, STARTING_RETRY_MS)).toThrow('settle budget')
    for (const patch of [{ reason: 'stale' }, { reason: 'held' }, { retryMs: 1 }]) {
      expect(() => validateAcquireTrace([request('bad'), { ...starting('bad'), ...patch }, request('ok'), success], SETTLE_MS, STARTING_RETRY_MS)).toThrow('startup settling')
    }
  })
  it('traces bootstrap replies consumed by the gated socket before application delivery', () => {
    const received: unknown[] = [], delivered: unknown[] = []
    class GatedSocket extends EventEmitter {
      override emit(event: string, ...args: unknown[]): boolean {
        if (event === 'message' && args[0] === 'bootstrap-ack') return true
        return super.emit(event, ...args)
      }
    }
    observeSocketMessages(GatedSocket, data => received.push(data))
    const socket = new GatedSocket()
    socket.on('message', data => delivered.push(data))
    socket.emit('message', 'bootstrap-ack')
    socket.emit('message', 'sync')
    expect(received).toEqual(['bootstrap-ack', 'sync'])
    expect(delivered).toEqual(['sync'])
  })
  it('--list needs no fetch, builds or loopback listeners', async () => {
    const output = await run(process.execPath, ['--import', 'tsx', 'scripts/compat-matrix.mts', '--list'], root)
    const pins = JSON.parse(await fs.readFile(path.join(root, 'scripts/compat-pins.json'), 'utf8'))
    for (const pin of pins) expect(output).toContain(pin.tag)
    expect(output).toContain('server')
    expect(output).toContain('relay')
    expect(output).not.toContain('PASS')
    const filtered = await run(process.execPath, ['--import', 'tsx', 'scripts/compat-matrix.mts', '--list', '--only', 'candidate:relay'], root)
    expect(filtered).toContain('candidate')
    expect(filtered).toContain('relay')
    expect(filtered).not.toContain('server')
  })
  it('the real CLI refuses an unfrozen existing candidate tag before builds, even with --only', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'compat-unfrozen-'))
    try {
      for (const file of ['scripts/compat-matrix.mts', 'scripts/compat-process.mts', 'scripts/compat-pins.mjs', 'plugins/room/.claude-plugin/plugin.json']) {
        await fs.mkdir(path.dirname(path.join(temp, file)), { recursive: true })
        await fs.copyFile(path.join(root, file), path.join(temp, file))
      }
      await fs.writeFile(path.join(temp, 'plugins/room/.claude-plugin/plugin.json'), JSON.stringify({ version: '0.20.0' }))
      await fs.writeFile(path.join(temp, 'scripts/compat-pins.json'), JSON.stringify([{ tag: 'v0.20.0' }]))
      await run('git', ['init'], temp)
      await run('git', ['add', '.'], temp)
      await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'fixture'], temp)
      const cli = ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), 'scripts/compat-matrix.mts']
      // No tag: exactly the manifest candidate can be planned without sockets.
      await expect(run(process.execPath, [...cli, '--list'], temp)).resolves.toContain('v0.20.0')
      await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'tag', '-a', 'v0.20.0', '-m', 'release'], temp)
      for (const flags of [['--list'], ['--only', 'candidate:relay']]) {
        await expect(run(process.execPath, [...cli, ...flags], temp)).rejects.toThrow('node scripts/compat-pins.mjs 0.20.0 --pin-commit')
      }
      await run(process.execPath, ['scripts/compat-pins.mjs', '0.20.0', '--pin-commit'], temp)
      await expect(run(process.execPath, [...cli, '--list'], temp)).resolves.toContain('v0.20.0')
    } finally { await fs.rm(temp, { recursive: true, force: true }) }
  })
  it('bounds failed commands, timeouts and output', async () => {
    await expect(run(process.execPath, ['-e', 'process.exit(7)'], root)).rejects.toThrow('exited 7')
    await expect(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], root, 150)).rejects.toThrow('timed out')
    await expect(run(process.execPath, ['-e', "process.stdout.write('x'.repeat(2*1024*1024));setInterval(()=>{},1000)"], root)).rejects.toThrow('output limit')
  })
  it('kills grandchildren when a command times out', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'compat-kill-'))
    const marker = path.join(temp, 'leaked')
    try {
      const grandchild = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'leaked'),700)`
      const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});setInterval(()=>{},1000)`
      await expect(run(process.execPath, ['-e', parent], root, 200)).rejects.toThrow('timed out')
      await new Promise(resolve => setTimeout(resolve, 800))
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await fs.rm(temp, { recursive: true, force: true }) }
  })
})

describe('compatibility descriptor preflight without sockets', () => {
  async function fixture(legacy = false) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compat-descriptor-'))
    await fs.mkdir(path.join(dir, 'plugins/room/server'), { recursive: true })
    await fs.mkdir(path.join(dir, 'plugins/room/.claude-plugin'), { recursive: true })
    await fs.writeFile(path.join(dir, 'plugins/room/.claude-plugin/plugin.json'), JSON.stringify({ version: '0.17.32' }))
    await fs.writeFile(path.join(dir, 'plugins/room/server/room-mcp.mjs'), 'fixture bundle')
    await fs.writeFile(path.join(dir, '.compat-exports.bundle.mjs'), `export const contracts = ${JSON.stringify(legacy ? {} : { CURRENT_COMPAT })}; export const workerRecords = ${JSON.stringify(legacy ? {} : { WORKER_RECORD_SCHEMA })}`)
    const descriptor = { v: 1, release: '0.17.32', compat: CURRENT_COMPAT, workerRecordSchema: WORKER_RECORD_SCHEMA, bundleSha256: createHash('sha256').update('fixture bundle').digest('hex') }
    const write = (value: unknown) => fs.writeFile(path.join(dir, 'plugins/room/server/compat.json'), JSON.stringify(value))
    return { dir, descriptor, write }
  }
  it('accepts the matching descriptor and rejects corrupt JSON and structure', async () => {
    const { dir, descriptor, write } = await fixture()
    try {
      await write(descriptor)
      await expect(validateDescriptor(dir)).resolves.toBeUndefined()
      await fs.writeFile(path.join(dir, 'plugins/room/server/compat.json'), '{broken')
      await expect(validateDescriptor(dir)).rejects.toThrow('corrupt compat.json')
      for (const invalid of [null, [], { ...descriptor, v: 2 }]) {
        await write(invalid)
        await expect(validateDescriptor(dir)).rejects.toThrow('corrupt compat.json')
      }
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
  it.each([
    ['release', { release: '0.18.0' }, 'release mismatch'],
    ['bundle digest', { bundleSha256: 'a'.repeat(64) }, 'bundle digest mismatch'],
    ['advertisement', { compat: { ...CURRENT_COMPAT, hub: { min: 99, max: 99 } } }, 'advertisement mismatch'],
    ['worker-record schema', { workerRecordSchema: WORKER_RECORD_SCHEMA + 1 }, 'worker-record schema mismatch'],
  ])('refuses a mismatched %s before any process pair is started', async (_field, patch, message) => {
    const { dir, descriptor, write } = await fixture()
    try {
      await write({ ...descriptor, ...patch })
      await expect(validateDescriptor(dir)).rejects.toThrow(message)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
  it('permits absence only for a pinned pre-descriptor legacy implementation', async () => {
    const legacy = await fixture(true)
    const current = await fixture()
    try {
      await expect(validateDescriptor(legacy.dir, initial[1])).resolves.toBeUndefined()
      await expect(validateDescriptor(legacy.dir)).rejects.toThrow('missing or unreadable compat.json')
      await expect(validateDescriptor(legacy.dir, { tag: 'v0.17.32' })).rejects.toThrow('missing or unreadable compat.json')
      await expect(validateDescriptor(legacy.dir, { tag: 'v0.18.0', commit: 'a'.repeat(40) })).rejects.toThrow('missing or unreadable compat.json')
      await expect(validateDescriptor(current.dir, initial[1])).rejects.toThrow('missing or unreadable compat.json')
    } finally { await fs.rm(legacy.dir, { recursive: true, force: true }); await fs.rm(current.dir, { recursive: true, force: true }) }
  })
})
