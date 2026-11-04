/** Only a lead session owns a clone's local relay: workers and other non-leads never start or take it over. */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AuthorityLock, deterministicPort, ensureLocalRelay, LOCAL_FILE, NoLocalRelay, readRelayInfo, startRelay, type LocalRelay } from '../src/index.js'
import { portAnswers } from './probes.js'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async (f: () => boolean | Promise<boolean>, ms = 8000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error('timeout'); await wait(50) } }
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const commonDir = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'room-relay-owner-'))
  cleanup.push(() => fsp.rm(dir, { recursive: true, force: true }))
  return dir
}
const relay = async (common: string, opts: Parameters<typeof ensureLocalRelay>[2] = {}): Promise<LocalRelay> => {
  const r = await ensureLocalRelay(common, 'local/x', { watchMs: 50, log: () => {}, ...opts })
  cleanup.push(() => r.stop())
  return r
}

describe('relay ownership', () => {
  it("a join-only worker never owns the relay after the lead's relay dies, and joins once a lead is back", async () => {
    const common = await commonDir()
    const lead = await relay(common)
    const worker = await relay(common, { joinOnly: true })
    expect(readRelayInfo(common)?.lead).toBe(true)
    await lead.stop()
    await until(() => worker.lost !== undefined)
    expect(worker.lost).toBe("the lead's local relay for local/x is no longer running")
    await wait(300)
    expect(worker.owned).toBe(false)
    expect(await portAnswers(lead.port)).toBe(false)
    expect(readRelayInfo(common)?.pid).toBe(process.pid)
    await expect(ensureLocalRelay(common, 'local/x', { joinOnly: true, log: () => {} })).rejects.toBeInstanceOf(NoLocalRelay)
    const back = await relay(common)
    expect(back.owned).toBe(true)
    expect(back.port).toBe(deterministicPort(common))
    const rejoined = await relay(common, { joinOnly: true })
    expect(rejoined.owned).toBe(false)
    expect(rejoined.port).toBe(back.port)
  })

  it('a non-lead never starts or takes a relay over', async () => {
    const common = await commonDir()
    // A nested host in a worker's worktree, ROOM_* scrubbed: no relay running, and it must not start one.
    await expect(ensureLocalRelay(common, 'local/x', { lead: false, log: () => {} })).rejects.toBeInstanceOf(NoLocalRelay)
    expect(readRelayInfo(common)).toBeUndefined()
    expect(await portAnswers(deterministicPort(common))).toBe(false)
    const lead = await relay(common)
    const other = await relay(common, { lead: false })
    expect(other.owned).toBe(false)
    await lead.stop()
    await until(() => other.lost !== undefined)
    expect(other.owned).toBe(false)
  })

  it('a lead joining a relay of an older Room warns, and takes it over when that process exits', async () => {
    const common = await commonDir()
    const port = deterministicPort(common), key = 'k'.repeat(32)
    // An older Room's owner: no `lead` in its discovery file.
    const lock = AuthorityLock.take(common)!
    const older = await startRelay(port, { key, commonDir: common, hub: { lock } })
    cleanup.push(() => older.close())
    fs.mkdirSync(path.join(common, 'room'), { recursive: true })
    fs.writeFileSync(path.join(common, LOCAL_FILE), JSON.stringify({ schema: 2, port, pid: process.pid, room: 'local/x', startedAt: Date.now(), key }))
    const lead = await relay(common)
    expect(lead.owned).toBe(false)
    expect(lead.ownerWarning).toBe(`a session from an older Room (pid ${process.pid}) holds this room's relay on 127.0.0.1:${port}; this lead takes it over when that process exits`)
    const worker = await relay(common, { joinOnly: true })
    await older.close()
    await until(() => lead.owned)
    expect(lead.ownerWarning).toBeUndefined()
    expect(lead.port).toBe(port)
    expect(readRelayInfo(common)?.lead).toBe(true)
    expect(worker.owned).toBe(false)
  })
})
