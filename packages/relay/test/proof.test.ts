import { describe, expect, it } from 'vitest'
import { localProofHeader, localViewKey, ProofVerifier, relayProof, sameProof, viewTicketProof } from '../src/proof.js'
import { relayOutputAllowed, stateRequestLimiter, RELAY_SOCKET_QUEUE_BYTES, RELAY_STATE_REQUESTS_PER_MINUTE, RELAY_STATE_QUEUE_BYTES, RELAY_TOTAL_QUEUE_BYTES } from '../src/index.js'

describe('local relay proof protocol', () => {
  it('binds client proofs to method, path, port and a one-use nonce', () => {
    let now = 1_800_000_000_000
    const verifier = new ProofVerifier('private', 4402, () => now)
    const proof = localProofHeader('private', 'GET', '/local%2Fr?schema=2', 4402, now, 'a'.repeat(32))
    expect(verifier.verify(proof, 'GET', '/local%2Fr?schema=2')).toBe(true)
    expect(verifier.verify(proof, 'GET', '/local%2Fr?schema=2')).toBe(false)
    expect(new ProofVerifier('private', 4403, () => now).verify(proof, 'GET', '/local%2Fr?schema=2')).toBe(false)
    expect(new ProofVerifier('private', 4402, () => now).verify(proof, 'POST', '/local%2Fr?schema=2')).toBe(false)
    now += 30_001
    expect(new ProofVerifier('private', 4402, () => now).verify(proof, 'GET', '/local%2Fr?schema=2')).toBe(false)
  })
  it('derives a room-scoped read key and relay challenge proof', () => {
    const a = localViewKey('private', 'local/a'), b = localViewKey('private', 'local/b')
    expect(a).not.toBe(b)
    expect(a).not.toContain('private')
    expect(sameProof(relayProof('private', 'nonce', 4402), relayProof('private', 'nonce', 4402))).toBe(true)
    expect(viewTicketProof(a, 'local/a', 1, 'nonce')).not.toBe(viewTicketProof(a, 'local/b', 1, 'nonce'))
  })
  it('limits repeated state requests and queued replies', () => {
    let now = 0
    const allow = stateRequestLimiter(() => now)
    const step1 = Uint8Array.of(0, 0)
    for (let n = 0; n < RELAY_STATE_REQUESTS_PER_MINUTE; n++) expect(allow(step1, 0)).toBe(true)
    expect(allow(step1, 0)).toBe(false)
    now = 60_000
    expect(allow(step1, RELAY_STATE_QUEUE_BYTES + 1)).toBe(false)
    expect(allow(Uint8Array.of(0, 2), RELAY_STATE_QUEUE_BYTES + 1)).toBe(true)
  })
  it('rejects one slow socket and aggregate queued output', () => {
    expect(relayOutputAllowed(0, 0, 100)).toBe(true)
    expect(relayOutputAllowed(RELAY_SOCKET_QUEUE_BYTES, 0, 1)).toBe(false)
    expect(relayOutputAllowed(1, RELAY_TOTAL_QUEUE_BYTES, 1)).toBe(false)
    // A single large document may exceed the per-socket budget, but never the process budget.
    expect(relayOutputAllowed(0, 0, RELAY_SOCKET_QUEUE_BYTES * 2)).toBe(true)
    expect(relayOutputAllowed(0, RELAY_TOTAL_QUEUE_BYTES, 1)).toBe(false)
    expect(relayOutputAllowed(0, RELAY_TOTAL_QUEUE_BYTES - 1, 1)).toBe(true)
    expect(relayOutputAllowed(0, 0, RELAY_TOTAL_QUEUE_BYTES + 1)).toBe(false)
    let aggregate = 0
    const documentBytes = 64 * 1024 * 1024 + 16
    let admitted = 0
    for (let n = 0; n < 12; n++) {
      if (relayOutputAllowed(0, aggregate, documentBytes)) { aggregate += documentBytes; admitted++ }
      expect(aggregate).toBeLessThanOrEqual(RELAY_TOTAL_QUEUE_BYTES)
    }
    expect(admitted).toBe(3)
    // The budgets hold at least one full document (the 64 MiB snapshot ceiling).
    expect(RELAY_SOCKET_QUEUE_BYTES).toBeGreaterThanOrEqual(64 * 1024 * 1024)
  })
})
