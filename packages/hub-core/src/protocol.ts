/**
 * The hub protocol (docs/superpowers/specs/2026-09-28-hub.md §2): JSON frames on the room's websocket,
 * as y-websocket message type 7, `[varUint 7][varString json]`.
 */
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { MsgType } from '@room/shared'

/** The y-websocket message type of a hub frame (0–3 are y-websocket's own). */
export const MSG_HUB = 7
export const HUB_PROTO = 1
/** Every hub write is `doc.transact(fn, HUB_ORIGIN)`. */
export const HUB_ORIGIN = Symbol('room-hub')

/** Lease TTL and renew cadence (§4.2). */
export const LEASE_TTL_MS = 45_000
export const LEASE_RENEW_MS = 15_000
/** After an incarnation starts: acquires wait, synced holders and older-incarnation renews are adopted (§4.4). */
export const SETTLE_MS = 5_000
/** How long `starting` asks a client to wait before retrying. */
export const STARTING_RETRY_MS = 1_000
/** A client's timeout for one request; the outcome is then unknown (§2.2). */
export const REQUEST_TIMEOUT_LOCAL_MS = 5_000
export const REQUEST_TIMEOUT_TEAM_MS = 10_000

export type HolderIn = { sessionId: string; pid: number; startTime: string; executable: string; workerId?: string }
/** A message as posted: the hub assigns `seq` and `at`. */
export type PostIn = { id: string; type: MsgType; from: string; to?: string; [field: string]: unknown }

export type Req = { v: 1; id: string } & (
  | { op: 'hello'; proto: number; schema: number; client: string; sessionId: string }
  | { op: 'acquire'; name: string; holder: HolderIn; supersedes?: number }
  | { op: 'renew'; name: string; epoch: number }
  | { op: 'release'; name: string; epoch: number }
  | { op: 'post'; lease: { name: string; epoch: number }; msg: PostIn; auto?: boolean })
export type Op = Req['op']

export type Reason = 'version' | 'hello-first' | 'not-authority' | 'starting' | 'held' | 'not-yours' | 'stale'
  | 'read-only' | 'too-large' | 'over-cap' | 'room-full' | 'invalid' | 'unavailable' | 'rate-limited'

export type ReplyOk = { v: 1; re: string; ok: true; [k: string]: unknown }
export type ReplyErr = { v: 1; re: string; ok: false; reason: Reason; text: string; retryMs?: number; [k: string]: unknown }
export type Reply = ReplyOk | ReplyErr

export type LeaseLostReason = 'superseded' | 'expired' | 'expired-participant' | 'not-authority'
export type Push = { v: 1; push: 'lease-lost'; name: string; epoch: number; reason: LeaseLostReason }

/** Who sent a frame: a local relay connection (it presented the clone key), or a server connection. */
export type Principal = { local: true } | { login?: string; readOnly: boolean }

export type Frame = Req | Reply | Push

export function encodeFrame(frame: Frame): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, MSG_HUB)
  encoding.writeVarString(enc, JSON.stringify(frame))
  return encoding.toUint8Array(enc)
}

/**
 * The JSON object of a hub frame. Pass the whole message, or a decoder already past the type
 * (a y-websocket message handler's). Throws when the message is not a hub frame or not JSON;
 * the shape is the receiver's to check.
 */
export function decodeFrame(input: Uint8Array | decoding.Decoder): unknown {
  let dec: decoding.Decoder
  if (input instanceof Uint8Array) {
    dec = decoding.createDecoder(input)
    const type = decoding.readVarUint(dec)
    if (type !== MSG_HUB) throw new Error(`not a hub frame: message type ${type}`)
  } else dec = input
  return JSON.parse(decoding.readVarString(dec))
}

/** Counters (§3): `I · 2^21 + n`, a safe integer for `I < 2^32`, ordered by `(I, n)`. */
export const COUNTER_BITS = 21
export const COUNTER_LIMIT = 2 ** COUNTER_BITS

export function encodeSeq(incarnation: number, n: number): number {
  if (!Number.isInteger(incarnation) || incarnation < 0 || incarnation >= 2 ** 32) throw new RangeError(`incarnation out of range: ${incarnation}`)
  if (!Number.isInteger(n) || n < 0 || n >= COUNTER_LIMIT) throw new RangeError(`counter out of range: ${n}`)
  return incarnation * COUNTER_LIMIT + n
}

/** The incarnation that issued an epoch or a seq. */
export function incarnationOf(value: number): number {
  return Math.floor(value / COUNTER_LIMIT)
}
