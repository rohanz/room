/**
 * Seed a room over y-websocket with two files and one claim, for manual smoke tests.
 * Usage: npx tsx packages/web/scripts/seed.ts [ws://localhost:1234/demo] [--keep]
 */
import WebSocket from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { RoomDoc, colorFor, type ClaimMsg, type NoteMsg } from '@room/shared'

const raw = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'ws://localhost:1234/demo'
const keep = process.argv.includes('--keep')
const u = new URL(raw)
const doc = new Y.Doc()
const room = new RoomDoc(doc)
const provider = new WebsocketProvider(`${u.protocol}//${u.host}`, u.pathname.replace(/^\/+/, '') || 'demo', doc, { WebSocketPolyfill: WebSocket as any })

provider.once('sync', () => {
  room.setMeta({ repo: 'demo-shop', branch: 'room/demo', base: 'a1b2c3d4e5f6a7b8', createdAt: Date.now(), seededBy: 'seed' })
  room.setFile('shop/handlers.py', [
    'from shop.models import Order',
    '',
    '',
    'def create_order(payload: dict) -> Order:',
    '    if not payload.get("items"):',
    '        raise ValueError("no items")',
    '    if payload.get("total", 0) <= 0:',
    '        raise ValueError("bad total")',
    '    order = Order(**payload)',
    '    order.save()',
    '    return order',
    '',
  ].join('\n'))
  room.setFile('tests/test_handlers.py', [
    'from shop.handlers import create_order',
    '',
    '',
    'def test_create_order_rejects_empty():',
    '    try:',
    '        create_order({"items": []})',
    '    except ValueError:',
    '        pass',
    '',
  ].join('\n'))
  if (!room.openClaims().length) {
    const c = room.addClaim({ path: 'shop/handlers.py', from: 5, to: 8, by: 'Kieran', byKind: 'agent', intent: 'refactoring validation into a helper' })
    room.post<ClaimMsg>({ name: 'Kieran', kind: 'agent' }, { type: 'claim', claimId: c.id, path: c.path, from_line: c.from, to_line: c.to, intent: c.intent })
  }
  room.post<NoteMsg>({ name: 'Kieran', kind: 'human' }, { type: 'note', text: 'seeded the demo room' })
  room.say('Rohan', { role: 'status', text: 'agent idle' })
  console.log('seeded', room.paths(), room.openClaims().length, 'claim(s)')
  if (keep) { console.log('holding connection open (--keep); ctrl-c to exit') }
  else setTimeout(() => { provider.destroy(); process.exit(0) }, 300)
})
provider.awareness.setLocalState({ user: { name: 'Kieran', kind: 'agent', color: colorFor('Kieran') }, status: 'editing handlers.py 5–8', cursor: { path: 'shop/handlers.py', from: 5, to: 8 } })
