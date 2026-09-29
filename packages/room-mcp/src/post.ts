/**
 * The one way a session posts (hub §11, ledger "Deterministic ids"): a `post` request through the room's
 * hub, the sole appender of `bus`. The id is the caller's, known before the hub answers, so reply and
 * copy chains can name it. Nothing is queued: an unreachable hub is a refusal the caller reports (hub §7).
 */
import { newId, outgoing, type Identity, type Msg, type PostBody, type ReleasePoster, type RoomDoc } from '@room/shared'
import type { PostIn, Reason } from '@room/hub-core'
import { HubError, NameLeaseUnavailable, type HubClient } from './hub-client.js'

export const NOT_SENT = 'not sent: hub unreachable'

export interface PostOpts {
  /** A deterministic id (a retry adds nothing); default a fresh `m_` id. */
  id?: string
  /** An automatic post (conflict, pushed, completion, copy, relay, idle-claims notice): never refused over a cap. */
  auto?: boolean
}
export type PostResult<T extends Msg = Msg> =
  | { ok: true; msg: T; seq?: number; duplicate?: boolean }
  | { ok: false; msg: T; reason: Reason | 'unreachable'; text: string }
/** The result, with the message id readable before the hub answers. */
export type Posting<T extends Msg = Msg> = Promise<PostResult<T>> & { readonly id: string }
export type Post = <T extends Msg>(from: Identity, body: PostBody<T>, opts?: PostOpts) => Posting<T>

/** Refusals whose text the hub wrote for the sender (hub §2.4); anything else means the hub was not reached. */
const TOLD: ReadonlySet<string> = new Set<Reason>(['too-large', 'over-cap', 'room-full', 'read-only', 'version'])

const greetings = new WeakMap<HubClient, Promise<unknown>>()

/** Say hello on a new connection (the client repeats it on every reconnect). */
export function greet(hub: HubClient): void { greetings.set(hub, hub.hello().catch(() => {})) }

/** The first hello's outcome: until it is known, a reply cannot say whether coordination is paused. */
export async function greeted(hub: HubClient): Promise<void> { await greetings.get(hub) }

/**
 * A worker's completion or failure message, posted as that worker under its deterministic id (registry §7).
 * A refusal throws, so the caller records `posted` only for a message the hub took.
 */
export async function postWorkerMessage(post: Post, record: { name: string; tag: string; lead: { participant: string } }, message: { id: string; body: PostBody }): Promise<void> {
  const posted = await post({ name: record.name, kind: 'agent', owner: record.lead.participant, label: record.tag }, message.body, { id: message.id, auto: true })
  if (!posted.ok) throw new Error(posted.text)
}

/** Release notices of a cleared participant are automatic posts: sent, never refused, not awaited. */
export function releasePoster(post: Post): ReleasePoster {
  return (from, body) => { void post(from, body, { auto: true }) }
}

/** The poster's own name lease, which every post carries (hub §2.3); undefined while it has none (paused, hub §7). */
export type PostLease = { name: string; epoch: number }
export type LeaseSource = () => PostLease | undefined | Promise<PostLease | undefined>

export function createPost(room: RoomDoc, hub: HubClient, lease: LeaseSource, paused?: () => string | undefined): Post {
  return <T extends Msg>(from: Identity, body: PostBody<T>, opts: PostOpts = {}): Posting<T> => {
    const id = opts.id ?? newId('m_')
    const sent = { ...outgoing<T>(from, body, id), at: Date.now() } as T
    const result = (async (): Promise<PostResult<T>> => {
      try {
        // A hello missed on reconnect is repaired here rather than reported as an outage.
        if (hub.paused()) await hub.hello().catch(() => {})
        const held = await lease()
        if (!held) {
          const namePause = paused?.()?.replace(/^\[room\]\s*/, '')
          const nameHeld = hub.reachable() && !!namePause && /another session now holds|name lease|superseded|host session changed/.test(namePause)
          return { ok: false, msg: sent, reason: nameHeld ? 'stale' : 'unreachable', text: nameHeld ? `not sent: ${namePause}` : NOT_SENT }
        }
        const reply = await hub.post(outgoing(from, body, id) as unknown as PostIn, { lease: held, ...(opts.auto ? { auto: true } : {}) })
        const seq = typeof reply.seq === 'number' ? reply.seq : undefined
        const at = typeof reply.at === 'number' ? reply.at : sent.at
        const msg = (room.message(id) as T | undefined) ?? { ...sent, at, ...(seq === undefined ? {} : { seq }) }
        return { ok: true, msg, ...(seq === undefined ? {} : { seq }), ...(reply.duplicate ? { duplicate: true } : {}) }
      } catch (error) {
        if (error instanceof NameLeaseUnavailable) return { ok: false, msg: sent, reason: 'stale', text: error.message }
        if (error instanceof HubError && TOLD.has(error.reason)) return { ok: false, msg: sent, reason: error.reason as Reason, text: error.message }
        return { ok: false, msg: sent, reason: 'unreachable', text: NOT_SENT }
      }
    })()
    return Object.assign(result, { id })
  }
}
