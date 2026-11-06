import type { CheckoutReuse, Session } from './session.js'

export interface HostRebindDeps {
  joined(): Session[]
  detach(s: Session): CheckoutReuse
  drop(s: Session, reason: string): Promise<void>
  join(old: Session, reuse: CheckoutReuse | undefined, sessionId: string): Promise<Session>
  adopt(s: Session): Promise<void>
  attachSecondary(s: Session, primary: Session): void
  /** Leave a session joined after shutdown began, without adopting it. */
  dispose(s: Session): Promise<void>
  log(line: string): void
}

/**
 * Rebinds this MCP's joined sessions when the host session changes. One rebind at a time. Once closed for shutdown,
 * no rebind starts and a join that completes later is left, never adopted: an ended runtime attaches no producers.
 */
export class HostRebind {
  private running?: Promise<void>
  private closed = false
  constructor(private readonly deps: HostRebindDeps) {}
  get pending(): Promise<void> | undefined { return this.running }

  rebind(sessionId: string): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.running) return this.running
    const joined = this.deps.joined()
    const primary = joined[0]
    if (!primary || primary.lease?.sessionId === sessionId) return Promise.resolve()
    const running = this.run(joined, primary, sessionId).finally(() => { if (this.running === running) this.running = undefined })
    this.running = running
    return running
  }

  /** Shutdown: fence new rebinds and late adoption; `wait` also waits for one in flight. */
  async close(wait: boolean): Promise<void> {
    this.closed = true
    if (wait) await this.running?.catch(() => {})
  }

  private async run(joined: Session[], primary: Session, sessionId: string): Promise<void> {
    const { deps } = this
    deps.log(`host session changed from ${primary.lease?.sessionId ?? '?'} to ${sessionId}; rebinding room leases`)
    const reuse = new Map(joined.map(old => [old, deps.detach(old)]))
    try {
      for (const old of [...joined].reverse()) await deps.drop(old, 'host session rebound')
      if (this.closed) return
      const fresh = await deps.join(primary, reuse.get(primary), sessionId)
      if (this.closed) { await deps.dispose(fresh); return }
      await deps.adopt(fresh)
      for (const old of joined.slice(1)) {
        if (this.closed) return
        const secondary = await deps.join(old, reuse.get(old), sessionId)
        if (this.closed) { await deps.dispose(secondary); return }
        deps.attachSecondary(secondary, fresh)
      }
    } finally { await Promise.all([...reuse.values()].map(value => value.watcher?.dispose())) }
  }
}
