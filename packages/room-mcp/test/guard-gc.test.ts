import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { collectLocalState } from '../src/local-state-gc.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots) fs.rmSync(root, { recursive: true, force: true }) })

it.each([
  'names/name.json.guard',
  'publishers/worktree.json.guard',
  `preview-evidence/${'a'.repeat(64)}-publication.guard`,
  'hub/authority.lock',
  'hub/authority.lock.guard',
  'registry/capacity.guard',
  'worktree-operation.guard',
  'names/name.json.guard.guard',
])('preserves dead locks and their live successors: %s', relative => {
  const common = fs.mkdtempSync(path.join(os.tmpdir(), 'review-wtlock-gc-')); roots.push(common)
  const file = path.join(common, 'room', relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const now = Date.now(), dead = { pid: 200, startTime: 'dead', executable: 'node', sessionId: 'old', nonce: 'old' }
  const live = { ...dead, pid: 100, startTime: 'live', sessionId: 'new', nonce: 'new' }
  fs.writeFileSync(file, JSON.stringify(dead))
  fs.utimesSync(file, (now - 7_200_000) / 1000, (now - 7_200_000) / 1000)
  const stat = fs.statSync.bind(fs)
  let replaced = false
  const replace = () => {
    replaced = true
    fs.unlinkSync(file)
    fs.writeFileSync(file, JSON.stringify(live), { flag: 'wx' })
  }
  vi.spyOn(fs, 'statSync').mockImplementation((...args) => {
    const result = stat(...args)
    if (String(args[0]) === file && !replaced) {
      // Model another process recovering the dead guard and acquiring its own
      // fully published token after GC's final stat but before its blind rm.
      replace()
    }
    return result
  })
  collectLocalState(common, { now: () => now, probe: pid => pid === live.pid ? live : undefined })
  // Owner-managed locks never reach the old stat/unlink seam. Assert that the
  // dead token survived, then also check collection after an owner's takeover.
  if (!replaced) {
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(dead)
    replace()
    collectLocalState(common, { now: () => now, probe: pid => pid === live.pid ? live : undefined })
  }
  expect(replaced).toBe(true)
  expect(fs.existsSync(file)).toBe(true)
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(live)
  expect(collectLocalState(common, { now: () => now, dryRun: true }).removed).toEqual([])
})

it.each(['names/name.json', 'publishers/worktree.json'])('rechecks a lease successor under its guard: %s', relative => {
  const common = fs.mkdtempSync(path.join(os.tmpdir(), 'room-lease-gc-')); roots.push(common)
  const file = path.join(common, 'room', relative), now = Date.now()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const dead = { pid: 200, startTime: 'dead', executable: 'node', sessionId: 'old', nonce: 'old' }
  const live = { ...dead, pid: 100, startTime: 'live', sessionId: 'new', nonce: 'new' }
  fs.writeFileSync(file, JSON.stringify({ holder: dead }))
  fs.utimesSync(file, (now - 7_200_000) / 1000, (now - 7_200_000) / 1000)
  const stat = fs.statSync.bind(fs)
  let replaced = false
  vi.spyOn(fs, 'statSync').mockImplementation((...args) => {
    const result = stat(...args)
    if (String(args[0]) === file && !replaced) {
      replaced = true
      fs.writeFileSync(file, JSON.stringify({ holder: live }))
    }
    return result
  })
  const result = collectLocalState(common, { now: () => now, probe: pid => pid === live.pid ? live : undefined })
  expect(replaced).toBe(true)
  expect(result.removed).not.toContain(file)
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ holder: live })
})

it.each(['names/name.json', 'publishers/worktree.json'])('rechecks idle age under the lease guard: %s', relative => {
  const common = fs.mkdtempSync(path.join(os.tmpdir(), 'room-lease-gc-')); roots.push(common)
  const file = path.join(common, 'room', relative), now = Date.now()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const dead = { pid: 200, startTime: 'dead', executable: 'node', sessionId: 'old', nonce: 'old' }
  fs.writeFileSync(file, JSON.stringify({ holder: dead }))
  fs.utimesSync(file, (now - 7_200_000) / 1000, (now - 7_200_000) / 1000)
  const stat = fs.statSync.bind(fs)
  let refreshed = false
  vi.spyOn(fs, 'statSync').mockImplementation((...args) => {
    const result = stat(...args)
    if (String(args[0]) === file && !refreshed) {
      refreshed = true
      fs.utimesSync(file, now / 1000, now / 1000)
    }
    return result
  })
  expect(collectLocalState(common, { now: () => now, probe: () => undefined }).removed).not.toContain(file)
  expect(refreshed).toBe(true)
  expect(fs.existsSync(file)).toBe(true)
})
