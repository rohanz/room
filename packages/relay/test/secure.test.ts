import { describe, expect, it } from 'vitest'
import { SecureSession } from '../src/secure.js'

function pair(key = 'secret', clientKey = key) {
  const client = new SecureSession(clientKey, 'local/a', 'client')
  const relay = new SecureSession(key, 'local/a', 'relay')
  const hello = client.clientHello(Buffer.alloc(16, 1))
  const reply = relay.relayHello(hello, Buffer.alloc(16, 2))
  return { client, relay, hello, reply }
}
describe('relay secure framing', () => {
  it('authenticates the relay in-band and encrypts both directions', () => {
    const { client, relay, reply } = pair()
    client.acceptRelayHello(reply)
    expect(relay.decrypt(client.encrypt(Buffer.from('private marker'))).toString()).toBe('private marker')
    expect(client.decrypt(relay.encrypt(Buffer.from('reply'))).toString()).toBe('reply')
  })
  it('rejects wrong keys, modified frames, replay and reordering', () => {
    const wrong = pair('secret', 'other')
    expect(() => wrong.client.acceptRelayHello(wrong.reply)).toThrow('invalid relay proof')
    for (const mode of ['modified', 'replayed', 'reordered']) {
      const { client, relay, reply } = pair()
      client.acceptRelayHello(reply)
      const first = client.encrypt(Buffer.from('one'))
      const second = client.encrypt(Buffer.from('two'))
      if (mode === 'modified') { first[0] ^= 1; expect(() => relay.decrypt(first)).toThrow() }
      if (mode === 'replayed') { relay.decrypt(first); expect(() => relay.decrypt(first)).toThrow() }
      if (mode === 'reordered') expect(() => relay.decrypt(second)).toThrow()
    }
  })
})
