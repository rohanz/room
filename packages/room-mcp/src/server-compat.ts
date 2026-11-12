import { CURRENT_COMPAT, parseAdvertisement, selectContract, type CompatAdvertisement } from '@room/hub-core'

/** Local clients retain replicas and delegate transport lifetime to the standalone daemon. */
export const LOCAL_CLIENT_COMPAT: CompatAdvertisement = { ...CURRENT_COMPAT, capabilities: { ...CURRENT_COMPAT.capabilities, 'room.daemon': [1] }, requiredCapabilities: { 'room.daemon': [1] } }

/** Discovery is a hint. The authenticated socket selects again before document exchange. */
export function compatibilityFromHealth(health: unknown, client: CompatAdvertisement = CURRENT_COMPAT): CompatAdvertisement {
  let offer: CompatAdvertisement
  try { offer = parseAdvertisement(health && typeof health === 'object' && 'compat' in health ? health.compat : undefined) }
  catch (error) { throw new Error(`Room server advertised an invalid compatibility contract; update the server (${error instanceof Error ? error.message : String(error)})`) }
  const results = offer.schemas.write.map(activeSchema => selectContract(client, offer, { activeSchema }))
  if (!results.some(r => r.ok)) {
    const refusal = results.find(r => !r.ok)
    throw new Error(refusal && !refusal.ok ? refusal.error.text : 'Room server has no supported writable schema; update the server')
  }
  return offer
}
