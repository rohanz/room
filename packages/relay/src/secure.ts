import crypto from 'node:crypto'

const MAGIC = Buffer.from('room-secure-v1')
const LABEL = Buffer.from('room-relay-v2\0relay\0')
const INFO_C2S = Buffer.from('room-relay-v2 c2s')
const INFO_S2C = Buffer.from('room-relay-v2 s2c')

/** Authenticated framing for one ordered WebSocket. The first encrypted client frame proves K. */
export class SecureSession {
  private cn?: Buffer
  private sn?: Buffer
  private tx?: Buffer
  private rx?: Buffer
  private sent = 0n
  private received = 0n
  constructor(private readonly key: string, private readonly room: string, private readonly role: 'client' | 'relay') {}
  get ready(): boolean { return !!this.tx }
  clientHello(nonce = crypto.randomBytes(16)): Buffer {
    if (this.role !== 'client' || this.cn || nonce.length !== 16) throw new Error('invalid client hello')
    this.cn = Buffer.from(nonce)
    return Buffer.concat([MAGIC, this.cn])
  }
  relayHello(frame: Uint8Array, nonce = crypto.randomBytes(16)): Buffer {
    if (this.role !== 'relay' || this.cn || frame.length !== MAGIC.length + 16 || nonce.length !== 16 || !Buffer.from(frame.subarray(0, MAGIC.length)).equals(MAGIC)) throw new Error('invalid relay hello')
    this.cn = Buffer.from(frame.subarray(MAGIC.length))
    this.sn = Buffer.from(nonce)
    const proof = this.proof()
    this.derive()
    return Buffer.concat([MAGIC, this.sn, proof])
  }
  acceptRelayHello(frame: Uint8Array): void {
    if (this.role !== 'client' || !this.cn || this.sn || frame.length !== MAGIC.length + 48 || !Buffer.from(frame.subarray(0, MAGIC.length)).equals(MAGIC)) throw new Error('invalid relay proof')
    this.sn = Buffer.from(frame.subarray(MAGIC.length, MAGIC.length + 16))
    if (!crypto.timingSafeEqual(Buffer.from(frame.subarray(MAGIC.length + 16)), this.proof())) throw new Error('invalid relay proof')
    this.derive()
  }
  private proof(): Buffer {
    return crypto.createHmac('sha256', this.key).update(LABEL).update(this.cn!).update(this.sn!).update(Buffer.from([0])).update(this.room).digest()
  }
  private derive(): void {
    const salt = Buffer.concat([this.cn!, this.sn!])
    const c2s = Buffer.from(crypto.hkdfSync('sha256', this.key, salt, INFO_C2S, 32))
    const s2c = Buffer.from(crypto.hkdfSync('sha256', this.key, salt, INFO_S2C, 32))
    this.tx = this.role === 'client' ? c2s : s2c
    this.rx = this.role === 'client' ? s2c : c2s
  }
  private iv(counter: bigint): Buffer { const iv = Buffer.alloc(12); iv.writeBigUInt64BE(counter, 4); return iv }
  encrypt(data: Uint8Array): Buffer {
    if (!this.tx) throw new Error('handshake incomplete')
    const cipher = crypto.createCipheriv('aes-256-gcm', this.tx, this.iv(this.sent++))
    return Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()])
  }
  decrypt(data: Uint8Array): Buffer {
    if (!this.rx || data.length < 16) throw new Error('invalid encrypted frame')
    const frame = Buffer.from(data)
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.rx, this.iv(this.received))
    decipher.setAuthTag(frame.subarray(frame.length - 16))
    const plain = Buffer.concat([decipher.update(frame.subarray(0, -16)), decipher.final()])
    this.received++
    return plain
  }
}
