import type { SharingPolicy } from '@room/roomd'

/** A hub blip pauses the name lease and withdraws publication for seconds; restarting the graph means a full rebuild. */
const CHECKOUT_LEAD_GRACE_MS = 60_000

/**
 * The one answer to "does this session lead its checkout": it holds the checkout's publisher lease (registry §16).
 * session.ts gives that role up while the name lease is paused and takes it back once the lease is granted again,
 * and roomd runs its checkout watcher on the same flag. Without a policy (partial unit fixtures) a session is alone.
 */
export function leadsCheckout(policy: SharingPolicy | undefined): boolean { return policy?.publisher ?? true }

export interface LeadSource {
  readonly policy: SharingPolicy
  watch(listener: (policy: SharingPolicy) => void): () => void
}

export interface CheckoutWork { name: string; start(): void; stop(): void }

interface LeadOptions { graceMs?: number; log?: (line: string) => void; after?: typeof setTimeout; cancel?: typeof clearTimeout }

/**
 * Checkout-wide work (the symbol graph) runs only in the session leading the checkout: another session in the same
 * checkout, or a stale one whose name lease lapsed, would compute it again from byte-identical inputs. The conflict
 * checker is not gated: it limits itself to the session's own claims when it is not the publisher.
 * Work starts as soon as the session leads, and stops after `graceMs` without the role.
 */
export class CheckoutLead {
  private readonly works = new Set<CheckoutWork>()
  private running: boolean
  private pending: ReturnType<typeof setTimeout> | undefined
  private readonly unwatch: (() => void) | undefined
  private readonly graceMs: number
  private readonly after: typeof setTimeout
  private readonly cancel: typeof clearTimeout

  constructor(private readonly source: LeadSource | undefined, private readonly o: LeadOptions = {}) {
    this.graceMs = o.graceMs ?? CHECKOUT_LEAD_GRACE_MS
    this.after = o.after ?? setTimeout
    this.cancel = o.cancel ?? clearTimeout
    this.running = leadsCheckout(source?.policy)
    if (!this.running) o.log?.(`${this.publisher()} leads this checkout: its session runs the symbol graph; it starts here if this session takes over`)
    this.unwatch = typeof source?.watch === 'function' ? source.watch(policy => this.update(leadsCheckout(policy))) : undefined
  }

  /** Run `work` whenever this session leads; returns the detach, which stops it if it is running. */
  attach(work: CheckoutWork): () => void {
    this.works.add(work)
    if (this.running) work.start()
    return () => { if (this.works.delete(work) && this.running) work.stop() }
  }

  /** Detach everything (leave): running work stops, a pending stop is cancelled. */
  dispose(): void {
    this.unwatch?.()
    this.clearPending()
    for (const work of [...this.works]) { this.works.delete(work); if (this.running) work.stop() }
    this.running = false
  }

  private publisher(): string { return this.source?.policy?.publisherName ?? 'another session' }

  private clearPending(): void { if (this.pending) { this.cancel(this.pending); this.pending = undefined } }

  private update(leads: boolean): void {
    if (leads) {
      this.clearPending()
      if (this.running) return
      this.running = true
      for (const work of this.works) work.start()
      if (this.works.size) this.o.log?.(`leading this checkout: started ${[...this.works].map(w => w.name).join(', ')}`)
      return
    }
    if (!this.running || this.pending) return
    this.pending = this.after(() => {
      this.pending = undefined
      if (!this.running || leadsCheckout(this.source?.policy)) return
      this.running = false
      for (const work of this.works) work.stop()
      if (this.works.size) this.o.log?.(`${this.publisher()} leads this checkout: stopped ${[...this.works].map(w => w.name).join(', ')}`)
    }, this.graceMs)
    ;(this.pending as { unref?: () => void }).unref?.()
  }
}

const leads = new WeakMap<object, CheckoutLead>()
/** The session's single gate, keyed by its policy store (one per joined session). */
export function checkoutLead(s: { policyStore?: LeadSource }, o?: LeadOptions): CheckoutLead {
  const key = s.policyStore ?? s
  let lead = leads.get(key)
  if (!lead) { lead = new CheckoutLead(s.policyStore, o); leads.set(key, lead) }
  return lead
}
/** Leave: stop the session's checkout work and forget its gate. */
export function endCheckoutLead(s: { policyStore?: LeadSource }): void {
  const key = s.policyStore ?? s
  leads.get(key)?.dispose()
  leads.delete(key)
}
