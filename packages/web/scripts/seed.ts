/**
 * Seed a room with v2 overlays, scopes, claims and feed entries for a manual smoke test.
 * Usage: npx tsx packages/web/scripts/seed.ts [ws://localhost:1234/demo] [--keep]
 */
import { authorizedWebSocket } from '../../roomd/src/ws-auth.js'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { RoomDoc, colorFor, type ChangedMsg, type ClaimMsg, type ScopeMsg } from '@room/shared'

const raw = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'ws://localhost:1234/demo'
const keep = process.argv.includes('--keep')
const url = new URL(raw)
const slash = url.pathname.lastIndexOf('/')
const encodedRoomName = url.pathname.slice(slash + 1) || 'demo'
url.pathname = url.pathname.slice(0, slash) || '/'
url.search = ''
const serverUrl = url.toString().replace(/\/$/, '')
const doc = new Y.Doc()
const room = new RoomDoc(doc)
const provider = new WebsocketProvider(serverUrl, encodedRoomName, doc, { WebSocketPolyfill: authorizedWebSocket({ session: process.env.ROOM_SESSION, token: process.env.ROOM_TOKEN, key: process.env.ROOM_LOCAL_KEY }) as never, params: { schema: '2' } })

provider.once('sync', () => {
  const now = Date.now()
  room.setMeta({ repo: 'demo/shop', createdAt: now, seededBy: 'seed' })
  room.setOverlay('Kieran', 'shop/handlers.py', [
    'def checkout(cart):',
    '    total = sum(item.price for item in cart)',
    '    return {"total": total}',
    '',
  ].join('\n'))
  room.setOverlay('Rohan', 'shop/models.ts', 'export interface Cart {\n  items: Item[]\n}\n')
  room.setScope({ by: 'Kieran', byKind: 'agent', area: 'checkout', summary: 'validate checkout totals', paths: ['shop/handlers.py'], at: now })
  room.setScope({ by: 'Rohan', byKind: 'human', area: 'models', summary: 'tighten cart types', paths: ['shop/models.ts'], at: now })
  room.post<ScopeMsg>({ name: 'Kieran', kind: 'agent' }, { type: 'scope', area: 'checkout', summary: 'validate checkout totals', paths: ['shop/handlers.py'] })
  const claim = room.addClaim({ path: 'shop/handlers.py', from: 1, to: 3, by: 'Kieran', byKind: 'agent', intent: 'handle empty carts', plans: [{ kind: 'signature', symbol: 'checkout', detail: 'accept readonly cart' }] })
  room.post<ClaimMsg>({ name: 'Kieran', kind: 'agent' }, { type: 'claim', claimId: claim.id, path: claim.path, from_line: claim.from, to_line: claim.to, intent: claim.intent, plans: claim.plans })
  room.post<ChangedMsg>({ name: 'Rohan', kind: 'human' }, { type: 'changed', paths: ['shop/models.ts'], summary: 'added Cart shape', symbols: ['Cart'] })
  provider.awareness.setLocalState({
    user: { name: 'Kieran', kind: 'agent', color: colorFor('Kieran') },
    status: 'working',
    lastActive: now,
  })

  console.log(`Seeded ${raw}. Open http://localhost:5173/?room=${encodeURIComponent(raw)}`)
  if (!keep) setTimeout(() => { provider.destroy(); process.exit(0) }, 750)
})
