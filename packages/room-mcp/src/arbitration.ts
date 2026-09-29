/**
 * The hooks' arbitration endpoint (ledger "Before-edit and SessionStart hooks"): a loopback server in this
 * MCP, found through `room/sessions/<sid>/mcp.json` ({port, key, pid, startTime}, mode 0600), the relay's
 * pattern. A hook asks `select`, prints what it got, and confirms after its stdout write; only then does
 * the ledger record `via: 'hook'` receipts. A hook that never confirms lets the batch's lease expire.
 * Frames are one JSON object per line.
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { writeAtomic } from './leases.js'
import { probeProcess } from './worker-process.js'
import type { SessionBinding } from './binding.js'
import { HOOK_LEASE_MS, type Batch, type Ledger } from './ledger.js'
import type { HookItem } from './tools/index.js'

export type SelectReply =
  | { ok: true; batch: string; items: HookItem[]; notices: string[]; more: number; leaseMs: number }
  | { ok: false; reason: 'key' | 'foreign' | 'unbound' | 'invalid' }

export interface ArbitrationOptions {
  binding: SessionBinding
  ledger: Ledger
  /** What the joined rooms owe now, reserved in a hook batch within the hook's character budget. */
  select(): { batch: Batch; items: HookItem[]; notices: string[]; more: number }
  /** A verified select from this bound host session counts as presence activity. */
  onContact?: () => void
  /** False while a host-session rebind has not acquired its new name lease. */
  canSelect?: () => boolean
  log?: (line: string) => void
  /** How often to look for a new binding (a SessionStart after /clear); default 2 s. */
  rebindMs?: number
  /** The hook lease the ledger applies, reported to the hook. */
  hookLeaseMs?: number
}

export interface Arbitration { readonly port: number; close(): Promise<void> }

export async function startArbitration(o: ArbitrationOptions): Promise<Arbitration> {
  const key = randomBytes(24).toString('hex')
  const batches = new Map<string, { batch: Batch; sessionId: string }>()
  const handle = (req: Record<string, unknown>): object => {
    if (req.key !== key) return { ok: false, reason: 'key' }
    if (req.op === 'confirm') {
      const pending = typeof req.batch === 'string' ? batches.get(req.batch) : undefined
      if (pending) {
        batches.delete(pending.batch.id)
        if (o.binding.bound()?.id === pending.sessionId && o.canSelect?.() !== false) { o.ledger.commit(pending.batch); return { ok: true } }
        o.ledger.release(pending.batch)
      }
      return { ok: false }
    }
    if ((req.op !== 'select' && req.op !== 'ping') || typeof req.sessionId !== 'string') return { ok: false, reason: 'invalid' }
    const bound = o.binding.bound()
    if (!bound) return { ok: false, reason: 'unbound' }
    if (bound.id !== req.sessionId) return { ok: false, reason: 'foreign' }
    if (o.canSelect?.() === false) return { ok: false, reason: 'unbound' }
    // A hook that must not select (one inside a subagent) asks only whether this session's MCP is up.
    if (req.op === 'ping') return { ok: true }
    o.onContact?.()
    const { batch, items, notices, more } = o.select()
    if (!items.length && !notices.length) { o.ledger.release(batch); return { ok: true, batch: batch.id, items, notices, more, leaseMs: 0 } }
    batches.set(batch.id, { batch, sessionId: bound.id })
    // A lease that ends first releases the batch; a late confirm still records a real handoff.
    const forget = setTimeout(() => batches.delete(batch.id), 60_000)
    forget.unref?.()
    return { ok: true, batch: batch.id, items, notices, more, leaseMs: o.hookLeaseMs ?? HOOK_LEASE_MS }
  }
  const server = net.createServer(socket => {
    socket.setEncoding('utf8')
    let buffered = ''
    socket.on('data', chunk => {
      buffered += chunk
      if (buffered.length > 64 * 1024) { socket.destroy(); return }
      for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
        const line = buffered.slice(0, nl)
        buffered = buffered.slice(nl + 1)
        let reply: object
        try { reply = handle(JSON.parse(line) as Record<string, unknown>) }
        catch (e) { o.log?.(`arbitration: ${e instanceof Error ? e.message : String(e)}`); reply = { ok: false, reason: 'invalid' } }
        socket.write(JSON.stringify(reply) + '\n')
      }
    })
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  const port = (server.address() as net.AddressInfo).port
  const self = probeProcess(process.pid)
  let written: string | undefined
  const publish = () => {
    const dir = o.binding.dir()
    if (dir === (written && path.dirname(written))) return
    if (written) removeOwn(written, key)
    written = undefined
    if (!dir) return
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const file = path.join(dir, 'mcp.json')
      writeAtomic(file, { port, key, pid: process.pid, startTime: self?.startTime ?? '' })
      fs.chmodSync(file, 0o600)
      written = file
    } catch (e) { o.log?.(`arbitration: could not publish its endpoint: ${e instanceof Error ? e.message : String(e)}`) }
  }
  publish()
  const timer = setInterval(publish, o.rebindMs ?? 2_000)
  timer.unref?.()
  server.unref()
  return {
    port,
    async close() {
      clearInterval(timer)
      if (written) removeOwn(written, key)
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/** Remove the endpoint file only while it is still this process's. */
function removeOwn(file: string, key: string): void {
  try { if (JSON.parse(fs.readFileSync(file, 'utf8')).key === key) fs.rmSync(file, { force: true }) } catch { /* gone already */ }
}
