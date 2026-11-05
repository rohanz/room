import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CURRENT_COMPAT, LEGACY_COMPAT, parseAdvertisement, selectContract, type CompatAdvertisement } from '@room/hub-core'
import { writeAtomic } from './leases.js'

export interface ClientCompatibility { offer: CompatAdvertisement; legacy: boolean }

/** Without an advertisement, try only the fixed legacy profile; never retry a rejected advertisement. */
export function compatibilityFromHealth(health: unknown, learned = false): ClientCompatibility {
  if (health && typeof health === 'object' && 'compat' in health) {
    let offer: CompatAdvertisement
    try { offer = parseAdvertisement(health.compat) }
    catch (error) { throw new Error(`Room server advertised an invalid compatibility contract; update the server (${error instanceof Error ? error.message : String(error)})`) }
    // Discovery has no room policy; check only whether any declared writable schema can overlap.
    const results = offer.schemas.write.map(activeSchema => selectContract(CURRENT_COMPAT, offer, { activeSchema }))
    if (!results.some(r => r.ok)) {
      const refusal = results.find(r => !r.ok)
      throw new Error(refusal && !refusal.ok ? refusal.error.text : 'Room server has no supported writable schema; update the server')
    }
    return { offer, legacy: false }
  }
  if (learned) throw new Error('Room server negotiation advertisement disappeared; refusing a protocol downgrade. Restore negotiation on the server and reconnect Room (/mcp) or restart the session')
  return { offer: LEGACY_COMPAT, legacy: true }
}

export { validateSelection } from '@room/hub-core'

/** Floors use canonical authority identity, never a fallback port. Private state survives cache updates. */
export function compatibilityFloor(commonDir: string, identity: string, fingerprint?: string): { learned(): boolean; remember(): void } {
  const file = join(commonDir, 'room', 'compat', `${createHash('sha256').update(identity).digest('hex')}.json`)
  return {
    learned() {
      if (!existsSync(file)) return false
      const record = JSON.parse(readFileSync(file, 'utf8')) as { v?: number; bootstrap?: number; identity?: string; fingerprint?: string }
      if (record.v !== 1 || record.bootstrap !== 1 || record.identity !== identity || record.fingerprint !== fingerprint) throw new Error('Room compatibility floor is invalid; restore the private compatibility state before reconnecting')
      return true
    },
    remember() { writeAtomic(file, { v: 1, bootstrap: 1, identity, ...(fingerprint ? { fingerprint } : {}), at: Date.now() }) },
  }
}
